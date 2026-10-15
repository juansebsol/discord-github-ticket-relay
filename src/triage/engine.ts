/**
 * AI triage of filed tickets.
 *
 * Isolation from filing is the core design rule: triage only reads tickets that are already
 * filed (status `created`), keeps its own table, and never writes to the filing queue. If
 * Claude is unavailable, out of credits or misconfigured, triage pauses or retries on its
 * own and tickets keep being filed exactly as before.
 */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import { createdWithNoteMessage } from '../discord/messages.js';
import { recordKeyCheck, stateFromPause } from '../domain/claude-key.js';
import { cleanUpSpam, fileCounts } from '../domain/files.js';
import { decryptPayload, getSubmission, addEvent } from '../domain/submissions.js';
import { getDiscordConnection, getGitHubConnection, listApps } from '../domain/store.js';
import { neutralizeGitHubMentions } from '../github/issue-content.js';
import { labelColor } from '../domain/ticket-types.js';
import { UserFacingError, type AppRow, type Deps, type SubmissionRow } from '../domain/types.js';
import { GitHubApiError, type IssueDetail } from '../github/client.js';
import { normalizeVerdict, TriageAiError, verdictSchema, type TriageAi, type Verdict } from './ai.js';
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
  actionsOffFor,
  allActionKeys,
  withActionsOff,
  CLOSE_ONLY_COMMENT,
  FLAG_DEFAULTS,
  MISSING_TEXT,
  NOTIFIABLE,
  anyActionOn,
  getTriageSettings,
  monthlyUsage,
  parseTriageConfig,
  pauseTriage,
  resolveApiKey,
  groupKind,
  NO_CLOSE,
  type ActionKind,
  type Flag,
  type GroupKind,
  type MissingItem,
  type Mode,
  type Priority,
  type TriageConfig,
} from './settings.js';

export interface TriageAction {
  kind: ActionKind | GroupKind;
  label: string;
  close: boolean;
  confidence: number;
  priority?: Priority;
  duplicateOf?: number;
  /** The original is closed (for example fixed): only ever suggested, never applied automatically. */
  originalClosed?: boolean;
  missing?: MissingItem[];
  /** Regression: the issue that was closed as fixed. */
  regressionOf?: number;
  /** Several problems: one short title each. */
  parts?: string[];
  /** Related issues, as refs ("owner/repo#number"). */
  related?: string[];
  sharedApps?: string[];
  sharedIssue?: string | null;
  /** Wrong repository: the app (and its repository) the ticket belongs to. */
  rightApp?: string;
  rightRepo?: string;
  /** Label groups: the options chosen (all added as labels). */
  labels?: string[];
  groupName?: string;
  /** Comment for the GitHub issue, rendered from the workspace's template when the call was made. */
  comment?: string | null;
  /** Note for the member's Discord confirmation, when that's switched on for the action. */
  memberNote?: string | null;
}

/** Values for the placeholders in comment templates. */
export interface TemplateContext {
  app: string;
  repoUrl: string;
  /** "owner/repo" of the ticket's repository. */
  repo?: string;
  guildId: string | null;
  helpChannel: { id: string; name: string } | null;
}

function humanList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Text Claude wrote from the member's ticket (the parts' titles): one plain line, no links, mentions or formatting. */
function plainLine(s: string): string {
  return s.replace(/https?:\/\/\S+/gi, '').replace(/[\\`*_{}[\]()<>#|~@!]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** An issue reference: "#12" in the ticket's own repository, "owner/repo#12" elsewhere (GitHub links both). */
function refText(ref: string, ctx: TemplateContext, target: 'github' | 'discord'): string {
  const m = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(ref);
  if (!m) return '';
  const short = m[1]!.toLowerCase() === ctx.repo?.toLowerCase() ? `#${m[2]}` : ref;
  return target === 'github' ? short : `[${short}](https://github.com/${m[1]}/issues/${m[2]})`;
}

/** Fills a template written by the workspace admins. Claude's own words never reach a comment, except the parts' plain titles. */
export function renderTemplate(template: string, ctx: TemplateContext, a: Partial<TriageAction>, target: 'github' | 'discord'): string {
  const channel = ctx.helpChannel;
  const name = (s: string) => (target === 'github' ? neutralizeGitHubMentions(s) : s);
  const issue = (n: number | undefined, fallback: string) => (n ? (target === 'github' ? `#${n}` : `[#${n}](${ctx.repoUrl}/issues/${n})`) : fallback);
  const vars: Record<string, string> = {
    app: name(ctx.app),
    duplicate: issue(a.duplicateOf, 'another issue'),
    regression: issue(a.regressionOf, 'an earlier issue'),
    missing: humanList((a.missing ?? []).map((m) => MISSING_TEXT[m])) || 'a few more details',
    parts: (a.parts ?? []).map((p) => `- ${plainLine(p)}`).filter((p) => p.length > 2).join('\n') || '- (see the description)',
    related: humanList((a.related ?? []).map((r) => refText(r, ctx, target)).filter(Boolean)) || 'other issues',
    shared_apps: humanList((a.sharedApps ?? []).map(name)) || 'other apps',
    shared_issue: a.sharedIssue ? refText(a.sharedIssue, ctx, target) || 'another issue' : 'no issue yet',
    right_app: a.rightApp ? name(a.rightApp) : 'another app',
    right_repo: a.rightRepo ? `[${a.rightRepo}](https://github.com/${a.rightRepo})` : 'another repository',
    help_channel: channel && ctx.guildId
      ? target === 'github' ? `[#${channel.name} on Discord](https://discord.com/channels/${ctx.guildId}/${channel.id})` : `<#${channel.id}>`
      : 'our Discord server',
  };
  return template.replace(/\{(app|duplicate|regression|missing|parts|related|shared_apps|shared_issue|right_app|right_repo|help_channel)\}/g, (_m, k: string) => vars[k]!).trim();
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
/** Matches from the workspace's other repositories (related issues and shared problems, never duplicates). */
const OTHER_REPO_CANDIDATES = 8;
const MAX_CANDIDATES = 40;

function fromIndexed(i: IndexedIssue, repo: string, sameRepo: boolean): Candidate {
  return { ref: `${repo}#${i.number}`, repo, sameRepo, number: i.number, state: i.state, stateReason: i.state_reason, createdAt: i.created_at, app: i.app_name, title: i.title, text: i.excerpt };
}

function fromIssue(i: IssueDetail, repo: string): Candidate {
  return { ref: `${repo}#${i.number}`, repo, sameRepo: true, number: i.number, state: i.state, stateReason: i.stateReason, createdAt: i.createdAt, app: appOf(i.title, i.body), title: i.title, text: excerptOf(i.body) };
}

type RepoRef = { repo_id: number; owner: string; name: string; installation_id: number };

/** Apps by name, to find where a "wrong repository" ticket belongs. */
export type AppRepos = Map<string, string>;

/** Turns Claude's verdict into the actions the workspace allows, split into automatic and suggested. */
export function planActions(v: Verdict, c: TriageConfig, ctx?: TemplateContext, apps: AppRepos = new Map()): { auto: TriageAction[]; suggested: TriageAction[] } {
  const planned: { mode: Mode; action: TriageAction }[] = [];
  const add = (kind: Flag, confidence: number, extra: Partial<TriageAction> = {}) => {
    const f = c[kind];
    if (f.mode === 'off') return;
    const action: TriageAction = { kind, label: f.label, close: NO_CLOSE.has(kind) ? false : f.close, confidence, ...extra };
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
  const noise = (spam && v.spam_confidence >= c.threshold) || (noAction && v.no_action_confidence >= c.threshold);
  if (spam) add('spam', v.spam_confidence);
  else if (noAction) add('noAction', v.no_action_confidence);
  else if (notDev) add('support', v.not_dev_issue_confidence);
  if (!junk) {
    const regression = v.regression_of ?? null;
    if (regression !== null) add('regression', v.regression_confidence ?? 0, { regressionOf: regression });
    if (v.duplicate_of !== null && v.duplicate_of !== regression) add('duplicate', v.duplicate_confidence, { duplicateOf: v.duplicate_of, ...(v.duplicate_closed ? { originalClosed: true } : {}) });
    else if (v.needs_info && !notDev && regression === null) add('needsInfo', v.needs_info_confidence, { missing: v.missing ?? [] });
    if ((v.parts ?? []).length >= 2) add('multiple', v.parts_confidence ?? 0, { parts: v.parts });
    if ((v.related ?? []).length) add('related', v.related_confidence ?? 0, { related: v.related });
    if (v.shared) add('shared', v.shared_confidence ?? 0, { sharedApps: v.shared_apps ?? [], sharedIssue: v.shared_issue ?? null });
    const rightRepo = v.right_app ? apps.get(v.right_app) : undefined;
    if (v.right_app && rightRepo && rightRepo.toLowerCase() !== ctx?.repo?.toLowerCase()) add('wrongRepo', v.right_app_confidence ?? 0, { rightApp: v.right_app, rightRepo });
    if (c.priority.mode !== 'off') {
      planned.push({ mode: c.priority.mode, action: { kind: 'priority', label: c.priority.labels[v.priority], close: false, confidence: v.priority_confidence, priority: v.priority } });
    }
  }
  // Label groups: the options Claude chose, as labels (also for questions; not for spam).
  if (!noise) {
    for (const g of c.labelGroups) {
      const picked = v.labels?.[g.id];
      if (g.mode === 'off' || !picked?.options.length) continue;
      planned.push({ mode: g.mode, action: { kind: groupKind(g.id), label: '', labels: picked.options, groupName: g.name, close: false, confidence: picked.confidence } });
    }
  }
  const isAuto = (p: (typeof planned)[number]) => p.mode === 'auto' && p.action.confidence >= c.threshold && !p.action.originalClosed;
  const auto = planned.filter(isAuto).map((p) => p.action);
  const suggested = planned.filter((p) => !isAuto(p)).map((p) => p.action);
  return { auto, suggested };
}

/** Short, human description of an action for the activity log. */
export function describeAction(a: TriageAction): string {
  const what = a.kind === 'priority'
    ? a.label
    : a.kind === 'duplicate' ? `duplicate of #${a.duplicateOf}`
    : a.kind === 'regression' ? `regression of #${a.regressionOf}`
    : a.kind === 'spam' ? 'spam'
    : a.kind === 'needsInfo' ? 'needs info'
    : a.kind === 'support' ? 'not a development issue'
    : a.kind === 'multiple' ? `${a.parts?.length ?? 'several'} separate problems`
    : a.kind === 'related' ? `related to ${(a.related ?? []).join(', ')}`
    : a.kind === 'shared' ? 'shared across apps'
    : a.kind === 'wrongRepo' ? `belongs to ${a.rightApp}`
    : a.kind.startsWith('group:') ? `${a.groupName ?? 'labels'}: ${(a.labels ?? []).join(', ')}`
    : 'no action needed';
  return a.close ? `${what} (closed)` : what;
}

/** Every label an action adds (one for most actions, several for a label group, none for comment-only actions). */
export function actionLabels(a: TriageAction): string[] {
  return (a.labels ?? [a.label]).map((l) => l.trim()).filter(Boolean);
}

/**
 * The one comment posted when these actions are applied together: each action's comment from
 * the admins' templates, plus a closing line when the issue is closed without one saying so.
 */
export function commentFor(actions: TriageAction[]): string | null {
  const parts = actions.map((a) => (a.comment === undefined ? legacyComment(a) : a.comment)).filter((c): c is string => Boolean(c));
  // Spam and "no action needed" templates already say the issue was closed.
  if (actions.some((a) => a.close) && !actions.some((a) => a.close && CLOSE_ONLY_COMMENT.has(a.kind as Flag) && (a.comment ?? legacyComment(a)))) {
    parts.push('Closed by Ticket Relay triage. If that’s wrong, reopen this issue.');
  }
  return parts.length ? parts.join('\n\n') : null;
}

/** Adds the actions' labels (creating missing ones), posts one comment from the admins' templates, and closes if asked. */
export async function applyToGitHub(deps: Deps, sub: SubmissionRow, actions: TriageAction[]): Promise<void> {
  if (!actions.length) return;
  if (!deps.github || !sub.issue_number) throw new Error('GitHub is not configured');
  const gh = deps.github;
  const conn = await getGitHubConnection(deps.db, sub.workspace_id);
  const inst = conn?.installation_id ?? sub.installation_id;
  const { repo_owner: owner, repo_name: repo, issue_number: n } = sub;
  const labels = [...new Set(actions.flatMap(actionLabels))];
  if (labels.length) {
    const existing = new Set((await gh.listLabels(inst, owner, repo)).map((l) => l.toLowerCase()));
    for (const name of labels) if (!existing.has(name.toLowerCase())) await gh.createLabel(inst, owner, repo, name, labelColor(name));
    await gh.addLabels(inst, owner, repo, n, labels);
  }
  const comment = commentFor(actions);
  if (comment) await gh.createComment(inst, owner, repo, n, comment);
  if (actions.some((a) => a.close)) await gh.closeIssue(inst, owner, repo, n);
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
  if (a.close && (a.kind === 'spam' || a.kind === 'noAction')) return FLAG_DEFAULTS[a.kind as 'spam' | 'noAction'].comment;
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

/** The system prompt for these settings. Label groups that are off everywhere are left out. */
export function systemPromptFor(c: TriageConfig, apps: AppRow[]): string {
  return buildSystemPrompt(
    { ...c, labelGroups: c.labelGroups.filter((g) => g.mode !== 'off') },
    { apps: apps.map((a) => ({ name: a.name, repo: `${a.repo_owner}/${a.repo_name}`, description: a.description ?? '' })) },
  );
}

/** What one triage pass decided for a ticket. Nothing is applied yet. */
export interface Evaluation {
  sub: SubmissionRow;
  verdict: Verdict;
  auto: TriageAction[];
  suggested: TriageAction[];
  /** The settings used, after the ticket type's rules. */
  config: TriageConfig;
  inputTokens: number;
  outputTokens: number;
}

export type Outcome =
  | { status: 'done'; e: Evaluation }
  | { status: 'skip'; reason: string; model?: string }
  /** waitSeconds: a rate limit; a re-run waits that long without counting the attempt. */
  | { status: 'retry'; message: string; waitSeconds?: number; waitFor?: 'github' | 'claude' }
  | { status: 'paused' };

/** The columns of a ticket's triage result that describe what triage decided. */
function resultFields(e: Evaluation, applied: TriageAction[], suggested: TriageAction[]) {
  const { verdict: v, config: c } = e;
  return {
    model: c.model,
    verdict: v,
    applied_actions: applied,
    suggestions: suggested,
    // Only a priority that was applied or suggested shows in the inbox.
    priority: [...applied, ...suggested].some((a) => a.kind === 'priority') ? v.priority : null,
    is_duplicate: v.duplicate_of !== null && c.duplicate.mode !== 'off' ? 1 : 0,
    is_spam: v.spam && c.spam.mode !== 'off' ? 1 : 0,
    is_support: v.not_dev_issue && c.support.mode !== 'off' ? 1 : 0,
    suggestion_count: suggested.length,
  };
}

// ---- Re-runs ------------------------------------------------------------------------------

export interface RerunScope {
  /** Tickets triage already looked at, with no action applied (only suggestions, or nothing found). */
  untouched: boolean;
  /** Tickets never triaged: filed before triage was on, or skipped. */
  never: boolean;
  appId: string | null;
  typeName: string | null;
  limit: number;
  /** How many tickets matched when the run started (before the limit). */
  matched?: number;
}

export interface TriageRunRow {
  id: string;
  workspace_id: string;
  name: string | null;
  mode: 'preview' | 'apply';
  status: 'running' | 'done' | 'cancelled';
  scope: RerunScope;
  config_used: TriageConfig;
  created_by: string | null;
  created_at: Date;
  finished_at: Date | null;
  applied_at: Date | null;
  applied_by: string | null;
  /** Paused for a rate limit until then: GitHub's (to keep room for filing) or Claude's. */
  waiting_until_at: Date | null;
  waiting_reason: 'github' | 'claude' | null;
}

/** The ticket's triage result when a run started, to compare with. */
export interface BeforeResult {
  status: TriageResultRow['status'];
  applied: TriageAction[];
  suggestions: TriageAction[];
  reason: string | null;
  skipReason: string | null;
  model: string | null;
}

export interface RunItemRow {
  run_id: string;
  submission_id: string;
  position: number;
  status: 'pending' | 'done' | 'skipped' | 'failed';
  lease_until_at: Date | null;
  attempts: number;
  next_attempt_at: Date | null;
  verdict: Verdict | null;
  auto_actions: TriageAction[] | null;
  suggestions: TriageAction[] | null;
  before: BeforeResult | null;
  note: string | null;
  apply_status: 'pending' | 'done' | 'skipped' | 'failed' | null;
  apply_note: string | null;
  /** Applying also applies the suggestions (someone approved them in bulk). */
  apply_suggestions: boolean;
  /** Applying only updates the inbox: every action becomes a suggestion, nothing goes to GitHub. */
  apply_inbox_only: boolean;
  apply_done_at: Date | null;
  /** Compared with the ticket's triage before the run, once the ticket is done. */
  change: RunChange | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  completed_at: Date | null;
}

/** Most tickets in one run (each one is a Claude call; the monthly limit applies too). */
export const MAX_RERUN = 10_000;

export type RunChange = 'changed' | 'new' | 'same';
export type RunFilter = 'all' | 'changed' | 'same' | 'skipped';
/** What applying a preview does: inbox only (all suggestions), the automatic actions on GitHub, or everything on GitHub. */
export type ApplyMode = 'inbox' | 'auto' | 'all';
type Decisions = { auto: TriageAction[]; suggested: TriageAction[] };

/** The decisions in a result, ignoring wording: what is done automatically and what is suggested. */
function decisionKey(d: Decisions): string {
  return [...d.auto.map((a) => `auto:${describeAction(a)}`), ...d.suggested.map((a) => `suggest:${describeAction(a)}`)].sort().join('|');
}

/** A ticket's triage before a run, as decisions (null when it had no result). */
export function beforeDecisions(b: BeforeResult | null): Decisions | null {
  return b?.status === 'done' ? { auto: b.applied, suggested: b.suggestions } : null;
}

/** How a result differs from an earlier one (the ticket's triage before, or another run's). */
export function changeFrom(before: Decisions | null, after: Decisions): RunChange {
  const now = decisionKey(after);
  if (!before) return now ? 'new' : 'same';
  return decisionKey(before) === now ? 'same' : 'changed';
}

const FILTER_SQL: Record<RunFilter, string> = {
  all: '1',
  changed: `i.status = 'done' AND i.change IN ('changed', 'new')`,
  same: `i.status = 'done' AND i.change = 'same'`,
  skipped: `i.status IN ('skipped', 'failed')`,
};

export interface RunCounts {
  total: number;
  pending: number;
  skipped: number;
  changed: number;
  new: number;
  same: number;
  applying: number;
  applied: number;
  notApplied: number;
  /** Done and not applied yet, overall and per filter. */
  applicable: Record<RunFilter, number>;
  /** Applied (or not) since applying last started. */
  appliedSince: number;
  inputTokens: number;
  outputTokens: number;
  lastDoneAt: Date | null;
  lastApplyAt: Date | null;
}

export type RunItemView = RunItemRow & { ref: string; app_name: string; ticket_type_name: string | null; issue_number: number | null; repo_owner: string; repo_name: string; issue_title: string | null; issue_state: string | null };

/** GitHub calls a re-run leaves free for filing and normal triage: a fifth of the hourly budget, at least 500. */
const GITHUB_RESERVE = { share: 0.2, min: 500 };

/** A run's saved settings, read with today's defaults for anything added since. */
function withParsedConfig<T extends { config_used: TriageConfig }>(r: T): T {
  return { ...r, config_used: parseTriageConfig(r.config_used) };
}
const RERUN_ATTEMPTS = 3;

function isGitHubRateLimit(err: unknown): err is GitHubApiError {
  return err instanceof GitHubApiError && err.isRateLimit;
}

/** Tickets a re-run can pick: filed, issue not known to be closed, no triage action applied, not queued. */
function rerunWhere(scope: RerunScope): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const kinds = [
    scope.untouched ? `(r.status = 'done' AND json_array_length(COALESCE(r.applied_actions, '[]')) = 0)` : '',
    scope.never ? `(r.submission_id IS NULL OR r.status IN ('skipped', 'failed'))` : '',
  ].filter(Boolean);
  const where = [
    `s.status = 'created'`,
    's.issue_number IS NOT NULL',
    `NOT EXISTS (SELECT 1 FROM issue_index i WHERE i.repo_id = s.repo_id AND i.number = s.issue_number AND i.state = 'closed')`,
    kinds.length ? `(${kinds.join(' OR ')})` : '0',
  ];
  if (scope.appId) {
    params.push(scope.appId);
    where.push(`s.app_id = $${params.length + 1}`);
  }
  if (scope.typeName) {
    params.push(scope.typeName);
    where.push(`s.ticket_type_name = $${params.length + 1}`);
  }
  return { sql: `FROM submissions s LEFT JOIN triage_results r ON r.submission_id = s.id WHERE s.workspace_id = $1 AND ${where.join(' AND ')}`, params };
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
    const out = await this.evaluate(row.workspace_id, row.submission_id, settings.config);
    if (out.status === 'skip') return this.skip(row, out.reason, out.model ? { model: out.model } : {});
    if (out.status === 'retry') return this.retry(row, out.message);
    if (out.status === 'paused') return this.requeue(row);
    const { e } = out;
    const { applied, suggested, error, toldMember } = await this.applyAuto(e.sub, e.auto, e.suggested, true);
    await this.finish(row, {
      status: 'done',
      ...resultFields(e, applied, suggested),
      error,
      input_tokens: e.inputTokens,
      output_tokens: e.outputTokens,
      completed_at: new Date(),
    });
    await addEvent(deps.db, e.sub.id, 'triage_done', { applied: applied.map(describeAction), suggested: suggested.map(describeAction), told_member: toldMember });
    deps.log.info({ submission: e.sub.ref, applied: applied.length, suggested: suggested.length }, 'ticket triaged');
  }

  /** Applies the automatic actions on GitHub. If GitHub refuses, nothing is lost: they become suggestions. */
  private async applyAuto(sub: SubmissionRow, auto: TriageAction[], suggestions: TriageAction[], tell: boolean, o: { rateLimitThrows?: boolean } = {}) {
    const applied: TriageAction[] = [];
    const suggested = [...suggestions];
    let toldMember = false;
    let error: string | null = null;
    if (auto.length) {
      try {
        await applyToGitHub(this.deps, sub, auto);
        applied.push(...auto);
        if (tell) toldMember = await tellMember(this.deps, sub, auto);
      } catch (err) {
        // A re-run waits out GitHub's rate limit and tries again instead.
        if (o.rateLimitThrows && isGitHubRateLimit(err)) throw err;
        error = `Couldn’t update the GitHub issue: ${githubMessage(err)}`;
        suggested.unshift(...auto);
      }
    }
    return { applied, suggested, error, toldMember };
  }

  /**
   * Reads the ticket from GitHub, asks Claude and plans the actions with the given settings.
   * Changes nothing on GitHub; normal triage and re-runs both start here.
   */
  async evaluate(workspaceId: string, submissionId: string, base: TriageConfig): Promise<Outcome> {
    const { deps } = this;
    const skip = (reason: string, model?: string): Outcome => ({ status: 'skip', reason, model });
    const sub = await getSubmission(deps.db, workspaceId, submissionId);
    if (!sub || sub.status !== 'created' || !sub.issue_number) return skip('The ticket is no longer filed');
    if (base.appIds && !base.appIds.includes(sub.app_id ?? '')) return skip('Not in scope (app)');
    // The ticket type's rules switch actions off for this ticket; Claude is told which.
    const type = sub.ticket_type_name ? (await listTicketTypes(deps.db, workspaceId)).find((t) => t.name === sub.ticket_type_name) ?? null : null;
    const off = actionsOffFor(base, type);
    const c = withActionsOff(base, off);
    if (!anyActionOn(c)) return skip(off.size >= allActionKeys(base).length ? 'Not in scope (ticket type)' : 'No triage actions are turned on');
    const usage = await monthlyUsage(deps.db, workspaceId);
    if (usage.triaged >= c.monthlyLimit) return skip('Monthly limit reached');
    const key = await resolveApiKey(deps, workspaceId);
    if (!key) {
      await pauseTriage(deps.db, workspaceId, 'no_key', null);
      return { status: 'paused' };
    }
    if (!deps.github) return skip('GitHub isn’t configured');
    const conn = await getGitHubConnection(deps.db, workspaceId);
    const inst = conn?.installation_id ?? sub.installation_id;

    // The ticket text lives in the GitHub issue (it's removed from our database once filed).
    let issue: IssueDetail;
    try {
      issue = await deps.github.getIssueDetail(inst, sub.repo_owner, sub.repo_name, sub.issue_number);
    } catch (err) {
      if (err instanceof GitHubApiError && [403, 404, 410].includes(err.status) && !err.isRateLimit) return skip('The GitHub issue no longer exists or can’t be read');
      if (isGitHubRateLimit(err)) return { status: 'retry', message: 'GitHub rate limit', waitSeconds: err.retryAfterSeconds ?? 60, waitFor: 'github' };
      return { status: 'retry', message: `GitHub unavailable: ${githubMessage(err)}` };
    }
    if (issue.state === 'closed') return skip('The issue was already closed on GitHub');

    const apps = await listApps(deps.db, workspaceId);
    const own = `${sub.repo_owner}/${sub.repo_name}`;
    const repoRef: RepoRef = { repo_id: sub.repo_id, owner: sub.repo_owner, name: sub.repo_name, installation_id: inst };
    const candidates = await this.findCandidates(issue, repoRef, c, apps);
    const appNames = [...new Set(apps.map((a) => a.name))];
    // Groups that are off everywhere aren't asked about; groups off for this type are listed as off.
    const groups = c.labelGroups.filter((g) => base.labelGroups.find((b) => b.id === g.id)?.mode !== 'off');
    const groupsOff = groups.filter((g) => g.mode === 'off').map((g) => g.id);
    const title = decryptPayload(deps.box, sub)?.title ?? issue.title;
    let result;
    try {
      result = await this.ai.classify(
        key.key,
        c.model,
        systemPromptFor(base, apps),
        buildUserPrompt(
          { app: sub.app_name, type: sub.ticket_type_name, title, description: extractDescription(issue.body) },
          candidates,
          [...off].filter((k) => !k.startsWith('group:')),
          groupsOff,
        ),
        verdictSchema({ groups, apps: appNames }),
      );
    } catch (err) {
      const e = err instanceof TriageAiError ? err : new TriageAiError('retry', (err as Error).message);
      if (e.action === 'pause') {
        await pauseTriage(deps.db, workspaceId, e.pauseReason ?? 'rejected', e.message);
        // Settings › Claude API shows the key's problem too.
        if (key.source === 'workspace' && (e.pauseReason === 'key_invalid' || e.pauseReason === 'credits')) await recordKeyCheck(deps.db, workspaceId, stateFromPause(e.pauseReason), e.message);
        deps.log.warn({ workspace: workspaceId, reason: e.pauseReason }, 'triage paused');
        return { status: 'paused' };
      }
      if (e.action === 'skip') return skip(e.message, c.model);
      return e.retryAfterSeconds ? { status: 'retry', message: e.message, waitSeconds: e.retryAfterSeconds, waitFor: 'claude' } : { status: 'retry', message: e.message };
    }

    if (key.source === 'workspace') await recordKeyCheck(deps.db, workspaceId, 'working', null).catch(() => {});
    const verdict = normalizeVerdict(result.verdict, {
      sameRepo: new Map(candidates.filter((x) => x.sameRepo).map((x) => [x.number, { state: x.state }])),
      refs: new Set(candidates.map((x) => x.ref)),
      apps: appNames,
      groups: groups.filter((g) => g.mode !== 'off'),
    });
    if (verdict.duplicates.length && c.duplicate.mode !== 'off') await this.pickOriginal(verdict, repoRef);
    const dc = await getDiscordConnection(deps.db, workspaceId);
    const ctx: TemplateContext = { app: sub.app_name, repoUrl: `https://github.com/${own}`, repo: own, guildId: dc?.guild_id ?? null, helpChannel: c.helpChannel };
    const { auto, suggested } = planActions(verdict, c, ctx, new Map(apps.map((a) => [a.name, `${a.repo_owner}/${a.repo_name}`])));
    return { status: 'done', e: { sub, verdict, auto, suggested, config: c, inputTokens: result.inputTokens, outputTokens: result.outputTokens } };
  }

  /**
   * Issues Claude compares the ticket with: the best matches in its own repository from our
   * copy of every issue, and, for related and shared problems, a few from the workspace's other
   * repositories (never used as duplicates).
   */
  private async findCandidates(issue: IssueDetail, repo: RepoRef, c: TriageConfig, apps: AppRow[]): Promise<Candidate[]> {
    const { deps } = this;
    const own = `${repo.owner}/${repo.name}`;
    const on = (k: Flag) => c[k].mode !== 'off';
    if (!on('duplicate') && !on('regression') && !on('related') && !on('shared')) return [];
    const same = new Map<number, Candidate>();
    const index = await this.indexer.refresh(repo).catch(() => null);
    const query = ftsQuery(issue.title, extractDescription(issue.body));
    await upsertIssues(deps.db, repo.repo_id, [issue]).catch(() => {});
    if (query) {
      try {
        const hits = await searchIndex(deps.db, { repoIds: [repo.repo_id], query, limit: INDEX_CANDIDATES, exclude: { repoId: repo.repo_id, number: issue.number } });
        for (const h of hits) same.set(h.number, fromIndexed(h, own, true));
      } catch {
        // Triage continues without these.
      }
    }
    // While the first load is still running, also use GitHub's recent issues and search.
    if (index?.status !== 'ready' && deps.github) {
      const extra: IssueDetail[] = [];
      try {
        extra.push(...(await deps.github.listRecentIssues(repo.installation_id, repo.owner, repo.name, 'open', 30)));
      } catch {
        // Best effort.
      }
      const terms = searchTerms(issue.title);
      if (terms) {
        try {
          extra.push(...(await deps.github.searchIssues(repo.installation_id, repo.owner, repo.name, terms, 10)));
        } catch {
          // Search is rate limited separately; skip it this time.
        }
      }
      for (const i of extra) if (!same.has(i.number)) same.set(i.number, fromIssue(i, own));
      await upsertIssues(deps.db, repo.repo_id, extra).catch(() => {});
    }
    same.delete(issue.number);
    const out = [...same.values()].slice(0, MAX_CANDIDATES - OTHER_REPO_CANDIDATES);
    const others = new Map(apps.filter((a) => a.repo_id !== repo.repo_id).map((a) => [a.repo_id, `${a.repo_owner}/${a.repo_name}`]));
    if (query && others.size && (on('related') || on('shared'))) {
      try {
        const hits = await searchIndex(deps.db, { repoIds: [...others.keys()], query, limit: OTHER_REPO_CANDIDATES });
        for (const h of hits) out.push(fromIndexed(h, others.get(h.repo_id)!, false));
      } catch {
        // Best effort.
      }
    }
    return out;
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

  // ---- Re-runs ----------------------------------------------------------------------------

  /** How many tickets a re-run with this scope would pick (before the limit). */
  async countRerun(workspaceId: string, scope: RerunScope): Promise<number> {
    const w = rerunWhere(scope);
    const { rows } = await this.deps.db.query<{ n: number }>(`SELECT count(*) AS n ${w.sql}`, [workspaceId, ...w.params]);
    return rows[0]?.n ?? 0;
  }

  /**
   * Starts a re-run with the current settings (saved with the run). A preview only records what
   * triage would do; an "apply" run applies it like normal triage. One run at a time.
   */
  async startRun(workspaceId: string, userId: string, o: { mode: 'preview' | 'apply'; name: string | null; scope: RerunScope }): Promise<TriageRunRow> {
    const { db } = this.deps;
    const settings = await getTriageSettings(db, workspaceId);
    if (o.mode === 'apply' && !settings.enabled) throw new UserFacingError('Turn triage on to apply results. A preview works while it’s off.');
    if (!anyActionOn(settings.config)) throw new UserFacingError('Turn at least one triage action on first.');
    if (!(await resolveApiKey(this.deps, workspaceId))) throw new UserFacingError('Add a Claude API key in Settings first.');
    const { rows: running } = await db.query('SELECT id FROM triage_runs WHERE workspace_id = $1 AND status = $2', [workspaceId, 'running']);
    if (running.length) throw new UserFacingError('A re-run is already going. Wait for it to finish or stop it.', 409);
    const usage = await monthlyUsage(db, workspaceId);
    const left = settings.config.monthlyLimit - usage.triaged;
    if (left <= 0) throw new UserFacingError('This month’s triage limit is used up. Raise the monthly limit to re-run.');
    const matched = await this.countRerun(workspaceId, o.scope);
    if (!matched) throw new UserFacingError('No open tickets match. Change which tickets to include.');
    const limit = Math.max(1, Math.min(o.scope.limit, MAX_RERUN, left));
    const scope: RerunScope = { ...o.scope, limit, matched };
    const w = rerunWhere(scope);
    const id = randomUUID();
    const runParam = w.params.length + 2;
    // Every matching ticket is queued at once, newest first, with its triage so far to compare with.
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO triage_runs (id, workspace_id, name, mode, scope, config_used, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, workspaceId, o.name, o.mode, scope, settings.config, userId]);
      await tx.query(
        `INSERT INTO triage_run_items (run_id, submission_id, position, before)
         SELECT $${runParam}, s.id, row_number() OVER (ORDER BY s.completed_at DESC, s.rowid DESC) - 1,
           CASE WHEN r.status IS NULL THEN NULL ELSE json_object(
             'status', r.status, 'applied', json(COALESCE(r.applied_actions, '[]')), 'suggestions', json(COALESCE(r.suggestions, '[]')),
             'reason', json_extract(r.verdict, '$.reason'), 'skipReason', r.skip_reason, 'model', r.model) END
         ${w.sql} ORDER BY s.completed_at DESC, s.rowid DESC LIMIT $${runParam + 1}`,
        [workspaceId, ...w.params, id, limit],
      );
    });
    return (await this.getRun(workspaceId, id))!;
  }

  async getRun(workspaceId: string, runId: string): Promise<TriageRunRow | null> {
    const { rows } = await this.deps.db.query<TriageRunRow>('SELECT * FROM triage_runs WHERE workspace_id = $1 AND id = $2', [workspaceId, runId]);
    return rows[0] ? withParsedConfig(rows[0]) : null;
  }

  async listRuns(workspaceId: string, limit = 20): Promise<(TriageRunRow & { total: number; done: number; skipped: number; failed: number; pending: number; applying: number; applied: number; input_tokens: number | null; output_tokens: number | null })[]> {
    const { rows } = await this.deps.db.query<TriageRunRow & { total: number; done: number; skipped: number; failed: number; pending: number; applying: number; applied: number; input_tokens: number | null; output_tokens: number | null }>(
      `SELECT r.*, count(i.submission_id) AS total,
         sum(i.status = 'done') AS done, sum(i.status = 'skipped') AS skipped, sum(i.status = 'failed') AS failed, sum(i.status = 'pending') AS pending,
         sum(i.apply_status = 'pending') AS applying, sum(i.apply_status = 'done') AS applied,
         sum(i.input_tokens) AS input_tokens, sum(i.output_tokens) AS output_tokens
       FROM triage_runs r LEFT JOIN triage_run_items i ON i.run_id = r.id
       WHERE r.workspace_id = $1 GROUP BY r.id ORDER BY r.created_at DESC LIMIT $2`,
      [workspaceId, limit],
    );
    return rows.map(withParsedConfig);
  }

  async runItems(runId: string): Promise<RunItemView[]> {
    const { rows } = await this.deps.db.query<RunItemView>(
      `SELECT i.*, s.ref, s.app_name, s.ticket_type_name, s.issue_number, s.repo_owner, s.repo_name, x.title AS issue_title, x.state AS issue_state
       FROM triage_run_items i JOIN submissions s ON s.id = i.submission_id
       LEFT JOIN issue_index x ON x.repo_id = s.repo_id AND x.number = s.issue_number
       WHERE i.run_id = $1 ORDER BY i.position`,
      [runId],
    );
    return rows;
  }

  /** One page of a run's tickets, in order. */
  async runPage(runId: string, filter: RunFilter, limit: number, offset: number): Promise<RunItemView[]> {
    const { rows } = await this.deps.db.query<RunItemView>(
      `SELECT i.*, s.ref, s.app_name, s.ticket_type_name, s.issue_number, s.repo_owner, s.repo_name, x.title AS issue_title, x.state AS issue_state
       FROM triage_run_items i JOIN submissions s ON s.id = i.submission_id
       LEFT JOIN issue_index x ON x.repo_id = s.repo_id AND x.number = s.issue_number
       WHERE i.run_id = $1 AND ${FILTER_SQL[filter]} ORDER BY i.position LIMIT $2 OFFSET $3`,
      [runId, limit, offset],
    );
    return rows;
  }

  /** Progress and results of a run, counted in the database (runs can have thousands of tickets). */
  async runCounts(runId: string, applyingSince: Date | null = null): Promise<RunCounts> {
    const { db } = this.deps;
    // Results from before the comparison was stored get it now.
    const { rows: old } = await db.query<RunItemRow>(`SELECT submission_id, before, auto_actions, suggestions FROM triage_run_items WHERE run_id = $1 AND status = 'done' AND change IS NULL`, [runId]);
    for (const i of old) {
      await db.query('UPDATE triage_run_items SET change = $3 WHERE run_id = $1 AND submission_id = $2', [runId, i.submission_id, changeFrom(beforeDecisions(i.before), { auto: i.auto_actions ?? [], suggested: i.suggestions ?? [] })]);
    }
    const open = `(i.apply_status IS NULL OR i.apply_status = 'failed')`;
    const { rows } = await db.query<Record<string, number | null> & { last_done_at: Date | null; last_apply_at: Date | null }>(
      `SELECT count(*) AS total, sum(i.status = 'pending') AS pending, sum(i.status IN ('skipped', 'failed')) AS skipped,
         sum(i.status = 'done' AND i.change = 'changed') AS changed, sum(i.status = 'done' AND i.change = 'new') AS new_, sum(i.status = 'done' AND i.change = 'same') AS same,
         sum(i.apply_status = 'pending') AS applying, sum(i.apply_status = 'done') AS applied, sum(i.apply_status IN ('skipped', 'failed')) AS not_applied,
         sum(i.status = 'done' AND ${open}) AS a_all, sum(${FILTER_SQL.changed} AND ${open}) AS a_changed, sum(${FILTER_SQL.same} AND ${open}) AS a_same,
         sum(i.apply_done_at >= $2) AS applied_since,
         sum(i.input_tokens) AS input_tokens, sum(i.output_tokens) AS output_tokens, max(i.completed_at) AS last_done_at, max(i.apply_done_at) AS last_apply_at
       FROM triage_run_items i WHERE i.run_id = $1`,
      [runId, applyingSince ?? new Date(8.64e15)],
    );
    const r = rows[0]!;
    const n = (k: string) => Number(r[k] ?? 0);
    return {
      total: n('total'), pending: n('pending'), skipped: n('skipped'), changed: n('changed'), new: n('new_'), same: n('same'),
      applying: n('applying'), applied: n('applied'), notApplied: n('not_applied'),
      applicable: { all: n('a_all'), changed: n('a_changed'), same: n('a_same'), skipped: 0 },
      appliedSince: n('applied_since'),
      inputTokens: n('input_tokens'), outputTokens: n('output_tokens'), lastDoneAt: r.last_done_at, lastApplyAt: r.last_apply_at,
    };
  }

  /** Stops applying a preview: tickets not reached yet go back to not applied, so they can be applied later. */
  async stopApplying(workspaceId: string, runId: string): Promise<number> {
    if (!(await this.getRun(workspaceId, runId))) throw new UserFacingError('That re-run wasn’t found.', 404);
    const res = await this.deps.db.query(`UPDATE triage_run_items SET apply_status = NULL, apply_suggestions = 0, apply_inbox_only = 0 WHERE run_id = $1 AND apply_status = 'pending' AND (lease_until_at IS NULL OR lease_until_at < now_ms())`, [runId]);
    return res.rowCount;
  }

  /** Stops a running re-run; tickets not reached yet are skipped. Results so far are kept. */
  async cancelRun(workspaceId: string, runId: string): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const res = await tx.query(`UPDATE triage_runs SET status = 'cancelled', finished_at = now_ms() WHERE workspace_id = $1 AND id = $2 AND status = 'running'`, [workspaceId, runId]);
      if (!res.rowCount) throw new UserFacingError('That re-run already finished.', 409);
      await tx.query(`UPDATE triage_run_items SET status = 'skipped', note = 'Stopped before this ticket', lease_until_at = NULL WHERE run_id = $1 AND status = 'pending'`, [runId]);
      await tx.query(`UPDATE triage_run_items SET apply_status = 'skipped', apply_note = 'Stopped before this ticket' WHERE run_id = $1 AND apply_status = 'pending'`, [runId]);
    });
  }

  async deleteRun(workspaceId: string, runId: string): Promise<void> {
    const res = await this.deps.db.query(`DELETE FROM triage_runs WHERE workspace_id = $1 AND id = $2 AND status <> 'running' AND NOT EXISTS (SELECT 1 FROM triage_run_items WHERE run_id = $2 AND apply_status = 'pending')`, [workspaceId, runId]);
    if (!res.rowCount) throw new UserFacingError('A re-run can’t be deleted while it’s going.', 409);
  }

  /**
   * Applies a preview's results: the tickets picked, or every result in a filter. Each ticket's
   * result replaces its old one and its automatic actions (and, if asked, its suggestions) are
   * applied on GitHub. Queued: the worker applies them one at a time.
   */
  async applyPreview(workspaceId: string, runId: string, userId: string, o: { ids?: string[]; filter?: RunFilter; mode: ApplyMode }): Promise<number> {
    const { db } = this.deps;
    const run = await this.getRun(workspaceId, runId);
    if (!run || run.mode !== 'preview') throw new UserFacingError('That re-run wasn’t found.', 404);
    if (run.status === 'running') throw new UserFacingError('Wait for the preview to finish, or stop it, first.', 409);
    const settings = await getTriageSettings(db, workspaceId);
    if (o.mode !== 'inbox' && !settings.enabled) throw new UserFacingError('Turn triage on to apply results on GitHub.');
    if (!o.ids?.length && !o.filter) throw new UserFacingError('Select the results to apply.');
    const res = await db.query(
      `UPDATE triage_run_items AS i SET apply_status = 'pending', apply_note = NULL, apply_suggestions = $3, apply_inbox_only = $4, lease_until_at = NULL
       WHERE i.run_id = $1 AND i.status = 'done' AND (i.apply_status IS NULL OR i.apply_status = 'failed')
         AND ${o.ids?.length ? 'i.submission_id IN (SELECT value FROM json_each($2))' : `$2 IS NULL AND ${FILTER_SQL[o.filter ?? 'all']}`}`,
      [runId, o.ids?.length ? JSON.stringify(o.ids) : null, o.mode === 'all' ? 1 : 0, o.mode === 'inbox' ? 1 : 0],
    );
    if (!res.rowCount) throw new UserFacingError('There’s nothing left to apply here.', 409);
    await db.query('UPDATE triage_runs SET applied_at = now_ms(), applied_by = $2 WHERE id = $1', [runId, userId]);
    return res.rowCount;
  }

  /** Claims the next re-run ticket to evaluate, or a result to apply (paused workspaces wait). */
  async claimRunItem(): Promise<{ item: RunItemRow; job: 'evaluate' | 'apply' } | null> {
    for (const job of ['apply', 'evaluate'] as const) {
      const cond = job === 'evaluate'
        ? `i.status = 'pending' AND r.status = 'running' AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= now_ms())`
        : `i.apply_status = 'pending'`;
      const { rows } = await this.deps.db.query<RunItemRow>(
        `UPDATE triage_run_items SET lease_until_at = now_ms() + ($1 * 1000), attempts = attempts + ${job === 'evaluate' ? 1 : 0}
         WHERE rowid = (
           SELECT i.rowid FROM triage_run_items i JOIN triage_runs r ON r.id = i.run_id
           LEFT JOIN triage_settings t ON t.workspace_id = r.workspace_id
           WHERE ${cond} AND (i.lease_until_at IS NULL OR i.lease_until_at < now_ms()) AND t.paused_reason IS NULL
             AND (r.waiting_until_at IS NULL OR r.waiting_until_at <= now_ms())
           ORDER BY r.created_at, i.position LIMIT 1
         )
         RETURNING *`,
        [LEASE_SECONDS],
      );
      if (rows[0]) return { item: rows[0], job };
    }
    return null;
  }

  /** Whether a re-run should wait to keep GitHub calls free for filing: until the budget resets, or null. */
  private githubWait(installationId: number): Date | null {
    const rl = this.deps.github?.rateLimitFor(installationId);
    if (!rl) return null;
    const reserve = Math.max(GITHUB_RESERVE.min, Math.round(rl.limit * GITHUB_RESERVE.share));
    return rl.remaining < reserve ? new Date(rl.resetAt.getTime() + 5_000) : null;
  }

  /** Pauses a run for a rate limit and puts the ticket back without counting the attempt. */
  private async waitRun(run: TriageRunRow, item: RunItemRow, until: Date, reason: 'github' | 'claude', uncount: boolean): Promise<void> {
    const { db } = this.deps;
    await db.query('UPDATE triage_runs SET waiting_until_at = $2, waiting_reason = $3 WHERE id = $1', [run.id, until, reason]);
    await db.query('UPDATE triage_run_items SET lease_until_at = NULL, attempts = $3 WHERE run_id = $1 AND submission_id = $2', [run.id, item.submission_id, uncount ? Math.max(0, item.attempts - 1) : item.attempts]);
    this.deps.log.info({ run: run.id, until, reason }, 're-run waiting for a rate limit');
  }

  async processRunItem(claimed: { item: RunItemRow; job: 'evaluate' | 'apply' }): Promise<void> {
    const { item, job } = claimed;
    const { db } = this.deps;
    const { rows } = await db.query<TriageRunRow>('SELECT * FROM triage_runs WHERE id = $1', [item.run_id]);
    if (!rows[0]) return;
    const run = withParsedConfig(rows[0]);
    const set = (fields: Record<string, unknown>) => {
      const entries = Object.entries({ ...fields, lease_until_at: null });
      return db.query(`UPDATE triage_run_items SET ${entries.map(([k], i) => `${k} = $${i + 3}`).join(', ')} WHERE run_id = $1 AND submission_id = $2`, [item.run_id, item.submission_id, ...entries.map(([, v]) => v)]);
    };
    const applied = (r: { status: string; note: string | null }) => set({ apply_status: r.status, apply_note: r.note, apply_done_at: new Date() });
    try {
      // Filing and normal triage share GitHub's hourly budget: leave them room.
      const conn = await getGitHubConnection(db, run.workspace_id);
      const needsGitHub = !(job === 'apply' && item.apply_inbox_only);
      const githubWait = conn && needsGitHub ? this.githubWait(conn.installation_id) : null;
      if (githubWait) return await this.waitRun(run, item, githubWait, 'github', job === 'evaluate');
      if (run.waiting_until_at) await db.query('UPDATE triage_runs SET waiting_until_at = NULL, waiting_reason = NULL WHERE id = $1', [run.id]);

      if (job === 'apply') {
        await applied(await this.commitItem(run, item, run.applied_by));
        return;
      }
      const out = await this.evaluate(run.workspace_id, item.submission_id, run.config_used);
      if (out.status === 'skip') await set({ status: 'skipped', note: out.reason, model: out.model ?? null, completed_at: new Date() });
      else if (out.status === 'paused') await set({ attempts: Math.max(0, item.attempts - 1) });
      else if (out.status === 'retry' && out.waitSeconds) await this.waitRun(run, item, new Date(Date.now() + out.waitSeconds * 1000), out.waitFor ?? 'claude', true);
      else if (out.status === 'retry') {
        await set(item.attempts >= RERUN_ATTEMPTS
          ? { status: 'failed', note: out.message, completed_at: new Date() }
          : { note: out.message, next_attempt_at: new Date(Date.now() + 60_000 * item.attempts) });
      } else {
        const { e } = out;
        const done: RunItemRow = { ...item, verdict: e.verdict, auto_actions: e.auto, suggestions: e.suggested };
        const change = changeFrom(beforeDecisions(item.before), { auto: e.auto, suggested: e.suggested });
        await set({ status: 'done', note: null, change, verdict: e.verdict, auto_actions: e.auto, suggestions: e.suggested, model: e.config.model, input_tokens: e.inputTokens, output_tokens: e.outputTokens, completed_at: new Date() });
        if (run.mode === 'apply') {
          try {
            await applied(await this.commitItem(run, done, run.created_by, e));
          } catch (err) {
            if (!isGitHubRateLimit(err)) throw err;
            // Evaluated already: it's applied once GitHub's limit resets.
            await set({ apply_status: 'pending' });
            await this.waitRun(run, item, new Date(Date.now() + (err.retryAfterSeconds ?? 60) * 1000), 'github', false);
          }
        }
      }
    } catch (err) {
      if (isGitHubRateLimit(err)) {
        await this.waitRun(run, item, new Date(Date.now() + (err.retryAfterSeconds ?? 60) * 1000), 'github', job === 'evaluate');
        return;
      }
      this.deps.log.error({ err: (err as Error).message, run: run.id, submission: item.submission_id }, 're-run failed unexpectedly');
      if (job === 'apply') await applied({ status: 'failed', note: 'Unexpected error' });
      else await set({ status: 'failed', note: 'Unexpected error', completed_at: new Date() });
    } finally {
      await db.query(
        `UPDATE triage_runs SET status = 'done', finished_at = now_ms(), waiting_until_at = NULL, waiting_reason = NULL WHERE id = $1 AND status = 'running'
           AND NOT EXISTS (SELECT 1 FROM triage_run_items WHERE run_id = $1 AND status = 'pending')`,
        [run.id],
      );
    }
  }

  /**
   * Makes a re-run's result the ticket's triage result: its automatic actions are applied on
   * GitHub and its suggestions replace the old ones. Skipped when something changed since:
   * actions were applied, the ticket is being triaged, or the issue was closed.
   */
  private async commitItem(run: TriageRunRow, item: RunItemRow, userId: string | null, fresh?: Evaluation): Promise<{ status: 'done' | 'skipped' | 'failed'; note: string | null }> {
    const { deps } = this;
    const sub = fresh?.sub ?? (await getSubmission(deps.db, run.workspace_id, item.submission_id));
    if (!sub || sub.status !== 'created' || !sub.issue_number) return { status: 'skipped', note: 'The ticket is no longer filed' };
    const current = await this.getResult(run.workspace_id, item.submission_id);
    if (current?.status === 'pending') return { status: 'skipped', note: 'Triage is running on this ticket' };
    if ((current?.applied_actions ?? []).length) return { status: 'skipped', note: 'Actions were applied to this ticket since the run started' };
    // Approved in bulk: the suggestions are applied too. Inbox only: everything is a suggestion.
    const inboxOnly = !fresh && item.apply_inbox_only;
    const withSuggestions = !fresh && item.apply_suggestions && !inboxOnly;
    const all = [...(item.auto_actions ?? []), ...(item.suggestions ?? [])];
    const auto = inboxOnly ? [] : withSuggestions ? all : item.auto_actions ?? [];
    const suggestedIn = inboxOnly ? all : withSuggestions ? [] : item.suggestions ?? [];
    if (!fresh && auto.length && deps.github) {
      // A preview may be old: don't act on an issue closed since.
      try {
        const conn = await getGitHubConnection(deps.db, run.workspace_id);
        const live = await deps.github.getIssueDetail(conn?.installation_id ?? sub.installation_id, sub.repo_owner, sub.repo_name, sub.issue_number);
        if (live.state === 'closed') return { status: 'skipped', note: 'The issue was closed since the preview' };
      } catch (err) {
        if (isGitHubRateLimit(err)) throw err;
        return { status: 'failed', note: `GitHub unavailable: ${githubMessage(err)}` };
      }
    }
    const e: Evaluation = fresh ?? { sub, verdict: item.verdict!, auto, suggested: suggestedIn, config: run.config_used, inputTokens: 0, outputTokens: 0 };
    const { applied, suggested, error } = await this.applyAuto(sub, auto, e.suggested, false, { rateLimitThrows: true });
    const fields = { ...resultFields(e, applied, suggested), error };
    const cols = Object.keys(fields);
    // Tokens stay counted on the run, so a new row has none (the monthly count includes runs).
    await deps.db.query(
      `INSERT INTO triage_results (submission_id, workspace_id, status, completed_at, ${cols.join(', ')})
       VALUES ($1, $2, 'done', now_ms(), ${cols.map((_, i) => `$${i + 3}`).join(', ')})
       ON CONFLICT (submission_id) DO UPDATE SET status = 'done', skip_reason = NULL, lease_owner = NULL, lease_until_at = NULL, next_attempt_at = NULL,
         ${cols.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = now_ms()`,
      [sub.id, run.workspace_id, ...Object.values(fields)],
    );
    await addEvent(deps.db, sub.id, 'triage_rerun', { by: userId, applied: applied.map(describeAction), suggested: suggested.map(describeAction) });
    return error ? { status: 'failed', note: `${error}. Kept as suggestions.` } : { status: 'done', note: null };
  }
}

/** Triage summaries for a page of tickets (inbox priority column). */
export async function triageSummaries(q: Queryable, workspaceId: string, ids: string[]): Promise<Map<string, Pick<TriageResultRow, 'status' | 'priority' | 'is_duplicate' | 'is_spam' | 'is_support' | 'suggestion_count' | 'suggestions'>>> {
  if (!ids.length) return new Map();
  const { rows } = await q.query<TriageResultRow>(
    'SELECT submission_id, status, priority, is_duplicate, is_spam, is_support, suggestion_count, suggestions FROM triage_results WHERE workspace_id = $1 AND submission_id IN (SELECT value FROM json_each($2))',
    [workspaceId, ids],
  );
  return new Map(rows.map((r) => [r.submission_id, r]));
}
