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
import { cleanUpSpam, fileCounts, screenshotsFor } from '../domain/files.js';
import { decryptPayload, getSubmission, addEvent } from '../domain/submissions.js';
import { getDiscordConnection, getGitHubConnection, listApps } from '../domain/store.js';
import { MARKER_PREFIX, neutralizeGitHubMentions } from '../github/issue-content.js';
import { labelColor } from '../domain/ticket-types.js';
import { UserFacingError, type AppRow, type Deps, type SubmissionRow } from '../domain/types.js';
import { GitHubApiError, type IssueDetail } from '../github/client.js';
import { normalizeVerdict, TriageAiError, verdictSchema, type TicketImage, type TriageAi, type Verdict } from './ai.js';
import { knowledgeTexts, listKnowledge, type AppKnowledge } from './knowledge.js';
import { KnowledgeWriter } from './knowledge-writer.js';
import { ChangeTracker, recentChanges, type AppChange } from './knowledge-changes.js';
import { RepoStatusTracker } from '../repo-status/tracker.js';
import { AnalyticsRecorder } from '../analytics/recorder.js';
import { Announcer } from '../announcements/announcer.js';
import { KnownIssuesUpdater } from '../bot-features/known-issues.js';
import { actionMatcher } from './state.js';
import { buildKnowledgeBlock, buildSystemPrompt, buildUserPrompt, extractDescription, searchTerms, type Candidate } from './prompt.js';
import { findWork, type WorkItem, type WorkRef } from './work.js';
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
  workOn,
  MISSING_TEXT,
  NOTIFIABLE,
  anyActionOn,
  getTriageSettings,
  monthlyUsage,
  parseTriageConfig,
  pauseTriage,
  recordPauseCheck,
  resolveApiKey,
  resumeTriage,
  autoChecked,
  AUTO_CHECK_MS,
  type PauseReason,
  forGitHub,
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
  /** Being worked on: the open pull request. Already fixed: the merged pull request or commit (and its release). */
  work?: WorkRef;
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
    // GitHub links "#12" and a commit's sha in the same repository by itself.
    pull: a.work ? (target === 'github' ? a.work.ref : `[${a.work.ref}](${a.work.url})`) : 'a pull request',
    fix: a.work ? (target === 'github' ? a.work.ref : `[${a.work.ref}](${a.work.url})`) : 'an earlier change',
    release: a.work?.release ? `it’s in ${name(a.work.release)}` : a.work?.release === null ? 'it will be in the next release' : 'it’s merged',
    help_channel: channel && ctx.guildId
      ? target === 'github' ? `[#${channel.name} on Discord](https://discord.com/channels/${ctx.guildId}/${channel.id})` : `<#${channel.id}>`
      : 'our Discord server',
  };
  return template.replace(/\{(app|duplicate|regression|missing|parts|related|shared_apps|shared_issue|right_app|right_repo|help_channel|pull|fix|release)\}/g, (_m, k: string) => vars[k]!).trim();
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
  /** Suggestions someone dismissed (Reviewed vs Nothing to do). */
  dismissed_count: number;
  skip_reason: string | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** Team-only: what Claude says would have made it surer (a copy of verdict.missing_context). */
  question: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const LEASE_SECONDS = 180;
/** Screenshots Claude is shown per ticket when Screenshots is on. */
const MAX_SCREENSHOTS = 5;
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
    const duplicate = v.duplicate_of !== null && v.duplicate_of !== regression;
    if (duplicate) add('duplicate', v.duplicate_confidence, { duplicateOf: v.duplicate_of!, ...(v.duplicate_closed ? { originalClosed: true } : {}) });
    // A fix that didn't hold is a regression; one that did makes asking for details pointless.
    const fixed = regression === null && v.fixed_work && on('fixed') ? v.fixed_work : null;
    if (fixed) add('fixed', v.fixed_confidence ?? 0, { work: fixed });
    else if (v.in_progress_work) add('inProgress', v.in_progress_confidence ?? 0, { work: v.in_progress_work });
    if (!duplicate && v.needs_info && !notDev && regression === null && !fixed) add('needsInfo', v.needs_info_confidence, { missing: v.missing ?? [] });
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
    : a.kind === 'inProgress' ? `being worked on in ${a.work?.ref ?? 'a pull request'}`
    : a.kind === 'fixed' ? `fixed in ${a.work?.ref ?? 'an earlier change'}${a.work?.release ? ` (${a.work.release})` : a.work?.release === null ? ', not released yet' : ''}`
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

/** What triage works on: a Discord ticket, or an issue opened directly on GitHub. */
export type Subject = { kind: 'ticket'; submissionId: string } | { kind: 'issue'; repoId: number; number: number };

/** An issue opened on GitHub, as triage acts on it (a ticket's submission row has the same fields). */
export interface IssueTarget {
  kind: 'issue';
  workspace_id: string;
  installation_id: number;
  repo_id: number;
  repo_owner: string;
  repo_name: string;
  issue_number: number;
  /** "owner/repo#12", for logs. */
  ref: string;
}

export type Target = SubmissionRow | IssueTarget;

/** The ticket behind a target, or null for an issue opened on GitHub. */
export function ticketOf(t: Target): SubmissionRow | null {
  return (t as IssueTarget).kind === 'issue' ? null : (t as SubmissionRow);
}

/** Adds the actions' labels (creating missing ones), posts one comment from the admins' templates, and closes if asked. */
export async function applyToGitHub(deps: Deps, sub: Target, actions: TriageAction[]): Promise<void> {
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
  const ticket = ticketOf(sub);
  if (ticket && actions.some((a) => a.kind === 'spam' && a.close)) {
    // Spam files aren't kept around when the cleanup rules say so.
    await cleanUpSpam(deps, ticket).catch((err) => deps.log.warn({ submission: ticket.ref, err: (err as Error).message }, 'could not delete spam files'));
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
    { apps: apps.map((a) => ({ name: a.name, repo: `${a.repo_owner}/${a.repo_name}`, description: a.description ?? '' })), work: workOn(c) },
  );
}

/**
 * The TRIAGE.md block sent after the instructions: the ticket's app, or for an issue opened on
 * GitHub every app in its repository. Empty when none of them has one.
 */
export function knowledgePromptFor(apps: AppRow[], knowledge: Map<string, AppKnowledge>, appIds: (string | null)[], changes: Map<string, AppChange[]> = new Map()): string {
  return buildKnowledgeBlock(knowledgeTexts(apps, knowledge, appIds, new Map([...changes].map(([id, list]) => [id, list.map(changeLine)]))));
}

/** "- #456, merged 2026-10-14: Fix blank right page in PNG export (closes #412)". Dates, not "2 days ago", so the cached prompt stays the same. */
function changeLine(c: AppChange): string {
  const what = c.kind === 'pr' ? `#${c.ref}, merged` : c.kind === 'commit' ? `commit ${c.ref.slice(0, 7)}, pushed` : `release ${c.ref}, published`;
  return `- ${what} ${c.merged_at.toISOString().slice(0, 10)}: ${c.title.replace(/\s+/g, ' ').slice(0, 160)}${c.closes.length ? ` (closes ${c.closes.map((x) => `#${x}`).join(', ')})` : ''}`;
}

/** What one triage pass decided for a ticket. Nothing is applied yet. */
export interface Evaluation {
  /** The ticket, or the issue opened on GitHub. */
  target: Target;
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
    question: v.missing_context ?? null,
  };
}

// ---- Re-runs ------------------------------------------------------------------------------

/** Which re-run candidates: tickets from Discord, issues opened on GitHub, or both. */
export type RerunSource = 'tickets' | 'github' | 'all';

export interface RerunScope {
  /** Runs saved before GitHub issues existed have no source: Discord tickets. */
  source?: RerunSource;
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
  /** 'sub:<submission id>' for a ticket, 'gh:<repo id>:<number>' for an issue opened on GitHub. */
  subject: string;
  submission_id: string | null;
  gh_repo_id: number | null;
  gh_number: number | null;
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

/** What applying one re-run result did. */
type CommitResult = { status: 'done' | 'skipped' | 'failed'; note: string | null; applied?: TriageAction[]; suggested?: TriageAction[]; inbox?: boolean; ref?: string };

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

export type RunItemView = RunItemRow & { ref: string; app_name: string | null; ticket_type_name: string | null; issue_number: number | null; repo_id: number | null; repo_owner: string; repo_name: string; issue_title: string | null; issue_state: string | null };

/** What a re-run item is about. */
export function subjectOfItem(i: Pick<RunItemRow, 'submission_id' | 'gh_repo_id' | 'gh_number'>): Subject {
  return i.submission_id ? { kind: 'ticket', submissionId: i.submission_id } : { kind: 'issue', repoId: i.gh_repo_id!, number: i.gh_number! };
}

/** Run items with what's needed to show them: the ticket, or the issue opened on GitHub. */
const RUN_ITEM_VIEW = `SELECT i.*,
    COALESCE(s.ref, COALESCE(ir.owner, a.repo_owner) || '/' || COALESCE(ir.name, a.repo_name) || '#' || i.gh_number) AS ref,
    COALESCE(s.app_name, (SELECT group_concat(x.name, ', ') FROM apps x WHERE x.workspace_id = r.workspace_id AND x.repo_id = i.gh_repo_id)) AS app_name,
    s.ticket_type_name, COALESCE(s.issue_number, i.gh_number) AS issue_number, COALESCE(s.repo_id, i.gh_repo_id) AS repo_id,
    COALESCE(s.repo_owner, ir.owner, a.repo_owner) AS repo_owner, COALESCE(s.repo_name, ir.name, a.repo_name) AS repo_name,
    x.title AS issue_title, x.state AS issue_state
  FROM triage_run_items i JOIN triage_runs r ON r.id = i.run_id
  LEFT JOIN submissions s ON s.id = i.submission_id
  LEFT JOIN issue_index_repos ir ON ir.repo_id = i.gh_repo_id
  LEFT JOIN (SELECT repo_id, workspace_id, min(repo_owner) AS repo_owner, min(repo_name) AS repo_name FROM apps GROUP BY repo_id, workspace_id) a ON a.repo_id = i.gh_repo_id AND a.workspace_id = r.workspace_id
  LEFT JOIN issue_index x ON x.repo_id = COALESCE(s.repo_id, i.gh_repo_id) AND x.number = COALESCE(s.issue_number, i.gh_number)`;

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

/**
 * What a re-run can pick, as one list (newest first): filed tickets, and issues opened on
 * GitHub, not known to be closed, with no triage action applied and not queued. Columns:
 * subject, submission_id, gh_repo_id, gh_number, at and tiebreak (newest first), and before.
 */
function rerunSources(workspaceId: string, scope: RerunScope): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const $ = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const source = scope.source ?? 'tickets';
  const kinds = (missing: string) => {
    const k = [
      scope.untouched ? `(r.status = 'done' AND json_array_length(COALESCE(r.applied_actions, '[]')) = 0)` : '',
      scope.never ? `(${missing} OR r.status IN ('skipped', 'failed'))` : '',
    ].filter(Boolean);
    return k.length ? `(${k.join(' OR ')})` : '0';
  };
  const before = `CASE WHEN r.status IS NULL THEN NULL ELSE json_object(
      'status', r.status, 'applied', json(COALESCE(r.applied_actions, '[]')), 'suggestions', json(COALESCE(r.suggestions, '[]')),
      'reason', json_extract(r.verdict, '$.reason'), 'skipReason', r.skip_reason, 'model', r.model) END`;
  const w = $(workspaceId);
  const parts: string[] = [];
  if (source !== 'github') {
    const where = [
      `s.workspace_id = ${w}`, `s.status = 'created'`, 's.issue_number IS NOT NULL',
      `NOT EXISTS (SELECT 1 FROM issue_index i WHERE i.repo_id = s.repo_id AND i.number = s.issue_number AND i.state = 'closed')`,
      kinds('r.submission_id IS NULL'),
    ];
    if (scope.appId) where.push(`s.app_id = ${$(scope.appId)}`);
    if (scope.typeName) where.push(`s.ticket_type_name = ${$(scope.typeName)}`);
    parts.push(`SELECT 'sub:' || s.id AS subject, s.id AS submission_id, NULL AS gh_repo_id, NULL AS gh_number, s.completed_at AS at, s.rowid AS tiebreak, ${before} AS before
      FROM submissions s LEFT JOIN triage_results r ON r.submission_id = s.id WHERE ${where.join(' AND ')}`);
  }
  // Only Discord tickets have a ticket type.
  if (source !== 'tickets' && !scope.typeName) {
    const repos = `SELECT DISTINCT repo_id FROM apps WHERE workspace_id = ${w}${scope.appId ? ` AND id = ${$(scope.appId)}` : ''}`;
    parts.push(`SELECT 'gh:' || i.repo_id || ':' || i.number AS subject, NULL AS submission_id, i.repo_id AS gh_repo_id, i.number AS gh_number, i.created_at AS at, i.number AS tiebreak, ${before} AS before
      FROM issue_index i LEFT JOIN issue_triage r ON r.workspace_id = ${w} AND r.repo_id = i.repo_id AND r.number = i.number
      WHERE i.repo_id IN (${repos}) AND i.state = 'open' AND i.gone = 0 AND i.app_name IS NULL
        AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.repo_id = i.repo_id AND s.issue_number = i.number)
        AND ${kinds('r.id IS NULL')}`);
  }
  if (!parts.length) parts.push('SELECT NULL AS subject, NULL AS submission_id, NULL AS gh_repo_id, NULL AS gh_number, NULL AS at, NULL AS tiebreak, NULL AS before WHERE 0');
  return { sql: parts.join('\n UNION ALL \n'), params };
}

/** The triage result of an issue opened on GitHub (same columns as a ticket's). */
export type IssueTriageRow = Omit<TriageResultRow, 'submission_id'> & { id: string; repo_id: number; number: number };
type AnyResultRow = TriageResultRow | IssueTriageRow;

/** Where results are kept: tickets in triage_results, issues opened on GitHub in issue_triage. */
type StoreName = 'tickets' | 'issues';
const STORES = {
  tickets: { table: 'triage_results', key: 'submission_id' },
  issues: { table: 'issue_triage', key: 'id' },
} as const;

function keyOf(store: StoreName, row: AnyResultRow): string {
  return store === 'tickets' ? (row as TriageResultRow).submission_id : (row as IssueTriageRow).id;
}

/** Whether this issue was filed by this app (then it's a ticket, triaged as one). */
async function isTicketIssue(q: Queryable, repoId: number, number: number): Promise<boolean> {
  const { rows } = await q.query('SELECT 1 FROM submissions WHERE repo_id = $1 AND issue_number = $2 LIMIT 1', [repoId, number]);
  return rows.length > 0;
}

// ---- Activity log (Triage › Activity) ------------------------------------------------------

/** Where an entry comes from: a new ticket, a new GitHub issue, a re-run (preview or applying), or someone reviewing. */
/** system: triage paused, or carried on. */
export type LogSource = 'ticket' | 'github' | 'preview' | 'rerun' | 'review' | 'system';
export type LogResult = 'ok' | 'failed' | 'skipped' | 'info';

export interface LogDetail {
  applied?: TriageAction[];
  suggested?: TriageAction[];
  /** A preview: what would be applied automatically. */
  auto?: TriageAction[];
  dismissed?: TriageAction[];
  /** Applied to the inbox only (everything became a suggestion). */
  inbox?: boolean;
  toldMember?: boolean;
  /** Part of a bulk Apply or Dismiss. */
  bulk?: boolean;
}

export interface LogEntry {
  workspaceId: string;
  source: LogSource;
  result: LogResult;
  submissionId?: string | null;
  repoId?: number | null;
  number?: number | null;
  ref?: string | null;
  runId?: string | null;
  bulkId?: string | null;
  by?: string | null;
  message?: string | null;
  detail?: LogDetail;
}

/** Days the activity log is kept. */
export const LOG_DAYS = 90;

/** Adds an entry to the activity log. Never throws: the log can't stop triage. */
export async function writeTriageLog(q: Queryable, e: LogEntry): Promise<void> {
  try {
    await q.query(
      `INSERT INTO triage_log (workspace_id, source, result, submission_id, repo_id, number, ref, run_id, bulk_id, by_user, message, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [e.workspaceId, e.source, e.result, e.submissionId ?? null, e.repoId ?? null, e.number ?? null, e.ref ?? null, e.runId ?? null, e.bulkId ?? null, e.by ?? null, e.message ? e.message.slice(0, 500) : null, e.detail ?? {}],
    );
  } catch {
    // Best effort.
  }
}

/** The log fields that say what an entry is about. */
function aboutSubject(subject: Subject): Pick<LogEntry, 'submissionId' | 'repoId' | 'number'> {
  return subject.kind === 'ticket' ? { submissionId: subject.submissionId } : { repoId: subject.repoId, number: subject.number };
}

/** A bulk Apply started from a list. */
export interface BulkRow {
  id: string;
  workspace_id: string;
  filter: { triage?: string; conf?: string };
  description: string;
  status: 'running' | 'done' | 'stopped';
  waiting_until_at: Date | null;
  waiting_reason: 'github' | null;
  created_by: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export type BulkProgress = BulkRow & { total: number; pending: number; done: number; skipped: number; failed: number };

/** A ticket or GitHub issue from its list value ('sub:<id>' or 'gh:<repo id>:<number>'). */
export function parseSubject(value: string): Subject | null {
  const t = /^sub:([0-9a-f-]{36})$/i.exec(value);
  if (t) return { kind: 'ticket', submissionId: t[1]! };
  const g = /^gh:(\d+):(\d+)$/.exec(value);
  return g ? { kind: 'issue', repoId: Number(g[1]), number: Number(g[2]) } : null;
}

export function subjectValue(s: Subject): string {
  return s.kind === 'ticket' ? `sub:${s.submissionId}` : `gh:${s.repoId}:${s.number}`;
}

/** What triage is doing now (Triage › Activity). */
export interface ActivityNow {
  /** apply: re-run results and bulk Apply. */
  queued: { tickets: number; issues: number; evaluate: number; apply: number };
  working: { kind: 'ticket' | 'issue' | 'rerun'; submission_id: string | null; repo_id: number | null; number: number | null; run_id: string | null; job: string | null }[];
  runs: (TriageRunRow & { pending: number; applying: number })[];
  bulks: BulkProgress[];
  /** When the triage worker process last reported in (null if never). */
  workerSeenAt: Date | null;
}

/** What trying Claude again found (see checkPaused). */
export interface PauseCheck {
  workspaceId: string;
  resumed: boolean;
  /** Why it's still paused (null when resumed, or when Claude couldn't be reached). */
  reason: PauseReason | null;
  message: string;
}

/** A log entry with what's needed to show it. */
export interface LogRow {
  id: number;
  workspace_id: string;
  at: Date;
  source: LogSource;
  result: LogResult;
  submission_id: string | null;
  repo_id: number | null;
  number: number | null;
  ref: string | null;
  run_id: string | null;
  bulk_id: string | null;
  by_user: string | null;
  message: string | null;
  detail: LogDetail;
  ticket_ref: string | null;
  title: string | null;
  owner: string | null;
  name: string | null;
  issue_number: number | null;
  run_name: string | null;
}

/** Records what happened to an issue's triage, for its page in the console. */
export async function addIssueEvent(q: Queryable, triageId: string, kind: string, detail: Record<string, unknown>): Promise<void> {
  await q.query('INSERT INTO issue_triage_events (triage_id, kind, detail) VALUES ($1, $2, $3)', [triageId, kind, detail]);
}

export class TriageEngine {
  readonly indexer: IssueIndexer;
  /** Writes each app's TRIAGE.md (AI triage › Knowledge). */
  readonly knowledge: KnowledgeWriter;
  /** Tracks what's merged into the apps' repositories (AI triage › Knowledge). */
  readonly changes: ChangeTracker;
  /** Reads the watched repositories for Repo status (not triage, but the same polling loop). */
  readonly repoStatus: RepoStatusTracker;
  /** Analytics: downloads every 30 minutes, and stars. */
  readonly analytics: AnalyticsRecorder;
  /** Release announcements: new releases, their notes and their posts in Discord. */
  readonly announcer: Announcer;
  /** Bot features › Known issues: keeps each posted board up to date. */
  readonly knownIssues: KnownIssuesUpdater;

  constructor(
    readonly deps: Deps,
    readonly ai: TriageAi,
  ) {
    this.indexer = new IssueIndexer(deps);
    this.knowledge = new KnowledgeWriter(deps, ai);
    this.changes = new ChangeTracker(deps);
    this.repoStatus = new RepoStatusTracker(deps);
    this.analytics = new AnalyticsRecorder(deps);
    this.announcer = new Announcer(deps, ai);
    this.knownIssues = new KnownIssuesUpdater(deps);
  }

  /** Queues newly filed tickets, and new issues opened on GitHub, where triage is on for them (only those after it was switched on). */
  async enqueueNew(): Promise<number> {
    const tickets = await this.deps.db.query(
      `INSERT OR IGNORE INTO triage_results (submission_id, workspace_id, status, next_attempt_at)
       SELECT s.id, s.workspace_id, 'pending', now_ms() FROM submissions s
       JOIN triage_settings t ON t.workspace_id = s.workspace_id AND t.enabled = 1
       WHERE s.status = 'created' AND s.issue_number IS NOT NULL AND s.completed_at >= t.enabled_at
         AND NOT EXISTS (SELECT 1 FROM triage_results r WHERE r.submission_id = s.id)
       ORDER BY s.completed_at, s.rowid LIMIT 100`,
    );
    // Issues the issue database has seen that this app didn't file (its tickets are triaged as tickets).
    const issues = await this.deps.db.query(
      `INSERT OR IGNORE INTO issue_triage (id, workspace_id, repo_id, number, status, next_attempt_at)
       SELECT lower(hex(randomblob(16))), t.workspace_id, i.repo_id, i.number, 'pending', now_ms()
       FROM triage_settings t
       JOIN (SELECT DISTINCT workspace_id, repo_id FROM apps) a ON a.workspace_id = t.workspace_id
       JOIN issue_index i ON i.repo_id = a.repo_id
       WHERE t.github_enabled = 1 AND i.created_at >= t.github_enabled_at AND i.state = 'open' AND i.gone = 0 AND i.app_name IS NULL
         AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.repo_id = i.repo_id AND s.issue_number = i.number)
         AND NOT EXISTS (SELECT 1 FROM issue_triage x WHERE x.workspace_id = t.workspace_id AND x.repo_id = i.repo_id AND x.number = i.number)
       ORDER BY i.created_at LIMIT 100`,
    );
    return tickets.rowCount + issues.rowCount;
  }

  /** Atomically claims one due ticket, skipping paused workspaces. */
  async claim(): Promise<TriageResultRow | null> {
    return this.claimFrom<TriageResultRow>('tickets');
  }

  /** Atomically claims one due issue opened on GitHub, skipping paused workspaces. */
  async claimIssue(): Promise<IssueTriageRow | null> {
    return this.claimFrom<IssueTriageRow>('issues');
  }

  private async claimFrom<T>(store: StoreName): Promise<T | null> {
    const { table, key } = STORES[store];
    const { rows } = await this.deps.db.query<T>(
      `UPDATE ${table} SET lease_owner = $1, lease_until_at = now_ms() + ($2 * 1000), attempts = attempts + 1, updated_at = now_ms()
       WHERE ${key} = (
         SELECT r.${key} FROM ${table} r JOIN triage_settings t ON t.workspace_id = r.workspace_id
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

  private async finish(row: AnyResultRow, fields: Record<string, unknown>, store: StoreName = 'tickets'): Promise<void> {
    const { table, key } = STORES[store];
    const entries = Object.entries({ ...fields, lease_owner: null, lease_until_at: null });
    await this.deps.db.query(
      `UPDATE ${table} SET ${entries.map(([k], i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now_ms()
       WHERE ${key} = $1 AND lease_owner = $2`,
      [keyOf(store, row), this.deps.instanceId, ...entries.map(([, v]) => v)],
    );
  }

  /** Log fields for a queued ticket or GitHub issue. */
  private rowLog(row: AnyResultRow, store: StoreName): Pick<LogEntry, 'workspaceId' | 'source' | 'submissionId' | 'repoId' | 'number'> {
    return store === 'tickets'
      ? { workspaceId: row.workspace_id, source: 'ticket', submissionId: (row as TriageResultRow).submission_id }
      : { workspaceId: row.workspace_id, source: 'github', repoId: (row as IssueTriageRow).repo_id, number: (row as IssueTriageRow).number };
  }

  private async skip(row: AnyResultRow, reason: string, extra: Record<string, unknown> = {}, store: StoreName = 'tickets') {
    await this.finish(row, { status: 'skipped', skip_reason: reason, completed_at: new Date(), ...extra }, store);
    await writeTriageLog(this.deps.db, { ...this.rowLog(row, store), result: 'skipped', message: reason });
  }

  private async retry(row: AnyResultRow, message: string, store: StoreName = 'tickets') {
    if (row.attempts > RETRY_DELAYS.length) {
      await this.finish(row, { status: 'failed', error: message, completed_at: new Date() }, store);
      await writeTriageLog(this.deps.db, { ...this.rowLog(row, store), result: 'failed', message: `Gave up after ${row.attempts} tries: ${message}` });
      return;
    }
    return this.finish(row, { status: 'pending', error: message, next_attempt_at: new Date(Date.now() + RETRY_DELAYS[row.attempts - 1]! * 1000) }, store);
  }

  /** Puts the row back without counting the attempt; it runs again once the workspace is resumed. */
  private requeue(row: AnyResultRow, store: StoreName = 'tickets') {
    return this.finish(row, { status: 'pending', attempts: Math.max(0, row.attempts - 1), next_attempt_at: null }, store);
  }

  async process(row: TriageResultRow): Promise<void> {
    return this.processFrom(row, 'tickets');
  }

  async processIssue(row: IssueTriageRow): Promise<void> {
    return this.processFrom(row, 'issues');
  }

  private async processFrom(row: AnyResultRow, store: StoreName): Promise<void> {
    try {
      await this.run(row, store);
    } catch (err) {
      this.deps.log.error({ err: (err as Error).message, [store === 'tickets' ? 'submission' : 'issue']: keyOf(store, row) }, 'triage failed unexpectedly');
      await this.retry(row, 'Unexpected error', store);
    }
  }

  private async run(row: AnyResultRow, store: StoreName): Promise<void> {
    const { deps } = this;
    const settings = await getTriageSettings(deps.db, row.workspace_id);
    const isIssue = store === 'issues';
    if (isIssue ? !settings.githubEnabled : !settings.enabled) return this.skip(row, isIssue ? 'Triage of issues opened on GitHub was turned off' : 'Triage was turned off', {}, store);
    const subject: Subject = isIssue
      ? { kind: 'issue', repoId: (row as IssueTriageRow).repo_id, number: (row as IssueTriageRow).number }
      : { kind: 'ticket', submissionId: (row as TriageResultRow).submission_id };
    const out = await this.evaluate(row.workspace_id, subject, settings.config);
    if (out.status === 'skip') return this.skip(row, out.reason, out.model ? { model: out.model } : {}, store);
    if (out.status === 'retry') return this.retry(row, out.message, store);
    if (out.status === 'paused') return this.requeue(row, store);
    const { e } = out;
    const ticket = ticketOf(e.target);
    const { applied, suggested, error, toldMember } = await this.applyAuto(e.target, e.auto, e.suggested, true);
    await this.finish(row, {
      status: 'done',
      ...resultFields(e, applied, suggested),
      error,
      input_tokens: e.inputTokens,
      output_tokens: e.outputTokens,
      completed_at: new Date(),
    }, store);
    const detail = { applied: applied.map(describeAction), suggested: suggested.map(describeAction), told_member: toldMember };
    if (ticket) await addEvent(deps.db, ticket.id, 'triage_done', detail);
    else await addIssueEvent(deps.db, (row as IssueTriageRow).id, 'triage_done', detail);
    await writeTriageLog(deps.db, { ...this.rowLog(row, store), ref: e.target.ref, result: error ? 'failed' : 'ok', message: error ? `${error}. Kept as suggestions.` : null, detail: { applied, suggested, toldMember } });
    deps.log.info({ [ticket ? 'submission' : 'issue']: e.target.ref, applied: applied.length, suggested: suggested.length }, ticket ? 'ticket triaged' : 'GitHub issue triaged');
  }

  /** Applies the automatic actions on GitHub. If GitHub refuses, nothing is lost: they become suggestions. */
  private async applyAuto(target: Target, auto: TriageAction[], suggestions: TriageAction[], tell: boolean, o: { rateLimitThrows?: boolean } = {}) {
    const applied: TriageAction[] = [];
    const suggested = [...suggestions];
    let toldMember = false;
    let error: string | null = null;
    if (auto.length) {
      try {
        await applyToGitHub(this.deps, target, auto);
        applied.push(...auto);
        const ticket = ticketOf(target);
        if (tell && ticket) toldMember = await tellMember(this.deps, ticket, auto);
      } catch (err) {
        // A re-run waits out GitHub's rate limit and tries again instead.
        if (o.rateLimitThrows && isGitHubRateLimit(err)) throw err;
        error = `Couldn’t update the GitHub issue: ${githubMessage(err)}`;
        suggested.unshift(...auto);
      }
    }
    return { applied, suggested, error, toldMember };
  }

  /** An issue opened on GitHub, ready to act on (null when its repository isn't connected any more). */
  async issueTarget(workspaceId: string, repoId: number, number: number): Promise<IssueTarget | null> {
    const app = (await listApps(this.deps.db, workspaceId)).find((a) => a.repo_id === repoId);
    const conn = await getGitHubConnection(this.deps.db, workspaceId);
    if (!app || !conn) return null;
    return { kind: 'issue', workspace_id: workspaceId, installation_id: conn.installation_id, repo_id: repoId, repo_owner: app.repo_owner, repo_name: app.repo_name, issue_number: number, ref: `${app.repo_owner}/${app.repo_name}#${number}` };
  }

  /**
   * What is triaged and with which settings: a ticket uses the Discord-ticket modes and its
   * ticket type's rules; an issue opened on GitHub uses the GitHub modes.
   */
  private async resolveSubject(workspaceId: string, subject: Subject, base: TriageConfig): Promise<
    { skip: string } | { target: Target; effective: TriageConfig; c: TriageConfig; off: Set<string>; app: string; type: string | null; title: string | null }
  > {
    const { deps } = this;
    if (subject.kind === 'ticket') {
      const sub = await getSubmission(deps.db, workspaceId, subject.submissionId);
      if (!sub || sub.status !== 'created' || !sub.issue_number) return { skip: 'The ticket is no longer filed' };
      if (base.appIds && !base.appIds.includes(sub.app_id ?? '')) return { skip: 'Not in scope (app)' };
      // The ticket type's rules switch actions off for this ticket; Claude is told which.
      const type = sub.ticket_type_name ? (await listTicketTypes(deps.db, workspaceId)).find((t) => t.name === sub.ticket_type_name) ?? null : null;
      const off = actionsOffFor(base, type);
      const c = withActionsOff(base, off);
      if (!anyActionOn(c)) return { skip: off.size >= allActionKeys(base).length ? 'Not in scope (ticket type)' : 'No triage actions are turned on' };
      return { target: sub, effective: base, c, off, app: sub.app_name, type: sub.ticket_type_name, title: decryptPayload(deps.box, sub)?.title ?? null };
    }
    const repoApps = (await listApps(deps.db, workspaceId)).filter((a) => a.repo_id === subject.repoId);
    if (!repoApps.length) return { skip: 'The repository is no longer connected' };
    if (base.appIds && !repoApps.some((a) => base.appIds!.includes(a.id))) return { skip: 'Not in scope (app)' };
    const c = forGitHub(base);
    if (!anyActionOn(c)) return { skip: 'No triage actions are turned on for issues opened on GitHub' };
    if (await isTicketIssue(deps.db, subject.repoId, subject.number)) return { skip: 'Filed through Discord, so it’s triaged as a ticket' };
    const target = await this.issueTarget(workspaceId, subject.repoId, subject.number);
    if (!target) return { skip: 'GitHub isn’t connected' };
    // A repository can hold several apps; Claude works out which one the issue is about.
    return { target, effective: c, c, off: new Set(), app: repoApps.length === 1 ? repoApps[0]!.name : repoApps.map((a) => a.name).join(' or '), type: null, title: null };
  }

  /**
   * Reads the ticket or issue from GitHub, asks Claude and plans the actions with the given
   * settings. Changes nothing on GitHub; normal triage and re-runs both start here.
   */
  async evaluate(workspaceId: string, subject: Subject, base: TriageConfig): Promise<Outcome> {
    const { deps } = this;
    const skip = (reason: string, model?: string): Outcome => ({ status: 'skip', reason, model });
    const resolved = await this.resolveSubject(workspaceId, subject, base);
    if ('skip' in resolved) return skip(resolved.skip);
    const { target, effective, c, off } = resolved;
    const usage = await monthlyUsage(deps.db, workspaceId);
    if (usage.triaged >= c.monthlyLimit) return skip('Monthly limit reached');
    const key = await resolveApiKey(deps, workspaceId);
    if (!key) {
      if (await pauseTriage(deps.db, workspaceId, 'no_key', null)) await writeTriageLog(deps.db, { workspaceId, source: 'system', result: 'failed', message: 'Paused: there’s no Claude API key.' });
      return { status: 'paused' };
    }
    if (!deps.github) return skip('GitHub isn’t configured');
    const conn = await getGitHubConnection(deps.db, workspaceId);
    const inst = conn?.installation_id ?? target.installation_id;

    // The text lives in the GitHub issue (a ticket's copy is removed from our database once filed).
    let issue: IssueDetail;
    try {
      issue = await deps.github.getIssueDetail(inst, target.repo_owner, target.repo_name, target.issue_number!);
    } catch (err) {
      if (err instanceof GitHubApiError && [403, 404, 410].includes(err.status) && !err.isRateLimit) return skip('The GitHub issue no longer exists or can’t be read');
      if (isGitHubRateLimit(err)) return { status: 'retry', message: 'GitHub rate limit', waitSeconds: err.retryAfterSeconds ?? 60, waitFor: 'github' };
      return { status: 'retry', message: `GitHub unavailable: ${githubMessage(err)}` };
    }
    if (issue.state === 'closed') return skip('The issue was already closed on GitHub');
    if (!ticketOf(target)) {
      if (issue.authorIsBot) return skip('Opened by a bot');
      if (issue.body.includes(MARKER_PREFIX)) return skip('Filed through Discord, so it’s triaged as a ticket');
    }

    const [apps, knowledge] = await Promise.all([listApps(deps.db, workspaceId), listKnowledge(deps.db, workspaceId)]);
    const own = `${target.repo_owner}/${target.repo_name}`;
    const repoRef: RepoRef = { repo_id: target.repo_id, owner: target.repo_owner, name: target.repo_name, installation_id: inst };
    const candidates = await this.findCandidates(issue, repoRef, c, apps);
    // Being worked on, Already fixed: the pull requests and commits that may be about it.
    const work: WorkItem[] | undefined = workOn(effective)
      ? await findWork(deps.db, target.repo_id, ftsQuery(issue.title, extractDescription(issue.body)), candidates.filter((x) => x.sameRepo).map((x) => x.number)).catch(() => [])
      : undefined;
    const appNames = [...new Set(apps.map((a) => a.name))];
    // Groups that are off for this source aren't asked about; groups off for this type are listed as off.
    const groups = c.labelGroups.filter((g) => effective.labelGroups.find((b) => b.id === g.id)?.mode !== 'off');
    const groupsOff = groups.filter((g) => g.mode === 'off').map((g) => g.id);
    const title = resolved.title ?? issue.title;
    // Screenshots: only a ticket's (they're kept on this server), and only when the admins turned it on.
    const ticket = ticketOf(target);
    const shots = ticket && c.screenshots ? await screenshotsFor(deps, ticket.id, MAX_SCREENSHOTS) : { images: [], skipped: 0 };
    const images: TicketImage[] = shots.images.map((i) => ({ mediaType: i.contentType, data: i.data.toString('base64') }));
    // The instructions, then this ticket's app's TRIAGE.md: each is cached on its own.
    const appIds = ticket ? [ticket.app_id] : apps.filter((a) => a.repo_id === target.repo_id).map((a) => a.id);
    // With Keep them up to date on: what was merged lately, even before the TRIAGE.md has it.
    const merged = base.knowledgeAuto ? await recentChanges(deps.db, appIds.filter((x): x is string => Boolean(x))) : new Map<string, AppChange[]>();
    const known = knowledgePromptFor(apps, knowledge, appIds, merged);
    const ask = (withImages: TicketImage[]) => this.ai.classify(
      key.key,
      c.model,
      known ? [systemPromptFor(effective, apps), known] : systemPromptFor(effective, apps),
      buildUserPrompt(
        { app: resolved.app, type: resolved.type, title, description: extractDescription(issue.body), screenshots: withImages.length ? { shown: withImages.length, skipped: shots.skipped } : undefined },
        candidates,
        [...off].filter((k) => !k.startsWith('group:')),
        groupsOff,
        work,
      ),
      verdictSchema({ groups, apps: appNames, work: Boolean(work) }),
      withImages,
    );
    let result;
    try {
      try {
        result = await ask(images);
      } catch (err) {
        // A screenshot Claude won't take mustn't pause triage: the ticket is read without them.
        if (!images.length || !(err instanceof TriageAiError) || err.pauseReason !== 'rejected') throw err;
        deps.log.warn({ ticket: target.ref, err: err.message }, 'Claude refused the screenshots; triaging the text alone');
        result = await ask([]);
      }
    } catch (err) {
      const e = err instanceof TriageAiError ? err : new TriageAiError('retry', (err as Error).message);
      if (e.action === 'pause') {
        // Triage › Activity shows when it stopped (once, not for every ticket that was waiting).
        if (await pauseTriage(deps.db, workspaceId, e.pauseReason ?? 'rejected', e.message)) {
          await writeTriageLog(deps.db, { workspaceId, source: 'system', result: 'failed', message: `Paused: ${e.message}` });
        }
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
      work: new Map((work ?? []).map((w) => [w.ref, w])),
    });
    if (verdict.duplicates.length && c.duplicate.mode !== 'off') await this.pickOriginal(verdict, repoRef);
    const dc = await getDiscordConnection(deps.db, workspaceId);
    const ctx: TemplateContext = { app: resolved.app, repoUrl: `https://github.com/${own}`, repo: own, guildId: dc?.guild_id ?? null, helpChannel: c.helpChannel };
    const { auto, suggested } = planActions(verdict, c, ctx, new Map(apps.map((a) => [a.name, `${a.repo_owner}/${a.repo_name}`])));
    return { status: 'done', e: { target, verdict, auto, suggested, config: c, inputTokens: result.inputTokens, outputTokens: result.outputTokens } };
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
    if (!on('duplicate') && !on('regression') && !on('related') && !on('shared') && !on('inProgress') && !on('fixed')) return [];
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

  /** Applies one suggestion on GitHub (people with Edit on Review). */
  async applySuggestion(workspaceId: string, submissionId: string, kind: string, userId: string): Promise<TriageAction> {
    const { row, action, rest } = await this.reviewTarget(workspaceId, submissionId, kind);
    const sub = await getSubmission(this.deps.db, workspaceId, submissionId);
    if (!sub || sub.status !== 'created') throw new UserFacingError('The ticket is no longer filed on GitHub.');
    const about = { workspaceId, source: 'review' as const, submissionId, ref: sub.ref, by: userId };
    try {
      await applyToGitHub(this.deps, sub, [action]);
    } catch (err) {
      await writeTriageLog(this.deps.db, { ...about, result: 'failed', message: `GitHub didn’t accept the change: ${githubMessage(err)}`, detail: { suggested: [action] } });
      throw new UserFacingError(`GitHub didn’t accept the change (${githubMessage(err)}). Try again in a moment.`, 502);
    }
    await this.saveReview(row, rest, [...(row.applied_actions ?? []), action]);
    const told = await tellMember(this.deps, sub, [action]);
    await addEvent(this.deps.db, submissionId, 'triage_applied', { by: userId, actions: [describeAction(action)], told_member: told });
    await writeTriageLog(this.deps.db, { ...about, result: 'ok', detail: { applied: [action], toldMember: told } });
    return action;
  }

  async dismissSuggestion(workspaceId: string, submissionId: string, kind: string, userId: string): Promise<TriageAction> {
    const { row, action, rest } = await this.reviewTarget(workspaceId, submissionId, kind);
    await this.saveReview(row, rest, row.applied_actions ?? [], 'tickets', 1);
    await addEvent(this.deps.db, submissionId, 'triage_dismissed', { by: userId, actions: [describeAction(action)] });
    await writeTriageLog(this.deps.db, { workspaceId, source: 'review', submissionId, by: userId, result: 'ok', detail: { dismissed: [action] } });
    return action;
  }

  private async saveReview(row: AnyResultRow, suggestions: TriageAction[], applied: TriageAction[], store: StoreName = 'tickets', dismissed = 0) {
    const { table, key } = STORES[store];
    await this.deps.db.query(
      `UPDATE ${table} SET suggestions = $2, applied_actions = $3, suggestion_count = $4, dismissed_count = dismissed_count + $5, updated_at = now_ms() WHERE ${key} = $1`,
      [keyOf(store, row), suggestions, applied, suggestions.length, dismissed],
    );
  }

  // ---- Issues opened on GitHub: their results and review --------------------------------------

  async getIssueResult(workspaceId: string, repoId: number, number: number): Promise<IssueTriageRow | null> {
    const { rows } = await this.deps.db.query<IssueTriageRow>('SELECT * FROM issue_triage WHERE workspace_id = $1 AND repo_id = $2 AND number = $3', [workspaceId, repoId, number]);
    return rows[0] ?? null;
  }

  private async issueReviewTarget(workspaceId: string, repoId: number, number: number, kind: string) {
    const row = await this.getIssueResult(workspaceId, repoId, number);
    const action = row?.status === 'done' ? (row.suggestions ?? []).find((a) => a.kind === kind) : undefined;
    if (!row || !action) throw new UserFacingError('That suggestion was already handled.', 409);
    return { row, action, rest: (row.suggestions ?? []).filter((a) => a !== action) };
  }

  /** Applies one suggestion on an issue opened on GitHub (people with Edit on Review). */
  async applyIssueSuggestion(workspaceId: string, repoId: number, number: number, kind: string, userId: string): Promise<TriageAction> {
    const { row, action, rest } = await this.issueReviewTarget(workspaceId, repoId, number, kind);
    const target = await this.issueTarget(workspaceId, repoId, number);
    if (!target) throw new UserFacingError('This repository isn’t connected any more.');
    const about = { workspaceId, source: 'review' as const, repoId, number, ref: target.ref, by: userId };
    try {
      await applyToGitHub(this.deps, target, [action]);
    } catch (err) {
      await writeTriageLog(this.deps.db, { ...about, result: 'failed', message: `GitHub didn’t accept the change: ${githubMessage(err)}`, detail: { suggested: [action] } });
      throw new UserFacingError(`GitHub didn’t accept the change (${githubMessage(err)}). Try again in a moment.`, 502);
    }
    await this.saveReview(row, rest, [...(row.applied_actions ?? []), action], 'issues');
    await addIssueEvent(this.deps.db, row.id, 'triage_applied', { by: userId, actions: [describeAction(action)] });
    await writeTriageLog(this.deps.db, { ...about, result: 'ok', detail: { applied: [action] } });
    return action;
  }

  async dismissIssueSuggestion(workspaceId: string, repoId: number, number: number, kind: string, userId: string): Promise<TriageAction> {
    const { row, action, rest } = await this.issueReviewTarget(workspaceId, repoId, number, kind);
    await this.saveReview(row, rest, row.applied_actions ?? [], 'issues', 1);
    await addIssueEvent(this.deps.db, row.id, 'triage_dismissed', { by: userId, actions: [describeAction(action)] });
    await writeTriageLog(this.deps.db, { workspaceId, source: 'review', repoId, number, by: userId, result: 'ok', detail: { dismissed: [action] } });
    return action;
  }

  // ---- Re-runs ----------------------------------------------------------------------------

  /** How many tickets a re-run with this scope would pick (before the limit). */
  async countRerun(workspaceId: string, scope: RerunScope): Promise<number> {
    const w = rerunSources(workspaceId, scope);
    const { rows } = await this.deps.db.query<{ n: number }>(`SELECT count(*) AS n FROM (${w.sql})`, w.params);
    return rows[0]?.n ?? 0;
  }

  /**
   * Starts a re-run with the current settings (saved with the run). A preview only records what
   * triage would do; an "apply" run applies it like normal triage. One run at a time.
   */
  async startRun(workspaceId: string, userId: string, o: { mode: 'preview' | 'apply'; name: string | null; scope: RerunScope }): Promise<TriageRunRow> {
    const run = await this.startRunInner(workspaceId, userId, o);
    const items = (run.scope.limit ?? 0) < (run.scope.matched ?? 0) ? run.scope.limit : run.scope.matched;
    await writeTriageLog(this.deps.db, { workspaceId, source: run.mode === 'preview' ? 'preview' : 'rerun', result: 'info', runId: run.id, by: userId, message: `Re-run started (${run.mode === 'preview' ? 'preview' : 'applying right away'}): ${items ?? 0} queued` });
    return run;
  }

  private async startRunInner(workspaceId: string, userId: string, o: { mode: 'preview' | 'apply'; name: string | null; scope: RerunScope }): Promise<TriageRunRow> {
    const { db } = this.deps;
    const settings = await getTriageSettings(db, workspaceId);
    const source = o.scope.source ?? 'tickets';
    if (o.mode === 'apply' && ((source !== 'github' && !settings.enabled) || (source !== 'tickets' && !settings.githubEnabled))) {
      throw new UserFacingError(source === 'tickets' ? 'Turn triage on to apply results. A preview works while it’s off.' : 'Turn triage on for these issues to apply results. A preview works while it’s off.');
    }
    const ticketsOn = anyActionOn(settings.config);
    const githubOn = anyActionOn(forGitHub(settings.config));
    if (source === 'tickets' ? !ticketsOn : source === 'github' ? !githubOn : !ticketsOn && !githubOn) {
      throw new UserFacingError(source === 'github' ? 'Turn at least one action on for issues opened on GitHub first.' : 'Turn at least one triage action on first.');
    }
    if (!(await resolveApiKey(this.deps, workspaceId))) throw new UserFacingError('Add a Claude API key in Settings first.');
    const { rows: running } = await db.query('SELECT id FROM triage_runs WHERE workspace_id = $1 AND status = $2', [workspaceId, 'running']);
    if (running.length) throw new UserFacingError('A re-run is already going. Wait for it to finish or stop it.', 409);
    const usage = await monthlyUsage(db, workspaceId);
    const left = settings.config.monthlyLimit - usage.triaged;
    if (left <= 0) throw new UserFacingError('This month’s triage limit is used up. Raise the monthly limit to re-run.');
    const matched = await this.countRerun(workspaceId, o.scope);
    if (!matched) throw new UserFacingError('No open tickets match. Change which tickets to include.');
    const limit = Math.max(1, Math.min(o.scope.limit, MAX_RERUN, left));
    const scope: RerunScope = { ...o.scope, source, limit, matched };
    const w = rerunSources(workspaceId, scope);
    const id = randomUUID();
    const n = w.params.length;
    // Everything that matches is queued at once, newest first, with its triage so far to compare with.
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO triage_runs (id, workspace_id, name, mode, scope, config_used, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, workspaceId, o.name, o.mode, scope, settings.config, userId]);
      await tx.query(
        `INSERT INTO triage_run_items (run_id, subject, submission_id, gh_repo_id, gh_number, position, before)
         SELECT $${n + 1}, subject, submission_id, gh_repo_id, gh_number, row_number() OVER (ORDER BY at DESC, tiebreak DESC) - 1, before
         FROM (${w.sql}) ORDER BY at DESC, tiebreak DESC LIMIT $${n + 2}`,
        [...w.params, id, limit],
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
      `SELECT r.*, count(i.subject) AS total,
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
      `${RUN_ITEM_VIEW} WHERE i.run_id = $1 ORDER BY i.position`,
      [runId],
    );
    return rows;
  }

  /** One page of a run's tickets, in order. */
  async runPage(runId: string, filter: RunFilter, limit: number, offset: number): Promise<RunItemView[]> {
    const { rows } = await this.deps.db.query<RunItemView>(
      `${RUN_ITEM_VIEW} WHERE i.run_id = $1 AND ${FILTER_SQL[filter]} ORDER BY i.position LIMIT $2 OFFSET $3`,
      [runId, limit, offset],
    );
    return rows;
  }

  /** Progress and results of a run, counted in the database (runs can have thousands of tickets). */
  async runCounts(runId: string, applyingSince: Date | null = null): Promise<RunCounts> {
    const { db } = this.deps;
    // Results from before the comparison was stored get it now.
    const { rows: old } = await db.query<RunItemRow>(`SELECT subject, before, auto_actions, suggestions FROM triage_run_items WHERE run_id = $1 AND status = 'done' AND change IS NULL`, [runId]);
    for (const i of old) {
      await db.query('UPDATE triage_run_items SET change = $3 WHERE run_id = $1 AND subject = $2', [runId, i.subject, changeFrom(beforeDecisions(i.before), { auto: i.auto_actions ?? [], suggested: i.suggestions ?? [] })]);
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
  async stopApplying(workspaceId: string, runId: string, userId: string | null = null): Promise<number> {
    if (!(await this.getRun(workspaceId, runId))) throw new UserFacingError('That re-run wasn’t found.', 404);
    const res = await this.deps.db.query(`UPDATE triage_run_items SET apply_status = NULL, apply_suggestions = 0, apply_inbox_only = 0 WHERE run_id = $1 AND apply_status = 'pending' AND (lease_until_at IS NULL OR lease_until_at < now_ms())`, [runId]);
    await writeTriageLog(this.deps.db, { workspaceId, source: 'rerun', result: 'info', runId, by: userId, message: `Applying stopped: ${res.rowCount} not applied (they can be applied later)` });
    return res.rowCount;
  }

  /** Stops a running re-run; tickets not reached yet are skipped. Results so far are kept. */
  async cancelRun(workspaceId: string, runId: string, userId: string | null = null): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const res = await tx.query(`UPDATE triage_runs SET status = 'cancelled', finished_at = now_ms() WHERE workspace_id = $1 AND id = $2 AND status = 'running'`, [workspaceId, runId]);
      if (!res.rowCount) throw new UserFacingError('That re-run already finished.', 409);
      await tx.query(`UPDATE triage_run_items SET status = 'skipped', note = 'Stopped before this ticket', lease_until_at = NULL WHERE run_id = $1 AND status = 'pending'`, [runId]);
      await tx.query(`UPDATE triage_run_items SET apply_status = 'skipped', apply_note = 'Stopped before this ticket' WHERE run_id = $1 AND apply_status = 'pending'`, [runId]);
    });
    await writeTriageLog(this.deps.db, { workspaceId, source: 'preview', result: 'info', runId, by: userId, message: 'Re-run stopped: tickets not reached yet are skipped' });
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
    const source = run.scope.source ?? 'tickets';
    if (o.mode !== 'inbox' && ((source !== 'github' && !settings.enabled) || (source !== 'tickets' && !settings.githubEnabled))) {
      throw new UserFacingError('Turn triage on (for Discord tickets and, if included, issues opened on GitHub) to apply results on GitHub.');
    }
    if (!o.ids?.length && !o.filter) throw new UserFacingError('Select the results to apply.');
    const res = await db.query(
      `UPDATE triage_run_items AS i SET apply_status = 'pending', apply_note = NULL, apply_suggestions = $3, apply_inbox_only = $4, lease_until_at = NULL
       WHERE i.run_id = $1 AND i.status = 'done' AND (i.apply_status IS NULL OR i.apply_status = 'failed')
         AND ${o.ids?.length ? 'i.subject IN (SELECT value FROM json_each($2))' : `$2 IS NULL AND ${FILTER_SQL[o.filter ?? 'all']}`}`,
      [runId, o.ids?.length ? JSON.stringify(o.ids) : null, o.mode === 'all' ? 1 : 0, o.mode === 'inbox' ? 1 : 0],
    );
    if (!res.rowCount) throw new UserFacingError('There’s nothing left to apply here.', 409);
    await db.query('UPDATE triage_runs SET applied_at = now_ms(), applied_by = $2 WHERE id = $1', [runId, userId]);
    const how = o.mode === 'inbox' ? 'to the inbox only (as suggestions)' : o.mode === 'all' ? 'on GitHub, suggestions included' : 'on GitHub (automatic actions)';
    await writeTriageLog(db, { workspaceId, source: 'rerun', result: 'info', runId, by: userId, message: `Applying ${res.rowCount} result${res.rowCount === 1 ? '' : 's'} ${how}, one at a time` });
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
    await db.query('UPDATE triage_run_items SET lease_until_at = NULL, attempts = $3 WHERE run_id = $1 AND subject = $2', [run.id, item.subject, uncount ? Math.max(0, item.attempts - 1) : item.attempts]);
    this.deps.log.info({ run: run.id, until, reason }, 're-run waiting for a rate limit');
    if (!run.waiting_until_at || run.waiting_until_at.getTime() <= Date.now()) {
      await writeTriageLog(db, { workspaceId: run.workspace_id, source: run.mode === 'preview' ? 'preview' : 'rerun', result: 'info', runId: run.id, message: reason === 'github' ? `Waiting until ${until.toISOString().slice(11, 16)} UTC for GitHub’s hourly limit, so new tickets can still be filed` : `Claude asked to slow down; waiting until ${until.toISOString().slice(11, 16)} UTC` });
    }
  }

  async processRunItem(claimed: { item: RunItemRow; job: 'evaluate' | 'apply' }): Promise<void> {
    const { item, job } = claimed;
    const { db } = this.deps;
    const { rows } = await db.query<TriageRunRow>('SELECT * FROM triage_runs WHERE id = $1', [item.run_id]);
    if (!rows[0]) return;
    const run = withParsedConfig(rows[0]);
    const set = (fields: Record<string, unknown>) => {
      const entries = Object.entries({ ...fields, lease_until_at: null });
      return db.query(`UPDATE triage_run_items SET ${entries.map(([k], i) => `${k} = $${i + 3}`).join(', ')} WHERE run_id = $1 AND subject = $2`, [item.run_id, item.subject, ...entries.map(([, v]) => v)]);
    };
    const about = { workspaceId: run.workspace_id, runId: run.id, ...aboutSubject(subjectOfItem(item)) };
    const evalSource: LogSource = run.mode === 'preview' ? 'preview' : 'rerun';
    const applied = async (r: CommitResult) => {
      await set({ apply_status: r.status, apply_note: r.note, apply_done_at: new Date() });
      await writeTriageLog(db, { ...about, source: 'rerun', ref: r.ref ?? null, result: r.status === 'done' ? 'ok' : r.status, message: r.note, detail: { applied: r.applied, suggested: r.suggested, inbox: r.inbox } });
    };
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
      const out = await this.evaluate(run.workspace_id, subjectOfItem(item), run.config_used);
      if (out.status === 'skip') {
        await set({ status: 'skipped', note: out.reason, model: out.model ?? null, completed_at: new Date() });
        await writeTriageLog(db, { ...about, source: evalSource, result: 'skipped', message: out.reason });
      }
      else if (out.status === 'paused') await set({ attempts: Math.max(0, item.attempts - 1) });
      else if (out.status === 'retry' && out.waitSeconds) await this.waitRun(run, item, new Date(Date.now() + out.waitSeconds * 1000), out.waitFor ?? 'claude', true);
      else if (out.status === 'retry') {
        await set(item.attempts >= RERUN_ATTEMPTS
          ? { status: 'failed', note: out.message, completed_at: new Date() }
          : { note: out.message, next_attempt_at: new Date(Date.now() + 60_000 * item.attempts) });
        if (item.attempts >= RERUN_ATTEMPTS) await writeTriageLog(db, { ...about, source: evalSource, result: 'failed', message: `Gave up after ${item.attempts} tries: ${out.message}` });
      } else {
        const { e } = out;
        const done: RunItemRow = { ...item, verdict: e.verdict, auto_actions: e.auto, suggestions: e.suggested };
        const change = changeFrom(beforeDecisions(item.before), { auto: e.auto, suggested: e.suggested });
        await set({ status: 'done', note: null, change, verdict: e.verdict, auto_actions: e.auto, suggestions: e.suggested, model: e.config.model, input_tokens: e.inputTokens, output_tokens: e.outputTokens, completed_at: new Date() });
        if (run.mode === 'preview') await writeTriageLog(db, { ...about, source: 'preview', ref: e.target.ref, result: 'ok', detail: { auto: e.auto, suggested: e.suggested } });
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
      this.deps.log.error({ err: (err as Error).message, run: run.id, subject: item.subject }, 're-run failed unexpectedly');
      if (job === 'apply') await applied({ status: 'failed', note: 'Unexpected error' });
      else {
        await set({ status: 'failed', note: 'Unexpected error', completed_at: new Date() });
        await writeTriageLog(db, { ...about, source: evalSource, result: 'failed', message: 'Unexpected error' });
      }
    } finally {
      await db.query(
        `UPDATE triage_runs SET status = 'done', finished_at = now_ms(), waiting_until_at = NULL, waiting_reason = NULL WHERE id = $1 AND status = 'running'
           AND NOT EXISTS (SELECT 1 FROM triage_run_items WHERE run_id = $1 AND status = 'pending')`,
        [run.id],
      );
    }
  }

  /**
   * Makes a re-run's result the ticket's (or GitHub issue's) triage result: its automatic
   * actions are applied on GitHub and its suggestions replace the old ones. Skipped when
   * something changed since: actions were applied, it's being triaged, or the issue was closed.
   */
  private async commitItem(run: TriageRunRow, item: RunItemRow, userId: string | null, fresh?: Evaluation): Promise<CommitResult> {
    const { deps } = this;
    const subject = subjectOfItem(item);
    const target: Target | null = fresh?.target
      ?? (subject.kind === 'ticket' ? await getSubmission(deps.db, run.workspace_id, subject.submissionId) : await this.issueTarget(run.workspace_id, subject.repoId, subject.number));
    const ticket = target ? ticketOf(target) : null;
    if (!target || !target.issue_number || (ticket && ticket.status !== 'created')) return { status: 'skipped', note: subject.kind === 'ticket' ? 'The ticket is no longer filed' : 'The repository isn’t connected any more' };
    const current = subject.kind === 'ticket' ? await this.getResult(run.workspace_id, subject.submissionId) : await this.getIssueResult(run.workspace_id, subject.repoId, subject.number);
    if (current?.status === 'pending') return { status: 'skipped', note: 'Triage is running on this right now' };
    if ((current?.applied_actions ?? []).length) return { status: 'skipped', note: 'Actions were applied since the run started' };
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
        const live = await deps.github.getIssueDetail(conn?.installation_id ?? target.installation_id, target.repo_owner, target.repo_name, target.issue_number);
        if (live.state === 'closed') return { status: 'skipped', note: 'The issue was closed since the preview' };
      } catch (err) {
        if (isGitHubRateLimit(err)) throw err;
        return { status: 'failed', note: `GitHub unavailable: ${githubMessage(err)}` };
      }
    }
    const config = subject.kind === 'issue' ? forGitHub(run.config_used) : run.config_used;
    const e: Evaluation = fresh ?? { target, verdict: item.verdict!, auto, suggested: suggestedIn, config, inputTokens: 0, outputTokens: 0 };
    const { applied, suggested, error } = await this.applyAuto(target, auto, e.suggested, false, { rateLimitThrows: true });
    const fields = { ...resultFields(e, applied, suggested), error };
    const cols = Object.keys(fields);
    const detail = { by: userId, applied: applied.map(describeAction), suggested: suggested.map(describeAction) };
    // Tokens stay counted on the run, so a new row has none (the monthly count includes runs).
    if (subject.kind === 'ticket') {
      await deps.db.query(
        `INSERT INTO triage_results (submission_id, workspace_id, status, completed_at, ${cols.join(', ')})
         VALUES ($1, $2, 'done', now_ms(), ${cols.map((_, i) => `$${i + 3}`).join(', ')})
         ON CONFLICT (submission_id) DO UPDATE SET status = 'done', skip_reason = NULL, lease_owner = NULL, lease_until_at = NULL, next_attempt_at = NULL,
           ${cols.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = now_ms()`,
        [subject.submissionId, run.workspace_id, ...Object.values(fields)],
      );
      await addEvent(deps.db, subject.submissionId, 'triage_rerun', detail);
    } else {
      const { rows } = await deps.db.query<{ id: string }>(
        `INSERT INTO issue_triage (id, workspace_id, repo_id, number, status, completed_at, ${cols.join(', ')})
         VALUES (lower(hex(randomblob(16))), $1, $2, $3, 'done', now_ms(), ${cols.map((_, i) => `$${i + 4}`).join(', ')})
         ON CONFLICT (workspace_id, repo_id, number) DO UPDATE SET status = 'done', skip_reason = NULL, lease_owner = NULL, lease_until_at = NULL, next_attempt_at = NULL,
           ${cols.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = now_ms()
         RETURNING id`,
        [run.workspace_id, subject.repoId, subject.number, ...Object.values(fields)],
      );
      if (rows[0]) await addIssueEvent(deps.db, rows[0].id, 'triage_rerun', detail);
    }
    const did = { applied, suggested, inbox: inboxOnly, ref: target.ref };
    return error ? { status: 'failed', note: `${error}. Kept as suggestions.`, ...did } : { status: 'done', note: null, ...did };
  }

  // ---- Activity (Triage › Activity) ---------------------------------------------------------------

  /** Deletes log entries older than LOG_DAYS. */
  async pruneLog(): Promise<number> {
    const res = await this.deps.db.query('DELETE FROM triage_log WHERE at < $1', [new Date(Date.now() - LOG_DAYS * 86_400_000)]);
    return res.rowCount;
  }

  /** What triage is doing for a workspace right now: queues, what's being worked on, and waits. */
  async activityNow(workspaceId: string): Promise<ActivityNow> {
    const { db } = this.deps;
    const [counts, working, runs, worker] = await Promise.all([
      db.query<Record<string, number>>(
        `SELECT
           (SELECT count(*) FROM triage_results WHERE workspace_id = $1 AND status = 'pending') AS tickets,
           (SELECT count(*) FROM issue_triage WHERE workspace_id = $1 AND status = 'pending') AS issues,
           (SELECT count(*) FROM triage_run_items i JOIN triage_runs r ON r.id = i.run_id WHERE r.workspace_id = $1 AND r.status = 'running' AND i.status = 'pending') AS evaluate,
           (SELECT count(*) FROM triage_run_items i JOIN triage_runs r ON r.id = i.run_id WHERE r.workspace_id = $1 AND i.apply_status = 'pending')
             + (SELECT count(*) FROM triage_bulk_items i JOIN triage_bulk b ON b.id = i.bulk_id WHERE b.workspace_id = $1 AND b.status = 'running' AND i.status = 'pending') AS apply`,
        [workspaceId],
      ),
      db.query<{ kind: 'ticket' | 'issue' | 'rerun'; submission_id: string | null; repo_id: number | null; number: number | null; run_id: string | null; job: string | null }>(
        `SELECT 'ticket' AS kind, submission_id, NULL AS repo_id, NULL AS number, NULL AS run_id, NULL AS job FROM triage_results WHERE workspace_id = $1 AND status = 'pending' AND lease_until_at > now_ms()
         UNION ALL SELECT 'issue', NULL, repo_id, number, NULL, NULL FROM issue_triage WHERE workspace_id = $1 AND status = 'pending' AND lease_until_at > now_ms()
         UNION ALL SELECT 'rerun', i.submission_id, i.gh_repo_id, i.gh_number, i.run_id, CASE WHEN i.status = 'pending' THEN 'evaluate' ELSE 'apply' END
           FROM triage_run_items i JOIN triage_runs r ON r.id = i.run_id WHERE r.workspace_id = $1 AND i.lease_until_at > now_ms()
         LIMIT 5`,
        [workspaceId],
      ),
      db.query<TriageRunRow & { pending: number; applying: number }>(
        `SELECT r.*, (SELECT count(*) FROM triage_run_items i WHERE i.run_id = r.id AND i.status = 'pending') AS pending,
           (SELECT count(*) FROM triage_run_items i WHERE i.run_id = r.id AND i.apply_status = 'pending') AS applying
         FROM triage_runs r WHERE r.workspace_id = $1
           AND (r.status = 'running' OR EXISTS (SELECT 1 FROM triage_run_items i WHERE i.run_id = r.id AND i.apply_status = 'pending'))
         ORDER BY r.created_at`,
        [workspaceId],
      ),
      db.query<{ seen_at: Date; started_at: Date }>(`SELECT seen_at, started_at FROM process_status WHERE role = 'triage' ORDER BY seen_at DESC LIMIT 1`),
    ]);
    const c = counts.rows[0] ?? {};
    return {
      queued: { tickets: Number(c.tickets ?? 0), issues: Number(c.issues ?? 0), evaluate: Number(c.evaluate ?? 0), apply: Number(c.apply ?? 0) },
      working: working.rows,
      runs: runs.rows.map(withParsedConfig),
      workerSeenAt: worker.rows[0]?.seen_at ?? null,
      bulks: await this.activeBulks(workspaceId),
    };
  }

  /**
   * Tries Claude again for paused workspaces and carries on if it answers. Without a workspace,
   * this is the worker's own check: pauses that can end by themselves (an account out of credits)
   * are tried every AUTO_CHECK_MS. With one, it's someone pressing Try again: tried right away,
   * whatever the reason. The check is the smallest possible request, so it costs next to nothing.
   */
  async checkPaused(o: { workspaceId?: string; by?: string | null } = {}): Promise<PauseCheck[]> {
    const { db } = this.deps;
    const { rows } = await db.query<{ workspace_id: string; paused_reason: PauseReason; paused_detail: string | null }>(
      o.workspaceId
        ? 'SELECT workspace_id, paused_reason, paused_detail FROM triage_settings WHERE workspace_id = $1 AND paused_reason IS NOT NULL'
        : 'SELECT workspace_id, paused_reason, paused_detail FROM triage_settings WHERE paused_reason IS NOT NULL AND coalesce(paused_checked_at, paused_at) < $1',
      [o.workspaceId ?? Date.now() - AUTO_CHECK_MS],
    );
    const out: PauseCheck[] = [];
    for (const r of rows) {
      if (!o.workspaceId && !autoChecked({ reason: r.paused_reason, detail: r.paused_detail })) continue;
      out.push(await this.tryClaude(r.workspace_id, o.by ?? null, Boolean(o.workspaceId)));
    }
    return out;
  }

  private async tryClaude(workspaceId: string, by: string | null, manual: boolean): Promise<PauseCheck> {
    const { db } = this.deps;
    const key = await resolveApiKey(this.deps, workspaceId);
    if (!key) {
      await recordPauseCheck(db, workspaceId, 'no_key', null);
      return { workspaceId, resumed: false, reason: 'no_key', message: 'There’s no Claude API key yet.' };
    }
    const { config } = await getTriageSettings(db, workspaceId);
    try {
      await this.ai.ping(key.key, config.model);
    } catch (err) {
      const e = err instanceof TriageAiError ? err : new TriageAiError('retry', (err as Error).message);
      if (e.action === 'pause') {
        await recordPauseCheck(db, workspaceId, e.pauseReason ?? 'rejected', e.message);
        if (key.source === 'workspace' && (e.pauseReason === 'key_invalid' || e.pauseReason === 'credits')) await recordKeyCheck(db, workspaceId, stateFromPause(e.pauseReason), e.message).catch(() => {});
        return { workspaceId, resumed: false, reason: e.pauseReason, message: e.message };
      }
      // Claude busy or unreachable: still paused, and tried again later.
      await db.query('UPDATE triage_settings SET paused_checked_at = now_ms() WHERE workspace_id = $1 AND paused_reason IS NOT NULL', [workspaceId]);
      return { workspaceId, resumed: false, reason: null, message: 'Claude couldn’t be reached. Try again in a minute.' };
    }
    await resumeTriage(db, workspaceId);
    if (key.source === 'workspace') await recordKeyCheck(db, workspaceId, 'working', null).catch(() => {});
    await writeTriageLog(db, { workspaceId, source: 'system', result: 'ok', by, message: manual ? 'Claude works again, so triage carried on.' : 'Claude works again, so triage carried on by itself.' });
    this.deps.log.info({ workspace: workspaceId, manual }, 'triage resumed');
    return { workspaceId, resumed: true, reason: null, message: 'Claude works again, so triage carried on.' };
  }

  /** A page of the activity log, newest first (before: an entry id, for the next page). */
  async activityLog(workspaceId: string, o: { result?: LogResult | null; source?: LogSource | null; runId?: string | null; bulkId?: string | null; before?: number | null; limit: number }): Promise<LogRow[]> {
    const params: unknown[] = [workspaceId];
    const bind = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = ['l.workspace_id = $1'];
    if (o.result) where.push(`l.result = ${bind(o.result)}`);
    if (o.source) where.push(`l.source = ${bind(o.source)}`);
    if (o.runId) where.push(`l.run_id = ${bind(o.runId)}`);
    if (o.bulkId) where.push(`l.bulk_id = ${bind(o.bulkId)}`);
    if (o.before) where.push(`l.id < ${bind(o.before)}`);
    const { rows } = await this.deps.db.query<LogRow>(
      `SELECT l.*, s.ref AS ticket_ref, s.repo_id AS ticket_repo_id, COALESCE(x1.title, x2.title) AS title,
         COALESCE(s.repo_owner, ir.owner) AS owner, COALESCE(s.repo_name, ir.name) AS name, COALESCE(s.issue_number, l.number) AS issue_number, run.name AS run_name
       FROM triage_log l
       LEFT JOIN submissions s ON s.id = l.submission_id
       LEFT JOIN issue_index x1 ON x1.repo_id = s.repo_id AND x1.number = s.issue_number
       LEFT JOIN issue_index x2 ON x2.repo_id = l.repo_id AND x2.number = l.number
       LEFT JOIN issue_index_repos ir ON ir.repo_id = l.repo_id
       LEFT JOIN triage_runs run ON run.id = l.run_id
       WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT ${bind(o.limit)}`,
      params,
    );
    return rows;
  }

  // ---- Bulk Apply and Dismiss (inbox and Issues › Triage) -----------------------------------------

  /** The current triage result of a ticket or GitHub issue in this workspace. */
  private async resultOf(workspaceId: string, subject: Subject): Promise<{ row: AnyResultRow; store: StoreName } | null> {
    if (subject.kind === 'ticket') {
      const row = await this.getResult(workspaceId, subject.submissionId);
      return row ? { row, store: 'tickets' } : null;
    }
    const row = await this.getIssueResult(workspaceId, subject.repoId, subject.number);
    return row ? { row, store: 'issues' } : null;
  }

  /** Which of these have a waiting suggestion the matcher takes. */
  async withMatchingSuggestions(workspaceId: string, subjects: Subject[], test: (a: TriageAction) => boolean): Promise<Subject[]> {
    const out: Subject[] = [];
    for (const subject of subjects) {
      const r = await this.resultOf(workspaceId, subject);
      if (r?.row.status === 'done' && (r.row.suggestions ?? []).some(test)) out.push(subject);
    }
    return out;
  }

  /**
   * Starts applying the matching suggestions on these tickets or issues, one at a time in the
   * background. Only suggestions the list's filters are about are applied; others stay.
   */
  async startBulk(workspaceId: string, userId: string, o: { subjects: Subject[]; filter: { triage?: string; conf?: string } }): Promise<{ id: string; count: number }> {
    const { db } = this.deps;
    const settings = await getTriageSettings(db, workspaceId);
    const m = actionMatcher(o.filter, settings.config);
    const subjects = await this.withMatchingSuggestions(workspaceId, o.subjects, m.test);
    if (!subjects.length) throw new UserFacingError('None of these have a matching suggestion waiting.');
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO triage_bulk (id, workspace_id, filter, description, created_by) VALUES ($1, $2, $3, $4, $5)', [id, workspaceId, o.filter, m.describe, userId]);
      for (const [i, subject] of subjects.entries()) {
        await tx.query('INSERT INTO triage_bulk_items (bulk_id, subject, position) VALUES ($1, $2, $3)', [id, subjectValue(subject), i]);
      }
    });
    await writeTriageLog(db, { workspaceId, source: 'review', result: 'info', bulkId: id, by: userId, message: `Bulk apply started: ${m.describe} on ${subjects.length} ticket${subjects.length === 1 ? '' : 's'}, one at a time` });
    return { id, count: subjects.length };
  }

  /** Dismisses the matching suggestions on these tickets or issues right away (nothing goes to GitHub). */
  async dismissBulk(workspaceId: string, userId: string, o: { subjects: Subject[]; filter: { triage?: string; conf?: string } }): Promise<{ tickets: number; suggestions: number }> {
    const { db } = this.deps;
    const settings = await getTriageSettings(db, workspaceId);
    const m = actionMatcher(o.filter, settings.config);
    let tickets = 0;
    let suggestions = 0;
    for (const subject of o.subjects) {
      const r = await this.resultOf(workspaceId, subject);
      if (r?.row.status !== 'done') continue;
      const matched = (r.row.suggestions ?? []).filter(m.test);
      if (!matched.length) continue;
      const rest = (r.row.suggestions ?? []).filter((a) => !matched.includes(a));
      await this.saveReview(r.row, rest, r.row.applied_actions ?? [], r.store, matched.length);
      const event = { by: userId, actions: matched.map(describeAction) };
      if (subject.kind === 'ticket') await addEvent(db, subject.submissionId, 'triage_dismissed', event);
      else await addIssueEvent(db, (r.row as IssueTriageRow).id, 'triage_dismissed', event);
      await writeTriageLog(db, { workspaceId, source: 'review', result: 'ok', ...aboutSubject(subject), by: userId, detail: { dismissed: matched, bulk: true } });
      tickets++;
      suggestions += matched.length;
    }
    return { tickets, suggestions };
  }

  async activeBulks(workspaceId: string): Promise<BulkProgress[]> {
    const { rows } = await this.deps.db.query<BulkProgress>(
      `SELECT b.*, count(i.subject) AS total, sum(i.status = 'pending') AS pending, sum(i.status = 'done') AS done, sum(i.status = 'skipped') AS skipped, sum(i.status = 'failed') AS failed
       FROM triage_bulk b JOIN triage_bulk_items i ON i.bulk_id = b.id
       WHERE b.workspace_id = $1 AND (b.status = 'running' OR b.finished_at > $2)
       GROUP BY b.id ORDER BY b.created_at DESC LIMIT 5`,
      // Finished ones stay visible for a few minutes, so you see how it went.
      [workspaceId, new Date(Date.now() - 10 * 60_000)],
    );
    return rows.map((r) => ({ ...r, pending: Number(r.pending ?? 0), done: Number(r.done ?? 0), skipped: Number(r.skipped ?? 0), failed: Number(r.failed ?? 0) }));
  }

  /** Stops a bulk apply: what's applied stays applied, the rest stays suggested. */
  async stopBulk(workspaceId: string, bulkId: string, userId: string): Promise<number> {
    const { db } = this.deps;
    const res = await db.query(`UPDATE triage_bulk SET status = 'stopped', finished_at = now_ms() WHERE workspace_id = $1 AND id = $2 AND status = 'running'`, [workspaceId, bulkId]);
    if (!res.rowCount) throw new UserFacingError('That bulk apply already finished.', 409);
    const items = await db.query(`UPDATE triage_bulk_items SET status = 'skipped', note = 'Stopped before this ticket', lease_until_at = NULL WHERE bulk_id = $1 AND status = 'pending'`, [bulkId]);
    await writeTriageLog(db, { workspaceId, source: 'review', result: 'info', bulkId, by: userId, message: `Bulk apply stopped: ${items.rowCount} not applied (their suggestions are still there)` });
    return items.rowCount;
  }

  /** Claims the next ticket of a bulk apply (paused workspaces and waiting bulks wait). */
  async claimBulkItem(): Promise<{ bulk_id: string; subject: string } | null> {
    const { rows } = await this.deps.db.query<{ bulk_id: string; subject: string }>(
      `UPDATE triage_bulk_items SET lease_until_at = now_ms() + ($1 * 1000)
       WHERE rowid = (
         SELECT i.rowid FROM triage_bulk_items i JOIN triage_bulk b ON b.id = i.bulk_id
         LEFT JOIN triage_settings t ON t.workspace_id = b.workspace_id
         WHERE i.status = 'pending' AND b.status = 'running' AND (i.lease_until_at IS NULL OR i.lease_until_at < now_ms())
           AND t.paused_reason IS NULL AND (b.waiting_until_at IS NULL OR b.waiting_until_at <= now_ms())
         ORDER BY b.created_at, i.position LIMIT 1
       )
       RETURNING bulk_id, subject`,
      [LEASE_SECONDS],
    );
    return rows[0] ?? null;
  }

  async processBulkItem(item: { bulk_id: string; subject: string }): Promise<void> {
    const { db } = this.deps;
    const { rows } = await db.query<BulkRow>('SELECT * FROM triage_bulk WHERE id = $1', [item.bulk_id]);
    const bulk = rows[0];
    const subject = parseSubject(item.subject);
    if (!bulk || !subject) return;
    const wid = bulk.workspace_id;
    const about = { workspaceId: wid, source: 'review' as const, bulkId: bulk.id, by: bulk.created_by, ...aboutSubject(subject) };
    const finish = async (status: 'done' | 'skipped' | 'failed', note: string | null) => {
      await db.query('UPDATE triage_bulk_items SET status = $3, note = $4, lease_until_at = NULL, done_at = now_ms() WHERE bulk_id = $1 AND subject = $2', [bulk.id, item.subject, status, note]);
    };
    const wait = async (until: Date) => {
      await db.query('UPDATE triage_bulk SET waiting_until_at = $2, waiting_reason = $3 WHERE id = $1', [bulk.id, until, 'github']);
      await db.query('UPDATE triage_bulk_items SET lease_until_at = NULL WHERE bulk_id = $1 AND subject = $2', [bulk.id, item.subject]);
      if (!bulk.waiting_until_at || bulk.waiting_until_at.getTime() <= Date.now()) {
        await writeTriageLog(db, { ...about, submissionId: null, repoId: null, number: null, result: 'info', message: `Waiting until ${until.toISOString().slice(11, 16)} UTC for GitHub’s hourly limit, so new tickets can still be filed` });
      }
    };
    try {
      const conn = await getGitHubConnection(db, wid);
      const githubWait = conn ? this.githubWait(conn.installation_id) : null;
      if (githubWait) return await wait(githubWait);
      if (bulk.waiting_until_at) await db.query('UPDATE triage_bulk SET waiting_until_at = NULL, waiting_reason = NULL WHERE id = $1', [bulk.id]);

      const settings = await getTriageSettings(db, wid);
      const m = actionMatcher(bulk.filter, settings.config);
      const r = await this.resultOf(wid, subject);
      const matched = r?.row.status === 'done' ? (r.row.suggestions ?? []).filter(m.test) : [];
      if (!r || !matched.length) {
        await finish('skipped', 'Nothing matching is waiting any more');
        await writeTriageLog(db, { ...about, result: 'skipped', message: 'Nothing matching is waiting any more' });
        return;
      }
      const target: Target | null = subject.kind === 'ticket' ? await getSubmission(db, wid, subject.submissionId) : await this.issueTarget(wid, subject.repoId, subject.number);
      const ticket = target ? ticketOf(target) : null;
      if (!target || !target.issue_number || (ticket && ticket.status !== 'created')) {
        await finish('skipped', 'It’s no longer on GitHub');
        await writeTriageLog(db, { ...about, result: 'skipped', message: 'It’s no longer on GitHub' });
        return;
      }
      try {
        await applyToGitHub(this.deps, target, matched);
      } catch (err) {
        if (isGitHubRateLimit(err)) return await wait(new Date(Date.now() + (err.retryAfterSeconds ?? 60) * 1000));
        const note = `GitHub didn’t accept the change: ${githubMessage(err)}. The suggestions are still there.`;
        await finish('failed', note);
        await writeTriageLog(db, { ...about, ref: target.ref, result: 'failed', message: note, detail: { suggested: matched, bulk: true } });
        return;
      }
      const rest = (r.row.suggestions ?? []).filter((a) => !matched.includes(a));
      await this.saveReview(r.row, rest, [...(r.row.applied_actions ?? []), ...matched], r.store);
      const told = ticket ? await tellMember(this.deps, ticket, matched) : false;
      const event = { by: bulk.created_by, actions: matched.map(describeAction), told_member: told };
      if (ticket) await addEvent(db, ticket.id, 'triage_applied', event);
      else await addIssueEvent(db, (r.row as IssueTriageRow).id, 'triage_applied', event);
      await finish('done', null);
      await writeTriageLog(db, { ...about, ref: target.ref, result: 'ok', detail: { applied: matched, toldMember: told, bulk: true } });
    } catch (err) {
      this.deps.log.error({ err: (err as Error).message, bulk: bulk.id, subject: item.subject }, 'bulk apply failed unexpectedly');
      await finish('failed', 'Unexpected error');
      await writeTriageLog(db, { ...about, result: 'failed', message: 'Unexpected error' });
    } finally {
      const done = await db.query(
        `UPDATE triage_bulk SET status = 'done', finished_at = now_ms(), waiting_until_at = NULL WHERE id = $1 AND status = 'running'
           AND NOT EXISTS (SELECT 1 FROM triage_bulk_items WHERE bulk_id = $1 AND status = 'pending')`,
        [bulk.id],
      );
      if (done.rowCount) {
        const { rows: c } = await db.query<{ done: number; skipped: number; failed: number }>(`SELECT sum(status = 'done') AS done, sum(status = 'skipped') AS skipped, sum(status = 'failed') AS failed FROM triage_bulk_items WHERE bulk_id = $1`, [bulk.id]);
        const x = c[0];
        await writeTriageLog(db, { workspaceId: wid, source: 'review', result: x?.failed ? 'failed' : 'info', bulkId: bulk.id, by: bulk.created_by, message: `Bulk apply finished: ${Number(x?.done ?? 0)} applied${x?.skipped ? `, ${x.skipped} skipped` : ''}${x?.failed ? `, ${x.failed} failed` : ''}` });
      }
    }
  }
}

/** Triage summaries for a page of tickets (inbox priority column). */
export async function triageSummaries(q: Queryable, workspaceId: string, ids: string[]): Promise<Map<string, Pick<TriageResultRow, 'status' | 'priority' | 'is_duplicate' | 'is_spam' | 'is_support' | 'suggestion_count' | 'suggestions' | 'dismissed_count'> & { applied_count: number }>> {
  if (!ids.length) return new Map();
  const { rows } = await q.query<TriageResultRow & { applied_count: number }>(
    'SELECT submission_id, status, priority, is_duplicate, is_spam, is_support, suggestion_count, suggestions, dismissed_count, json_array_length(COALESCE(applied_actions, \'[]\')) AS applied_count FROM triage_results WHERE workspace_id = $1 AND submission_id IN (SELECT value FROM json_each($2))',
    [workspaceId, ids],
  );
  return new Map(rows.map((r) => [r.submission_id, r]));
}
