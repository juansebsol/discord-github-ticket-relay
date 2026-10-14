/**
 * AI triage of filed tickets.
 *
 * Isolation from filing is the core design rule: triage only reads tickets that are already
 * filed (status `created`), keeps its own table, and never writes to the filing queue. If
 * Claude is unavailable, out of credits or misconfigured, triage pauses or retries on its
 * own and tickets keep being filed exactly as before.
 */
import type { Queryable } from '../db/database.js';
import { decryptPayload, getSubmission, addEvent } from '../domain/submissions.js';
import { getGitHubConnection } from '../domain/store.js';
import { labelColor } from '../domain/ticket-types.js';
import { UserFacingError, type Deps, type SubmissionRow } from '../domain/types.js';
import { GitHubApiError, type IssueDetail } from '../github/client.js';
import { normalizeVerdict, TriageAiError, type TriageAi, type Verdict } from './ai.js';
import { buildSystemPrompt, buildUserPrompt, extractDescription, searchTerms } from './prompt.js';
import {
  anyActionOn,
  getTriageSettings,
  monthlyUsage,
  pauseTriage,
  resolveApiKey,
  type ActionKind,
  type Flag,
  type Mode,
  type Priority,
  type TriageConfig,
} from './settings.js';

export interface TriageAction {
  kind: ActionKind;
  label: string;
  close: boolean;
  confidence: number;
  priority?: Priority;
  duplicateOf?: number;
}

export interface TriageResultRow {
  submission_id: string;
  workspace_id: string;
  status: 'pending' | 'done' | 'skipped' | 'failed';
  attempts: number;
  next_attempt_at: Date | null;
  lease_owner: string | null;
  lease_until_at: Date | null;
  model: string | null;
  verdict: Verdict | null;
  applied_actions: TriageAction[] | null;
  suggestions: TriageAction[] | null;
  priority: Priority | null;
  is_duplicate: number;
  is_spam: number;
  suggestion_count: number;
  skip_reason: string | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const LEASE_SECONDS = 180;
/** Waits between attempts after rate limits and outages (seconds); then the ticket is left untriaged. */
const RETRY_DELAYS = [60, 300, 900, 3600, 10800];
const MAX_CANDIDATES = 40;

/** Turns Claude's verdict into the actions the workspace allows, split into automatic and suggested. */
export function planActions(v: Verdict, c: TriageConfig): { auto: TriageAction[]; suggested: TriageAction[] } {
  const planned: { mode: Mode; action: TriageAction }[] = [];
  const add = (kind: Flag, confidence: number, extra: Partial<TriageAction> = {}) => {
    if (c[kind].mode !== 'off') planned.push({ mode: c[kind].mode, action: { kind, label: c[kind].label, close: c[kind].close, confidence, ...extra } });
  };
  // Confident spam or "no action needed" make the other labels pointless.
  const junk = (v.spam && v.spam_confidence >= c.threshold) || (v.no_action && v.no_action_confidence >= c.threshold);
  if (v.spam) add('spam', v.spam_confidence);
  else if (v.no_action) add('noAction', v.no_action_confidence);
  if (!junk) {
    if (v.duplicate_of !== null) add('duplicate', v.duplicate_confidence, { duplicateOf: v.duplicate_of });
    else if (v.needs_info) add('needsInfo', v.needs_info_confidence);
    if (c.priority.mode !== 'off') {
      planned.push({ mode: c.priority.mode, action: { kind: 'priority', label: c.priority.labels[v.priority], close: false, confidence: v.priority_confidence, priority: v.priority } });
    }
  }
  const auto = planned.filter((p) => p.mode === 'auto' && p.action.confidence >= c.threshold).map((p) => p.action);
  const suggested = planned.filter((p) => !(p.mode === 'auto' && p.action.confidence >= c.threshold)).map((p) => p.action);
  return { auto, suggested };
}

/** Short, human description of an action for the activity log. */
export function describeAction(a: TriageAction): string {
  const what = a.kind === 'priority' ? a.label : a.kind === 'duplicate' ? `duplicate of #${a.duplicateOf}` : a.kind === 'spam' ? 'spam' : a.kind === 'needsInfo' ? 'needs info' : 'no action needed';
  return a.close ? `${what} (closed)` : what;
}

function closeReason(a: TriageAction): string {
  switch (a.kind) {
    case 'duplicate':
      return `as a possible duplicate of #${a.duplicateOf}`;
    case 'spam':
      return 'as spam';
    case 'needsInfo':
      return 'because it needs more information';
    default:
      return 'as not needing any action';
  }
}

/** Adds the actions' labels (creating missing ones), comments where useful, and closes if asked. Fixed comment text only. */
export async function applyToGitHub(deps: Deps, sub: SubmissionRow, actions: TriageAction[]): Promise<void> {
  if (!actions.length) return;
  if (!deps.github || !sub.issue_number) throw new Error('GitHub is not configured');
  const gh = deps.github;
  const conn = await getGitHubConnection(deps.db, sub.workspace_id);
  const inst = conn?.installation_id ?? sub.installation_id;
  const { repo_owner: owner, repo_name: repo, issue_number: n } = sub;
  const labels = [...new Set(actions.map((a) => a.label))];
  const existing = new Set((await gh.listLabels(inst, owner, repo)).map((l) => l.toLowerCase()));
  for (const name of labels) if (!existing.has(name.toLowerCase())) await gh.createLabel(inst, owner, repo, name, labelColor(name));
  await gh.addLabels(inst, owner, repo, n, labels);
  const closing = actions.find((a) => a.close);
  const duplicate = actions.find((a) => a.kind === 'duplicate');
  if (closing) {
    await gh.createComment(inst, owner, repo, n, `Closed automatically by Ticket Relay triage ${closeReason(closing)}. If that’s wrong, reopen this issue.`);
    await gh.closeIssue(inst, owner, repo, n);
  } else if (duplicate) {
    await gh.createComment(inst, owner, repo, n, `Possible duplicate of #${duplicate.duplicateOf}.\n\n<sub>Flagged automatically by Ticket Relay triage.</sub>`);
  }
}

function githubMessage(err: unknown): string {
  return err instanceof GitHubApiError ? `${err.status} ${err.message}` : (err as Error)?.message ?? 'unknown error';
}

export class TriageEngine {
  constructor(
    readonly deps: Deps,
    readonly ai: TriageAi,
  ) {}

  /** Queues newly filed tickets in workspaces where triage is on (only those filed after it was switched on). */
  async enqueueNew(): Promise<number> {
    const res = await this.deps.db.query(
      `INSERT OR IGNORE INTO triage_results (submission_id, workspace_id, status, next_attempt_at)
       SELECT s.id, s.workspace_id, 'pending', now_ms() FROM submissions s
       JOIN triage_settings t ON t.workspace_id = s.workspace_id AND t.enabled = 1
       WHERE s.status = 'created' AND s.issue_number IS NOT NULL AND s.completed_at >= t.enabled_at
         AND NOT EXISTS (SELECT 1 FROM triage_results r WHERE r.submission_id = s.id)
       ORDER BY s.completed_at, s.rowid LIMIT 100`,
    );
    return res.rowCount;
  }

  /** Atomically claims one due row, skipping paused workspaces. */
  async claim(): Promise<TriageResultRow | null> {
    const { rows } = await this.deps.db.query<TriageResultRow>(
      `UPDATE triage_results SET lease_owner = $1, lease_until_at = now_ms() + ($2 * 1000), attempts = attempts + 1, updated_at = now_ms()
       WHERE submission_id = (
         SELECT r.submission_id FROM triage_results r JOIN triage_settings t ON t.workspace_id = r.workspace_id
         WHERE r.status = 'pending' AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= now_ms())
           AND (r.lease_until_at IS NULL OR r.lease_until_at < now_ms()) AND t.paused_reason IS NULL
         ORDER BY r.next_attempt_at NULLS FIRST, r.created_at, r.rowid LIMIT 1
       )
       AND status = 'pending' AND (lease_until_at IS NULL OR lease_until_at < now_ms())
       RETURNING *`,
      [this.deps.instanceId, LEASE_SECONDS],
    );
    return rows[0] ?? null;
  }

  private async finish(row: TriageResultRow, fields: Record<string, unknown>): Promise<void> {
    const entries = Object.entries({ ...fields, lease_owner: null, lease_until_at: null });
    await this.deps.db.query(
      `UPDATE triage_results SET ${entries.map(([k], i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now_ms()
       WHERE submission_id = $1 AND lease_owner = $2`,
      [row.submission_id, this.deps.instanceId, ...entries.map(([, v]) => v)],
    );
  }

  private skip(row: TriageResultRow, reason: string, extra: Record<string, unknown> = {}) {
    return this.finish(row, { status: 'skipped', skip_reason: reason, completed_at: new Date(), ...extra });
  }

  private retry(row: TriageResultRow, message: string) {
    if (row.attempts > RETRY_DELAYS.length) return this.finish(row, { status: 'failed', error: message, completed_at: new Date() });
    return this.finish(row, { status: 'pending', error: message, next_attempt_at: new Date(Date.now() + RETRY_DELAYS[row.attempts - 1]! * 1000) });
  }

  /** Puts the row back without counting the attempt; it runs again once the workspace is resumed. */
  private requeue(row: TriageResultRow) {
    return this.finish(row, { status: 'pending', attempts: Math.max(0, row.attempts - 1), next_attempt_at: null });
  }

  async process(row: TriageResultRow): Promise<void> {
    try {
      await this.run(row);
    } catch (err) {
      this.deps.log.error({ err: (err as Error).message, submission: row.submission_id }, 'triage failed unexpectedly');
      await this.retry(row, 'Unexpected error');
    }
  }

  private async run(row: TriageResultRow): Promise<void> {
    const { deps } = this;
    const settings = await getTriageSettings(deps.db, row.workspace_id);
    const c = settings.config;
    if (!settings.enabled) return this.skip(row, 'Triage was turned off');
    const sub = await getSubmission(deps.db, row.workspace_id, row.submission_id);
    if (!sub || sub.status !== 'created' || !sub.issue_number) return this.skip(row, 'The ticket is no longer filed');
    if (c.appIds && !c.appIds.includes(sub.app_id ?? '')) return this.skip(row, 'Not in scope (app)');
    if (c.typeNames && !c.typeNames.includes(sub.ticket_type_name ?? '')) return this.skip(row, 'Not in scope (ticket type)');
    if (!anyActionOn(c)) return this.skip(row, 'No triage actions are turned on');
    const usage = await monthlyUsage(deps.db, row.workspace_id);
    if (usage.triaged >= c.monthlyLimit) return this.skip(row, 'Monthly limit reached');
    const key = await resolveApiKey(deps, row.workspace_id);
    if (!key) {
      await pauseTriage(deps.db, row.workspace_id, 'no_key', null);
      return this.requeue(row);
    }
    if (!deps.github) return this.skip(row, 'GitHub isn’t configured');
    const conn = await getGitHubConnection(deps.db, row.workspace_id);
    const inst = conn?.installation_id ?? sub.installation_id;

    // The ticket text lives in the GitHub issue (it's removed from our database once filed).
    let issue: IssueDetail;
    try {
      issue = await deps.github.getIssueDetail(inst, sub.repo_owner, sub.repo_name, sub.issue_number);
    } catch (err) {
      if (err instanceof GitHubApiError && [403, 404, 410].includes(err.status) && !err.isRateLimit) return this.skip(row, 'The GitHub issue no longer exists or can’t be read');
      return this.retry(row, `GitHub unavailable: ${githubMessage(err)}`);
    }
    if (issue.state === 'closed') return this.skip(row, 'The issue was already closed on GitHub');

    // Duplicate candidates: recent open issues plus a keyword search. Best effort.
    const candidates = new Map<number, IssueDetail>();
    if (c.duplicate.mode !== 'off') {
      try {
        for (const i of await deps.github.listRecentIssues(inst, sub.repo_owner, sub.repo_name, 'open', 30)) candidates.set(i.number, i);
      } catch {
        // Triage continues without these.
      }
      const terms = searchTerms(issue.title);
      if (terms) {
        try {
          for (const i of await deps.github.searchIssues(inst, sub.repo_owner, sub.repo_name, terms, 10)) if (!candidates.has(i.number)) candidates.set(i.number, i);
        } catch {
          // Search is rate limited separately; skip it this time.
        }
      }
      candidates.delete(issue.number);
    }
    const shown = [...candidates.values()].slice(0, MAX_CANDIDATES);

    const title = decryptPayload(deps.box, sub)?.title ?? issue.title;
    let result;
    try {
      result = await this.ai.classify(
        key.key,
        c.model,
        buildSystemPrompt(c),
        buildUserPrompt({ app: sub.app_name, type: sub.ticket_type_name, title, description: extractDescription(issue.body) }, shown),
      );
    } catch (err) {
      const e = err instanceof TriageAiError ? err : new TriageAiError('retry', (err as Error).message);
      if (e.action === 'pause') {
        await pauseTriage(deps.db, row.workspace_id, e.pauseReason ?? 'rejected', e.message);
        deps.log.warn({ workspace: row.workspace_id, reason: e.pauseReason }, 'triage paused');
        return this.requeue(row);
      }
      if (e.action === 'skip') return this.skip(row, e.message, { model: c.model });
      return this.retry(row, e.message);
    }

    const verdict = normalizeVerdict(result.verdict, new Set(shown.map((i) => i.number)));
    const { auto, suggested } = planActions(verdict, c);
    const applied: TriageAction[] = [];
    let error: string | null = null;
    if (auto.length) {
      try {
        await applyToGitHub(deps, sub, auto);
        applied.push(...auto);
      } catch (err) {
        // Nothing is lost: the actions become suggestions an admin can apply later.
        error = `Couldn’t update the GitHub issue: ${githubMessage(err)}`;
        suggested.unshift(...auto);
      }
    }
    await this.finish(row, {
      status: 'done',
      model: c.model,
      verdict,
      applied_actions: applied,
      suggestions: suggested,
      priority: c.priority.mode !== 'off' ? verdict.priority : null,
      is_duplicate: verdict.duplicate_of !== null && c.duplicate.mode !== 'off' ? 1 : 0,
      is_spam: verdict.spam && c.spam.mode !== 'off' ? 1 : 0,
      suggestion_count: suggested.length,
      error,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      completed_at: new Date(),
    });
    await addEvent(deps.db, sub.id, 'triage_done', { applied: applied.map(describeAction), suggested: suggested.map(describeAction) });
    deps.log.info({ submission: sub.ref, applied: applied.length, suggested: suggested.length }, 'ticket triaged');
  }

  async getResult(workspaceId: string, submissionId: string): Promise<TriageResultRow | null> {
    const { rows } = await this.deps.db.query<TriageResultRow>('SELECT * FROM triage_results WHERE workspace_id = $1 AND submission_id = $2', [workspaceId, submissionId]);
    return rows[0] ?? null;
  }

  private async reviewTarget(workspaceId: string, submissionId: string, kind: string) {
    const row = await this.getResult(workspaceId, submissionId);
    const action = row?.status === 'done' ? (row.suggestions ?? []).find((a) => a.kind === kind) : undefined;
    if (!row || !action) throw new UserFacingError('That suggestion was already handled.', 409);
    return { row, action, rest: (row.suggestions ?? []).filter((a) => a !== action) };
  }

  /** Applies one suggestion on GitHub (people who can act on tickets). */
  async applySuggestion(workspaceId: string, submissionId: string, kind: string, userId: string): Promise<TriageAction> {
    const { row, action, rest } = await this.reviewTarget(workspaceId, submissionId, kind);
    const sub = await getSubmission(this.deps.db, workspaceId, submissionId);
    if (!sub || sub.status !== 'created') throw new UserFacingError('The ticket is no longer filed on GitHub.');
    try {
      await applyToGitHub(this.deps, sub, [action]);
    } catch (err) {
      throw new UserFacingError(`GitHub didn’t accept the change (${githubMessage(err)}). Try again in a moment.`, 502);
    }
    await this.saveReview(row, rest, [...(row.applied_actions ?? []), action]);
    await addEvent(this.deps.db, submissionId, 'triage_applied', { by: userId, actions: [describeAction(action)] });
    return action;
  }

  async dismissSuggestion(workspaceId: string, submissionId: string, kind: string, userId: string): Promise<TriageAction> {
    const { row, action, rest } = await this.reviewTarget(workspaceId, submissionId, kind);
    await this.saveReview(row, rest, row.applied_actions ?? []);
    await addEvent(this.deps.db, submissionId, 'triage_dismissed', { by: userId, actions: [describeAction(action)] });
    return action;
  }

  private async saveReview(row: TriageResultRow, suggestions: TriageAction[], applied: TriageAction[]) {
    await this.deps.db.query(
      'UPDATE triage_results SET suggestions = $2, applied_actions = $3, suggestion_count = $4, updated_at = now_ms() WHERE submission_id = $1',
      [row.submission_id, suggestions, applied, suggestions.length],
    );
  }
}

/** Triage summaries for a page of tickets (inbox priority column). */
export async function triageSummaries(q: Queryable, workspaceId: string, ids: string[]): Promise<Map<string, Pick<TriageResultRow, 'status' | 'priority' | 'is_duplicate' | 'is_spam' | 'suggestion_count'>>> {
  if (!ids.length) return new Map();
  const { rows } = await q.query<TriageResultRow>(
    'SELECT submission_id, status, priority, is_duplicate, is_spam, suggestion_count FROM triage_results WHERE workspace_id = $1 AND submission_id IN (SELECT value FROM json_each($2))',
    [workspaceId, ids],
  );
  return new Map(rows.map((r) => [r.submission_id, r]));
}
