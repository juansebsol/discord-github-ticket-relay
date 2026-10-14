/**
 * AI triage of filed tickets.
 *
 * Isolation from filing is the core design rule: triage only reads tickets that are already
 * filed (status `created`), keeps its own table, and never writes to the filing queue. If
 * Claude is unavailable, out of credits or misconfigured, triage pauses or retries on its
 * own and tickets keep being filed exactly as before.
 */
import type { Queryable } from '../db/database.js';
import { createdWithNoteMessage } from '../discord/messages.js';
import { recordKeyCheck, stateFromPause } from '../domain/claude-key.js';
import { cleanUpSpam, fileCounts } from '../domain/files.js';
import { decryptPayload, getSubmission, addEvent } from '../domain/submissions.js';
import { getDiscordConnection, getGitHubConnection } from '../domain/store.js';
import { neutralizeGitHubMentions } from '../github/issue-content.js';
import { labelColor } from '../domain/ticket-types.js';
import { UserFacingError, type Deps, type SubmissionRow } from '../domain/types.js';
import { GitHubApiError, type IssueDetail } from '../github/client.js';
import { normalizeVerdict, TriageAiError, type TriageAi, type Verdict } from './ai.js';
import { buildSystemPrompt, buildUserPrompt, extractDescription, searchTerms, type Candidate } from './prompt.js';
import {
  appOf,
  chooseOriginal,
  excerptOf,
  ftsQuery,
  getIndexed,
  IssueIndexer,
  learnOriginals,
  markGone,
  searchIndex,
  setDuplicateOf,
  upsertIssues,
  type IndexedIssue,
} from '../domain/issue-index.js';
import { listTicketTypes } from '../domain/ticket-types.js';
import {
  ACTION_KINDS,
  actionsOffFor,
  withActionsOff,
  CLOSE_ONLY_COMMENT,
  FLAG_DEFAULTS,
  MISSING_TEXT,
  NOTIFIABLE,
  anyActionOn,
  getTriageSettings,
  monthlyUsage,
  pauseTriage,
  resolveApiKey,
  type ActionKind,
  type Flag,
  type MissingItem,
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
  /** The original is closed (for example fixed): only ever suggested, never applied automatically. */
  originalClosed?: boolean;
  missing?: MissingItem[];
  /** Comment for the GitHub issue, rendered from the workspace's template when the call was made. */
  comment?: string | null;
  /** Note for the member's Discord confirmation, when that's switched on for the action. */
  memberNote?: string | null;
}

/** Values for {app}, {duplicate}, {missing} and {help_channel} in comment templates. */
export interface TemplateContext {
  app: string;
  repoUrl: string;
  guildId: string | null;
  helpChannel: { id: string; name: string } | null;
}

function humanList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Fills a template written by the workspace admins. Claude's own text is never inserted. */
export function renderTemplate(template: string, ctx: TemplateContext, a: Pick<TriageAction, 'duplicateOf' | 'missing'>, target: 'github' | 'discord'): string {
  const channel = ctx.helpChannel;
  const vars: Record<string, string> = {
    app: target === 'github' ? neutralizeGitHubMentions(ctx.app) : ctx.app,
    duplicate: a.duplicateOf ? (target === 'github' ? `#${a.duplicateOf}` : `[#${a.duplicateOf}](${ctx.repoUrl}/issues/${a.duplicateOf})`) : 'another issue',
    missing: humanList((a.missing ?? []).map((m) => MISSING_TEXT[m])) || 'a few more details',
    help_channel: channel && ctx.guildId
      ? target === 'github' ? `[#${channel.name} on Discord](https://discord.com/channels/${ctx.guildId}/${channel.id})` : `<#${channel.id}>`
      : 'our Discord server',
  };
  return template.replace(/\{(app|duplicate|missing|help_channel)\}/g, (_m, k: string) => vars[k]!).trim();
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
  is_support: number;
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
/** Best matches from the issue index shown to Claude; more only while the index is still loading. */
const INDEX_CANDIDATES = 20;
const MAX_CANDIDATES = 40;

function fromIndexed(i: IndexedIssue): Candidate {
  return { number: i.number, state: i.state, stateReason: i.state_reason, createdAt: i.created_at, app: i.app_name, title: i.title, text: i.excerpt };
}

function fromIssue(i: IssueDetail): Candidate {
  return { number: i.number, state: i.state, stateReason: i.stateReason, createdAt: i.createdAt, app: appOf(i.title, i.body), title: i.title, text: excerptOf(i.body) };
}

type RepoRef = { repo_id: number; owner: string; name: string; installation_id: number };

/** Turns Claude's verdict into the actions the workspace allows, split into automatic and suggested. */
export function planActions(v: Verdict, c: TriageConfig, ctx?: TemplateContext): { auto: TriageAction[]; suggested: TriageAction[] } {
  const planned: { mode: Mode; action: TriageAction }[] = [];
  const add = (kind: Flag, confidence: number, extra: Partial<TriageAction> = {}) => {
    const f = c[kind];
    if (f.mode === 'off') return;
    const action: TriageAction = { kind, label: f.label, close: f.close, confidence, ...extra };
    if (ctx) {
      // Spam and "no action needed" only comment when they close the issue.
      const comment = f.comment && (!CLOSE_ONLY_COMMENT.has(kind) || f.close) ? renderTemplate(f.comment, ctx, action, 'github') : '';
      action.comment = comment || null;
      action.memberNote = NOTIFIABLE.has(kind) && f.notifyMember && f.comment ? renderTemplate(f.comment, ctx, action, 'discord') : null;
    }
    planned.push({ mode: f.mode, action });
  };
  // Only checks that are switched on count (globally or for this ticket type). A confident spam,
  // "no action needed" or "not a development issue" call makes the other labels pointless.
  const on = (kind: Flag) => c[kind].mode !== 'off';
  const spam = v.spam && on('spam');
  const noAction = v.no_action && on('noAction');
  const notDev = (v.not_dev_issue ?? false) && on('support');
  const junk = (spam && v.spam_confidence >= c.threshold) || (noAction && v.no_action_confidence >= c.threshold) || (notDev && v.not_dev_issue_confidence >= c.threshold);
  if (spam) add('spam', v.spam_confidence);
  else if (noAction) add('noAction', v.no_action_confidence);
  else if (notDev) add('support', v.not_dev_issue_confidence);
  if (!junk) {
    if (v.duplicate_of !== null) add('duplicate', v.duplicate_confidence, { duplicateOf: v.duplicate_of, ...(v.duplicate_closed ? { originalClosed: true } : {}) });
    else if (v.needs_info && !notDev) add('needsInfo', v.needs_info_confidence, { missing: v.missing ?? [] });
    if (c.priority.mode !== 'off') {
      planned.push({ mode: c.priority.mode, action: { kind: 'priority', label: c.priority.labels[v.priority], close: false, confidence: v.priority_confidence, priority: v.priority } });
    }
  }
  const isAuto = (p: (typeof planned)[number]) => p.mode === 'auto' && p.action.confidence >= c.threshold && !p.action.originalClosed;
  const auto = planned.filter(isAuto).map((p) => p.action);
  const suggested = planned.filter((p) => !isAuto(p)).map((p) => p.action);
  return { auto, suggested };
}

/** Short, human description of an action for the activity log. */
export function describeAction(a: TriageAction): string {
  const what = a.kind === 'priority' ? a.label : a.kind === 'duplicate' ? `duplicate of #${a.duplicateOf}` : a.kind === 'spam' ? 'spam' : a.kind === 'needsInfo' ? 'needs info' : a.kind === 'support' ? 'not a development issue' : 'no action needed';
  return a.close ? `${what} (closed)` : what;
}

/** Adds the actions' labels (creating missing ones), posts one comment from the admins' templates, and closes if asked. */
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
  const closing = actions.some((a) => a.close);
  const parts = actions.map((a) => (a.comment === undefined ? legacyComment(a) : a.comment)).filter((c): c is string => Boolean(c));
  // Spam and "no action needed" templates already say the issue was closed.
  if (closing && !actions.some((a) => a.close && CLOSE_ONLY_COMMENT.has(a.kind as Flag) && (a.comment ?? legacyComment(a)))) {
    parts.push('Closed by Ticket Relay triage. If that’s wrong, reopen this issue.');
  }
  if (parts.length) await gh.createComment(inst, owner, repo, n, parts.join('\n\n'));
  if (closing) await gh.closeIssue(inst, owner, repo, n);
  // Later duplicates of this ticket then lead to its original.
  for (const a of actions) if (a.kind === 'duplicate' && a.duplicateOf) await setDuplicateOf(deps.db, sub.repo_id, n, a.duplicateOf).catch(() => {});
  if (actions.some((a) => a.kind === 'spam' && a.close)) {
    // Spam files aren't kept around when the cleanup rules say so.
    await cleanUpSpam(deps, sub).catch((err) => deps.log.warn({ submission: sub.ref, err: (err as Error).message }, 'could not delete spam files'));
  }
}

/** Suggestions saved before comment templates existed keep their original fixed text. */
function legacyComment(a: TriageAction): string | null {
  if (a.kind === 'duplicate') return `Possible duplicate of #${a.duplicateOf}.`;
  if (a.close && (a.kind === 'spam' || a.kind === 'noAction')) return FLAG_DEFAULTS[a.kind].comment;
  return null;
}

/**
 * Adds the actions' member notes to the member's private Discord confirmation. Only possible
 * while Discord's interaction token is valid (15 minutes); returns whether the member was told.
 */
export async function tellMember(deps: Deps, sub: SubmissionRow, actions: TriageAction[]): Promise<boolean> {
  const note = actions.map((a) => a.memberNote).filter(Boolean).join('\n\n');
  if (!note || !deps.discord || !sub.issue_number || !sub.issue_url) return false;
  const { rows } = await deps.db.query<{ interaction_token_enc: string | null; interaction_token_expires_at: Date | null }>(
    'SELECT interaction_token_enc, interaction_token_expires_at FROM submissions WHERE id = $1',
    [sub.id],
  );
  const t = rows[0];
  if (!t?.interaction_token_enc || !t.interaction_token_expires_at || t.interaction_token_expires_at.getTime() < Date.now()) return false;
  const { flags: _ephemeralIsFixedAtCreation, ...edit } = createdWithNoteMessage(
    { appName: sub.app_name, ref: sub.ref, issueNumber: sub.issue_number, issueUrl: sub.issue_url, repoPrivate: sub.repo_private, files: await fileCounts(deps.db, sub.id) },
    note,
  );
  try {
    await deps.discord.editOriginalResponse(deps.box.decrypt(t.interaction_token_enc), edit);
    return true;
  } catch (err) {
    deps.log.warn({ submission: sub.ref, err: (err as Error).message }, 'could not add the triage note to the member reply');
    return false;
  }
}

function githubMessage(err: unknown): string {
  return err instanceof GitHubApiError ? `${err.status} ${err.message}` : (err as Error)?.message ?? 'unknown error';
}

export class TriageEngine {
  readonly indexer: IssueIndexer;

  constructor(
    readonly deps: Deps,
    readonly ai: TriageAi,
  ) {
    this.indexer = new IssueIndexer(deps);
  }

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
    if (!settings.enabled) return this.skip(row, 'Triage was turned off');
    const sub = await getSubmission(deps.db, row.workspace_id, row.submission_id);
    if (!sub || sub.status !== 'created' || !sub.issue_number) return this.skip(row, 'The ticket is no longer filed');
    if (settings.config.appIds && !settings.config.appIds.includes(sub.app_id ?? '')) return this.skip(row, 'Not in scope (app)');
    // The ticket type's rules switch actions off for this ticket; Claude is told which.
    const type = sub.ticket_type_name ? (await listTicketTypes(deps.db, row.workspace_id)).find((t) => t.name === sub.ticket_type_name) ?? null : null;
    const off = actionsOffFor(settings.config, type);
    const c = withActionsOff(settings.config, off);
    if (!anyActionOn(c)) return this.skip(row, off.size === ACTION_KINDS.length ? 'Not in scope (ticket type)' : 'No triage actions are turned on');
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

    // Duplicate candidates: the best matches from our copy of every issue in the repository.
    const repoRef: RepoRef = { repo_id: sub.repo_id, owner: sub.repo_owner, name: sub.repo_name, installation_id: inst };
    await upsertIssues(deps.db, sub.repo_id, [issue]).catch(() => {});
    const candidates = new Map<number, Candidate>();
    if (c.duplicate.mode !== 'off') {
      const index = await this.indexer.refresh(repoRef).catch(() => null);
      const query = ftsQuery(issue.title, extractDescription(issue.body));
      if (query) {
        try {
          const hits = await searchIndex(deps.db, { repoIds: [sub.repo_id], query, limit: INDEX_CANDIDATES, exclude: { repoId: sub.repo_id, number: issue.number } });
          for (const h of hits) candidates.set(h.number, fromIndexed(h));
        } catch {
          // Triage continues without these.
        }
      }
      // While the first load is still running, also use GitHub's recent issues and search.
      if (index?.status !== 'ready') {
        const extra: IssueDetail[] = [];
        try {
          extra.push(...(await deps.github.listRecentIssues(inst, sub.repo_owner, sub.repo_name, 'open', 30)));
        } catch {
          // Best effort.
        }
        const terms = searchTerms(issue.title);
        if (terms) {
          try {
            extra.push(...(await deps.github.searchIssues(inst, sub.repo_owner, sub.repo_name, terms, 10)));
          } catch {
            // Search is rate limited separately; skip it this time.
          }
        }
        for (const i of extra) if (!candidates.has(i.number)) candidates.set(i.number, fromIssue(i));
        await upsertIssues(deps.db, sub.repo_id, extra).catch(() => {});
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
        buildUserPrompt({ app: sub.app_name, type: sub.ticket_type_name, title, description: extractDescription(issue.body) }, shown, [...off]),
      );
    } catch (err) {
      const e = err instanceof TriageAiError ? err : new TriageAiError('retry', (err as Error).message);
      if (e.action === 'pause') {
        await pauseTriage(deps.db, row.workspace_id, e.pauseReason ?? 'rejected', e.message);
        // Settings › Claude API shows the key's problem too.
        if (key.source === 'workspace' && (e.pauseReason === 'key_invalid' || e.pauseReason === 'credits')) await recordKeyCheck(deps.db, row.workspace_id, stateFromPause(e.pauseReason), e.message);
        deps.log.warn({ workspace: row.workspace_id, reason: e.pauseReason }, 'triage paused');
        return this.requeue(row);
      }
      if (e.action === 'skip') return this.skip(row, e.message, { model: c.model });
      return this.retry(row, e.message);
    }

    if (key.source === 'workspace') await recordKeyCheck(deps.db, row.workspace_id, 'working', null).catch(() => {});
    const verdict = normalizeVerdict(result.verdict, new Set(shown.map((i) => i.number)));
    if (verdict.duplicates.length && c.duplicate.mode !== 'off') await this.pickOriginal(verdict, repoRef);
    const dc = await getDiscordConnection(deps.db, row.workspace_id);
    const { auto, suggested } = planActions(verdict, c, { app: sub.app_name, repoUrl: `https://github.com/${sub.repo_owner}/${sub.repo_name}`, guildId: dc?.guild_id ?? null, helpChannel: c.helpChannel });
    const applied: TriageAction[] = [];
    let toldMember = false;
    let error: string | null = null;
    if (auto.length) {
      try {
        await applyToGitHub(deps, sub, auto);
        applied.push(...auto);
        toldMember = await tellMember(deps, sub, auto);
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
      // Only a priority that was applied or suggested shows in the inbox.
      priority: [...applied, ...suggested].some((a) => a.kind === 'priority') ? verdict.priority : null,
      is_duplicate: verdict.duplicate_of !== null && c.duplicate.mode !== 'off' ? 1 : 0,
      is_spam: verdict.spam && c.spam.mode !== 'off' ? 1 : 0,
      is_support: verdict.not_dev_issue && c.support.mode !== 'off' ? 1 : 0,
      suggestion_count: suggested.length,
      error,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      completed_at: new Date(),
    });
    await addEvent(deps.db, sub.id, 'triage_done', { applied: applied.map(describeAction), suggested: suggested.map(describeAction), told_member: toldMember });
    deps.log.info({ submission: sub.ref, applied: applied.length, suggested: suggested.length }, 'ticket triaged');
  }

  /**
   * Turns Claude's matches into the issue to link: follows "duplicate of" chains to the
   * original, prefers the oldest one still open, and checks it live on GitHub (it may have been
   * closed, moved or deleted since the last sync). If GitHub can't be reached, our copy is used.
   */
  private async pickOriginal(v: Verdict, repo: RepoRef): Promise<void> {
    const { deps } = this;
    const numbers = v.duplicates.map((d) => d.number);
    const known = await getIndexed(deps.db, repo.repo_id, numbers);
    await learnOriginals(deps, repo, known, numbers);
    for (let depth = 0; depth < 4; depth++) {
      const missing = [...new Set([...known.values()].map((i) => i.duplicate_of).filter((n): n is number => Boolean(n) && !known.has(n!)))];
      if (!missing.length) break;
      for (const [n, row] of await getIndexed(deps.db, repo.repo_id, missing)) known.set(n, row);
    }
    let choice = chooseOriginal(v.duplicates, known);
    const checked = new Set<number>();
    while (choice && !checked.has(choice.number) && checked.size < 3 && deps.github) {
      const n = choice.number;
      checked.add(n);
      try {
        const live = await deps.github.getIssueDetail(repo.installation_id, repo.owner, repo.name, n);
        if (!live.url.toLowerCase().includes(`/${repo.owner}/${repo.name}/issues/`.toLowerCase())) throw new GitHubApiError(404, 'moved', null, false, null);
        await upsertIssues(deps.db, repo.repo_id, [live]);
        known.set(n, { ...known.get(n)!, state: live.state, state_reason: live.stateReason, closed_at: live.closedAt, gone: 0 });
      } catch (err) {
        if (!(err instanceof GitHubApiError) || err.isRateLimit || ![404, 410].includes(err.status)) break;
        await markGone(deps.db, repo.repo_id, n);
        known.set(n, { ...known.get(n)!, gone: 1 });
      }
      choice = chooseOriginal(v.duplicates, known);
    }
    v.duplicate_of = choice?.number ?? null;
    v.duplicate_confidence = choice?.confidence ?? 0;
    v.duplicate_via = choice?.via ?? null;
    v.duplicate_closed = choice?.closed ?? false;
    v.duplicate_others = choice?.others ?? [];
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
    const told = await tellMember(this.deps, sub, [action]);
    await addEvent(this.deps.db, submissionId, 'triage_applied', { by: userId, actions: [describeAction(action)], told_member: told });
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
export async function triageSummaries(q: Queryable, workspaceId: string, ids: string[]): Promise<Map<string, Pick<TriageResultRow, 'status' | 'priority' | 'is_duplicate' | 'is_spam' | 'is_support' | 'suggestion_count'>>> {
  if (!ids.length) return new Map();
  const { rows } = await q.query<TriageResultRow>(
    'SELECT submission_id, status, priority, is_duplicate, is_spam, is_support, suggestion_count FROM triage_results WHERE workspace_id = $1 AND submission_id IN (SELECT value FROM json_each($2))',
    [workspaceId, ids],
  );
  return new Map(rows.map((r) => [r.submission_id, r]));
}
