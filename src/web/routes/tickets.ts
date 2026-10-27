import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can } from '../../domain/permissions.js';
import { getGitHubConnection, listApps } from '../../domain/store.js';
import { GitHubApiError } from '../../github/client.js';
import { parseIssueBody, type IssueText } from '../../github/issue-content.js';
import { countByStatus, decryptPayload, getSubmission, listEvents, listSubmissions, type SubmissionFilter } from '../../domain/submissions.js';
import { actionMatcher, CONFIDENCE_STEPS, confidenceFilter, TRIAGE_STATES, triageFilter as parseTriageFilter, triageFilterGroups, triageState } from '../../triage/state.js';
import { bulkBanner, bulkBar } from './triage-bulk.js';
import { describeAction, triageSummaries, type TriageAction, type TriageResultRow } from '../../triage/engine.js';
import { actionEffects, actionEffectsShort, actionTitle, priorityTag } from '../triage-view.js';
import { getTriageSettings, type Priority } from '../../triage/settings.js';
import { listTicketTypes } from '../../domain/ticket-types.js';
import { listTicketFiles } from '../../domain/files.js';
import { filesCard } from './files.js';
import { UserFacingError, type SubmissionRow, type SubmissionStatus } from '../../domain/types.js';
import { updateTicketLimits, userNames } from '../../domain/workspaces.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { setFlash } from '../session.js';
import type { Web } from '../server.js';
import { questionAnchor } from '../../triage/knowledge.js';
import { knowledgeLink, toolHeader, viewOnlyText } from './tool.js';
import { viewOnlyFooter } from './triage.js';
import {
  avatar,
  choices,
  copyBtn,
  csrfField,
  dialog,
  empty,
  formatDate,
  icon,
  labelTag,
  linkBtn,
  menu,
  notice,
  pageHeader,
  pill,
  plural,
  postBtn,
  segLinks,
  selectWrap,
  setting,
  statusPill,
  submitBtn,
  tag,
  TICKET_STATUS,
  timeAgo,
  typeIcon,
  viewOnlyTag,
  when,
  type IconName,
} from '../ui.js';

const PAGE_SIZE = 25;

// ---- Status explanations -------------------------------------------------------------------------

const ERROR_REASONS: Record<string, string> = {
  issues_disabled: 'Issues disabled in the repository',
  repo_not_accessible: 'Repository not accessible',
  missing_permission: 'The app can’t create issues there',
  installation_missing: 'GitHub App uninstalled',
  installation_suspended: 'GitHub App suspended',
  app_credentials_invalid: 'App credentials rejected',
  github_auth_failed: 'GitHub sign-in failed',
  github_rejected: 'GitHub rejected the issue',
  invalid_labels: 'Labels rejected',
  payload_missing: 'Ticket text no longer stored',
  github_not_configured: 'GitHub not configured',
  github_rate_limited: 'GitHub rate limit',
  github_server_error: 'GitHub had an error',
  github_unreachable: 'GitHub unreachable',
  internal_error: 'Unexpected error',
};

/** The short line under a ticket's status in lists. */
function statusReason(s: SubmissionRow, names: Map<string, string>): string | null {
  switch (s.status) {
    case 'uncertain':
      return s.next_attempt_at ? (s.next_attempt_at.getTime() > Date.now() ? `Checking GitHub again ${timeAgo(s.next_attempt_at)}` : 'Checking GitHub shortly') : 'Not confirmed on GitHub';
    case 'failed':
      return ERROR_REASONS[s.error_code ?? ''] ?? 'Couldn’t be filed';
    case 'pending':
      return s.next_attempt_at && s.next_attempt_at.getTime() > Date.now() ? `Retrying ${timeAgo(s.next_attempt_at)}` : 'Waiting to be filed';
    case 'processing':
      return 'Filing now';
    case 'dismissed': {
      const by = s.resolved_by ? names.get(s.resolved_by) : null;
      return [by ? `By ${by}` : 'Closed without filing', s.resolution_note].filter(Boolean).join(' · ');
    }
    default:
      return null;
  }
}

function appLine(s: SubmissionRow): string {
  return [s.app_name, s.ticket_type_name].filter(Boolean).join(' · ');
}

function issueRef(s: SubmissionRow): SafeHtml {
  return s.issue_url
    ? html`<a class="inline gap-4 nowrap" href="${s.issue_url}" target="_blank" rel="noopener noreferrer">${icon('circle-dot', 14, 'muted')}${s.repo_name}#${String(s.issue_number)}</a>`
    : html`<span class="em">—</span>`;
}

/**
 * Ticket list: a table on desktop and stacked rows on phones. Rows carry `data-search`
 * (title, reporter, reference, app) for the inbox's instant filter.
 */
export function ticketList(base: string, rows: SubmissionRow[], titleOf: (s: SubmissionRow) => string | null, names: Map<string, string>, o: { compact?: boolean; triage?: Map<string, TriageSummary>; select?: { matches: (s: SubmissionRow) => boolean } } = {}): SafeHtml {
  const view = rows.map((s) => {
    const title = titleOf(s) ?? s.ref;
    return { s, title, href: `${base}/tickets/${s.id}`, search: [title, s.reporter_display_name, s.reporter_username, s.ref, s.app_name].filter(Boolean).join(' ').toLowerCase(), reason: statusReason(s, names) };
  });
  const test = (s: SubmissionRow) => (s.source === 'admin_test' ? html` ${tag('Test')}` : '');
  // Bulk Apply/Dismiss: every ticket can be ticked (desktop table); data-match marks the ones
  // with a matching suggestion, so the bar and the confirmation can say how many count.
  const selectable = o.select ?? null;
  return html`<div class="table-wrap only-desktop" data-search-wrap><table>
      <thead><tr>${selectable ? html`<th class="check-col"><input type="checkbox" class="rule-check" data-select-all="bulk-triage" aria-label="Select every ticket on this page"></th>` : ''}<th class="col-main">Ticket</th>${o.compact ? '' : html`<th>Reporter</th>`}<th>Status</th>${o.triage ? html`<th>Triage</th>` : ''}${o.compact ? '' : html`<th>GitHub issue</th>`}<th class="num">Updated</th></tr></thead>
      <tbody>${view.map((v) => html`<tr class="click" data-search="${v.search}">
        ${selectable ? html`<td class="check-col"><input type="checkbox" class="rule-check" name="ticket" value="sub:${v.s.id}" form="bulk-triage" ${selectable.matches(v.s) ? raw('data-match') : ''} aria-label="Select ${v.title}"></td>` : ''}
        <td><a class="cell-title" href="${v.href}">${v.title}</a>${test(v.s)}<div class="sub">${appLine(v.s)}</div></td>
        ${o.compact ? '' : html`<td><span class="who-cell">${avatar(v.s.reporter_display_name, 20)}<span class="small">${v.s.reporter_display_name}</span></span></td>`}
        <td>${statusPill(v.s.status)}${v.reason && !o.compact ? html`<div class="sub">${v.reason}</div>` : ''}</td>
        ${o.triage ? html`<td>${triageCell(o.triage.get(v.s.id))}</td>` : ''}
        ${o.compact ? '' : html`<td>${issueRef(v.s)}</td>`}
        <td class="num">${when(v.s.updated_at)}</td></tr>`)}</tbody></table></div>
    <ul class="list only-mobile" data-search-wrap>${view.map((v) => html`<li data-search="${v.search}"><a class="list-row" href="${v.href}">
      <span class="l1">${v.title}</span>${statusPill(v.s.status)}
      <span class="l2">${o.triage ? triageCell(o.triage.get(v.s.id), true) : ''}${[appLine(v.s), v.s.reporter_display_name, timeAgo(v.s.updated_at)].filter(Boolean).join(' · ')}</span></a></li>`)}</ul>`;
}

export type TriageSummary = { status: string; priority: Priority | null; is_duplicate: number; is_spam: number; is_support: number; suggestion_count: number; suggestions?: TriageAction[] | null; applied_count?: number | null; applied_actions?: TriageAction[] | null; dismissed_count?: number | null };

/** The tone of each triage status pill. */
export const TRIAGE_STATE_TONE = { queued: 'neutral', review: 'warn', partial: 'warn', applied: 'ok', reviewed: 'closed', nothing: 'neutral', skipped: 'closed', failed: 'danger' } as const;

export { priorityTag };

/** Priority and flags from triage, for the inbox. */
export function triageCell(t: TriageSummary | undefined, compact = false): SafeHtml | string {
  if (!t) return compact ? '' : html`<span class="em">—</span>`;
  const state = triageState(t);
  const tip = state === 'review'
    ? (t.suggestions ?? []).map((a) => `Suggested: ${describeAction(a)} (${actionEffectsShort(a)})`).join('\n') || TRIAGE_STATES.review.desc
    : TRIAGE_STATES[state].desc;
  const parts = [
    tag(html`<span class="dot s-${state}" aria-hidden="true"></span>${TRIAGE_STATES[state].label}`, { title: tip }),
    t.priority ? priorityTag(t.priority) : '',
    t.is_spam ? tag('Spam') : '',
    t.is_support ? tag('Not a dev issue') : '',
    t.is_duplicate ? tag('Duplicate') : '',
  ].filter(Boolean);
  return html`<span class="tags">${parts}</span>`;
}

// ---- Inbox filters ---------------------------------------------------------------------------------

const FILTERS: { key: string; label: string; status?: SubmissionFilter }[] = [
  { key: 'attention', label: 'Needs attention', status: 'attention' },
  { key: 'open', label: 'Queued', status: 'open' },
  { key: 'filed', label: 'Filed', status: 'created' },
  { key: 'closed', label: 'Closed', status: 'dismissed' },
  { key: 'all', label: 'All' },
];

/** Old status filter values still work in bookmarked links. */
const LEGACY_FILTERS: Record<string, string> = { created: 'filed', pending: 'open', processing: 'open', uncertain: 'attention', failed: 'attention', dismissed: 'closed', '': 'all' };

// ---- Activity --------------------------------------------------------------------------------------

type EventRow = Awaited<ReturnType<typeof listEvents>>[number];

function eventView(e: EventRow, s: SubmissionRow, names: Map<string, string>): { icon?: IconName; tone?: string; actor?: string; text: SafeHtml } {
  const d = e.detail;
  const by = typeof d.by === 'string' ? names.get(d.by) ?? 'An admin' : 'An admin';
  const repo = `${s.repo_owner}/${s.repo_name}`;
  const n = typeof d.issue_number === 'number' ? d.issue_number : s.issue_number;
  const reason = typeof d.code === 'string' ? ERROR_REASONS[d.code] : undefined;
  switch (e.kind) {
    case 'accepted':
      return { actor: s.reporter_display_name, text: html`<span class="actor">${s.reporter_display_name}</span> ${s.source === 'admin_test' ? 'sent a test ticket from the console' : 'submitted from Discord'}` };
    case 'labels_skipped':
      return { icon: 'triangle-alert', tone: 'warn', text: html`Skipped labels that no longer exist${Array.isArray(d.missing) ? html`: <span class="mono">${(d.missing as string[]).join(', ')}</span>` : ''}` };
    case 'github_request_sent':
      return { icon: 'send', tone: 'muted', text: html`Sent to GitHub (<span class="mono">${repo}</span>)` };
    case 'issue_created':
      return { icon: 'circle-check', tone: 'ok', text: html`Created issue ${s.repo_name}#${String(n ?? '')}` };
    case 'retry_scheduled':
      return { icon: 'clock', tone: 'muted', text: html`Queued: ${reason ?? 'GitHub was unavailable'}. Retrying automatically${typeof d.delay_seconds === 'number' ? ` in ${Math.max(1, Math.round(d.delay_seconds / 60))} min` : ''}` };
    case 'retry_without_labels':
      return { icon: 'rotate-ccw', tone: 'muted', text: html`Retrying without labels` };
    case 'failed':
      return { icon: 'circle-x', tone: 'danger', text: html`Failed: ${reason ?? 'couldn’t be filed'}` };
    case 'uncertain':
      return { icon: 'circle-help', tone: 'warn', text: html`GitHub didn’t confirm the issue` };
    case 'reconciled_found':
      return { icon: 'circle-check', tone: 'ok', text: html`Found the issue on GitHub (#${String(n ?? '')})` };
    case 'reconciled_not_found':
      return { icon: 'circle-help', tone: 'warn', text: html`Checked GitHub: no matching issue yet` };
    case 'reconcile_error':
      return { icon: 'triangle-alert', tone: 'warn', text: html`Couldn’t reach GitHub to check` };
    case 'admin_recheck':
      return { actor: by, text: html`<span class="actor">${by}</span> checked GitHub` };
    case 'admin_retry':
      return { actor: by, text: html`<span class="actor">${by}</span> retried` };
    case 'admin_linked_issue':
      return { actor: by, text: html`<span class="actor">${by}</span> linked issue #${String(n ?? '')}` };
    case 'admin_dismissed':
      return { actor: by, text: html`<span class="actor">${by}</span> closed it without filing${s.resolution_note ? ` · ${s.resolution_note}` : ''}` };
    case 'files_stored': {
      const stored = Number(d.stored ?? 0);
      const failed = Number(d.failed ?? 0);
      return { icon: failed ? 'triangle-alert' : 'paperclip', tone: failed ? 'warn' : 'muted', text: html`${stored ? `Saved ${plural(stored, 'attached file')}` : ''}${stored && failed ? ' · ' : ''}${failed ? `${plural(failed, 'file')} couldn’t be attached` : ''}` };
    }
    case 'files_added':
      return { actor: by, text: html`<span class="actor">${by}</span> added ${plural(Number(d.count ?? 1), 'file')}` };
    case 'files_deleted': {
      const n = plural(Number(d.count ?? 1), 'file');
      if (d.reason === 'manual' && typeof d.by === 'string') return { actor: by, text: html`<span class="actor">${by}</span> deleted ${n}` };
      if (typeof d.by === 'string') return { actor: by, text: html`<span class="actor">${by}</span> deleted ${n} in a cleanup` };
      return { icon: 'trash-2', tone: 'muted', text: html`Deleted ${n} ${d.reason === 'spam' ? 'from a spam ticket' : 'in the automatic cleanup'}` };
    }
    case 'triage_done': {
      const applied = Array.isArray(d.applied) ? (d.applied as string[]) : [];
      const suggested = Array.isArray(d.suggested) ? (d.suggested as string[]) : [];
      const text = [applied.length ? `applied ${applied.join(', ')}` : '', suggested.length ? `suggested ${suggested.join(', ')}` : ''].filter(Boolean).join(' · ');
      return { icon: 'bot', tone: 'muted', text: html`Triage ${text || 'found nothing to flag'}${d.told_member ? ' · told the member in Discord' : ''}` };
    }
    case 'triage_applied':
      return { actor: by, text: html`<span class="actor">${by}</span> applied the triage suggestion: ${(d.actions as string[] | undefined)?.join(', ') ?? ''}${d.told_member ? ' · told the member in Discord' : ''}` };
    case 'triage_rerun': {
      const applied = Array.isArray(d.applied) ? (d.applied as string[]) : [];
      const suggested = Array.isArray(d.suggested) ? (d.suggested as string[]) : [];
      const text = [applied.length ? `applied ${applied.join(', ')}` : '', suggested.length ? `suggested ${suggested.join(', ')}` : ''].filter(Boolean).join(' · ');
      return { icon: 'history', tone: 'muted', text: html`Triage re-run ${text || 'found nothing to flag'}${typeof d.by === 'string' ? html` · by <span class="actor">${by}</span>` : ''}` };
    }
    case 'triage_dismissed':
      return { actor: by, text: html`<span class="actor">${by}</span> dismissed the triage suggestion: ${(d.actions as string[] | undefined)?.join(', ') ?? ''}` };
    case 'triage_labels':
      return { icon: 'tags', tone: 'muted', text: html`Custom labels added: ${(d.labels as string[] | undefined)?.join(', ') ?? ''}${typeof d.by === 'string' ? html` · by <span class="actor">${by}</span>` : ''}` };
    default:
      return { icon: 'info', tone: 'muted', text: html`${e.kind}` };
  }
}

// ---- Triage card ------------------------------------------------------------------------------------

type RepoOf = Pick<SubmissionRow, 'repo_owner' | 'repo_name'>;

function triageActionText(a: TriageAction, s: RepoOf, o: { applied?: boolean } = {}): SafeHtml {
  return html`<span class="grow">${actionTitle(a, { owner: s.repo_owner, name: s.repo_name }, o)}</span><span class="xs muted num" title="Claude’s confidence">${String(a.confidence)}%</span>`;
}

function issueLink(s: RepoOf, n: number): SafeHtml {
  return html`<a href="https://github.com/${s.repo_owner}/${s.repo_name}/issues/${String(n)}" target="_blank" rel="noopener noreferrer">#${String(n)}</a>`;
}

/** How the original was chosen among Claude's matches. */
function duplicateNote(t: Pick<TriageResultRow, 'verdict'>, s: RepoOf): SafeHtml | string {
  const v = t.verdict;
  if (!v || !v.duplicate_of) return '';
  const others = v.duplicate_others ?? [];
  const parts = [
    v.duplicate_via ? html`Claude matched ${issueLink(s, v.duplicate_via)}, which copies ${issueLink(s, v.duplicate_of)}, so the original is linked.` : '',
    others.length ? html`Also similar: ${others.slice(0, 5).map((n, i) => html`${i ? ', ' : ''}${issueLink(s, n)}`)}.` : '',
  ].filter(Boolean);
  return parts.length ? html`<p class="small muted mt-8">${parts.map((p, i) => html`${i ? ' ' : ''}${p}`)}</p>` : '';
}

/**
 * What Claude says would have made it surer, with a link to answer it in the app's TRIAGE.md.
 * Only the team sees it: it's never part of a comment or a member message.
 */
function triageQuestion(question: string, knowledge: { href: string; edit: boolean } | null | undefined): SafeHtml {
  return html`<div class="tri-ask" title="Only your team sees this">${icon('lightbulb', 14)}<div>
    <span class="k">Claude would be surer if it knew</span><p>${question}</p>
    ${knowledge ? html`<a href="${knowledge.href}#${questionAnchor(question)}">${knowledge.edit ? 'Answer it in Knowledge' : 'See it in Knowledge'}${icon('arrow-right', 12)}</a>` : ''}
  </div></div>`;
}

/** What triage decided, with Apply and Dismiss for suggestions (tickets, and issues opened on GitHub). */
export function triageCard(t: Omit<TriageResultRow, 'submission_id'>, s: RepoOf, o: { act: boolean; csrf: string; actionBase: string; knowledge?: { href: string; edit: boolean } | null }): SafeHtml {
  const state = triageState(t);
  const status = pill(TRIAGE_STATES[state].label, TRIAGE_STATE_TONE[state]);
  let content: SafeHtml;
  if (t.status === 'done') {
    const applied = t.applied_actions ?? [];
    const suggestions = t.suggestions ?? [];
    content = html`
      ${t.verdict?.summary ? html`<p class="small tri-summary">${t.verdict.summary}${t.verdict.version ? html`<span class="muted"> · version ${t.verdict.version}</span>` : ''}</p>` : ''}
      ${applied.map((a) => html`<div class="tri-row tri-suggest">${icon('circle-check', 14, 'ok')}${triageActionText(a, s, { applied: true })}
        <details class="tri-more"><summary>${icon('chevron-right', 14, 'chev')}What was done<span class="muted"> · ${actionEffectsShort(a)}</span></summary>${actionEffects(a, { done: true })}</details></div>`)}
      ${suggestions.map((a) => html`<div class="tri-row tri-suggest">${icon('circle-help', 14, 'warn')}${triageActionText(a, s)}
        <details class="tri-more" ${suggestions.length <= 2 ? raw('open') : ''}><summary>${icon('chevron-right', 14, 'chev')}What Apply does<span class="muted"> · ${actionEffectsShort(a)}</span></summary>${actionEffects(a)}</details>
        ${o.act
        ? html`<span class="tri-actions">${postBtn(`${o.actionBase}/triage/apply`, 'Apply', o.csrf, { size: 'sm', fields: { kind: a.kind }, title: `Apply: ${describeAction(a)}` })}${postBtn(`${o.actionBase}/triage/dismiss`, 'Dismiss', o.csrf, { size: 'sm', variant: 'ghost', fields: { kind: a.kind } })}</span>`
        : ''}</div>`)}
      ${!applied.length && !suggestions.length ? html`<p class="small muted">Nothing to flag.</p>` : ''}
      ${duplicateNote(t, s)}
      ${t.verdict?.reason ? html`<p class="small muted mt-8">“${t.verdict.reason}”</p>` : ''}
      ${t.verdict?.missing_context ? triageQuestion(t.verdict.missing_context, o.knowledge) : ''}
      ${t.error ? html`<p class="small mt-8">${icon('triangle-alert', 14, 'warn')} ${t.error}</p>` : ''}
      <p class="xs faint mt-8">${t.model ?? ''}${t.completed_at ? ` · ${timeAgo(t.completed_at)}` : ''}</p>`;
  } else if (t.status === 'pending') {
    content = html`<p class="small muted">Waiting to be triaged${t.error ? `. Last try: ${t.error}` : '.'}</p>`;
  } else {
    content = html`<p class="small muted">${t.status === 'skipped' ? t.skip_reason ?? 'Skipped' : t.error ?? 'Couldn’t be triaged'}.</p>`;
  }
  return html`<div class="card"><div class="card-h"><div class="title">${icon('bot', 16)}<h2>Triage</h2></div>${status}</div><div class="card-b tight">${content}</div></div>`;
}

/** The issue's text as it is on GitHub now, for filed tickets. Nothing is stored except its state. */
type LiveIssue = { kind: 'ok'; text: IssueText; state: 'open' | 'closed'; stateReason: string | null } | { kind: 'missing' } | { kind: 'error' };

const LIVE_TIMEOUT_MS = 5000;

async function loadLiveIssue(deps: Web['deps'], s: SubmissionRow): Promise<LiveIssue> {
  if (!deps.github || !s.issue_number) return { kind: 'error' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const conn = await getGitHubConnection(deps.db, s.workspace_id);
    const detail = await Promise.race([
      deps.github.getIssueDetail(conn?.installation_id ?? s.installation_id, s.repo_owner, s.repo_name, s.issue_number),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), LIVE_TIMEOUT_MS); }),
    ]);
    // Keep the Files tab's view of the issue current while we're here.
    await deps.db.query('UPDATE submissions SET issue_state = $2, issue_state_reason = $3, issue_closed_at = $4, issue_checked_at = now_ms() WHERE id = $1', [s.id, detail.state, detail.stateReason, detail.closedAt]);
    return { kind: 'ok', text: parseIssueBody(detail.body), state: detail.state, stateReason: detail.stateReason };
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 404 || err.status === 410)) {
      await deps.db.query(`UPDATE submissions SET issue_state = 'missing', issue_checked_at = now_ms() WHERE id = $1`, [s.id]);
      return { kind: 'missing' };
    }
    return { kind: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

function issueStatePill(live: LiveIssue): SafeHtml | string {
  if (live.kind === 'missing') return pill('Deleted on GitHub', 'warn');
  if (live.kind !== 'ok') return '';
  if (live.state === 'open') return pill('Open', 'ok');
  return pill(live.stateReason === 'not_planned' ? 'Closed · not planned' : live.stateReason === 'duplicate' ? 'Closed · duplicate' : 'Closed', 'closed');
}

function ticketText(description: string, answers: IssueText['answers']): SafeHtml {
  return html`${description ? html`<p class="ticket-text">${description}</p>` : html`<p class="small muted">No description.</p>`}${answers.map((a) => html`<h3 class="answer-q">${a.question}</h3><p class="ticket-text">${a.value}</p>`)}`;
}

const CLOSE_REASONS = [
  { value: 'Spam', title: 'Spam', desc: 'Not a real ticket.' },
  { value: 'Duplicate', title: 'Duplicate', desc: 'Already reported in another issue.' },
  { value: 'Resolved elsewhere', title: 'Resolved elsewhere', desc: 'Handled in Discord or another channel.' },
  { value: 'Other', title: 'Other', desc: 'Add a note below.' },
];

/** The inbox's filters, from its query string. */
export type InboxQuery = { status?: string; q?: string; app?: string; type?: string; triage?: string; conf?: string };

/** The inbox's filters, read once for the list and for "Select all in this list" (bulk Apply). */
export async function inboxFilters(deps: Web['deps'], wid: string, q: InboxQuery) {
  const [counts, apps, types, triageSettings] = await Promise.all([countByStatus(deps.db, wid), listApps(deps.db, wid), listTicketTypes(deps.db, wid), getTriageSettings(deps.db, wid)]);
  const n = {
    attention: counts.failed + counts.uncertain,
    open: counts.pending + counts.processing,
    filed: counts.created,
    closed: counts.dismissed,
    all: Object.values(counts).reduce((x, y) => x + y, 0),
  } as Record<string, number>;
  const requested = q.status === undefined ? undefined : LEGACY_FILTERS[q.status] ?? q.status;
  const filter = FILTERS.find((f) => f.key === requested) ?? (n.attention ? FILTERS[0]! : FILTERS[4]!);
  const search = (q.q ?? '').trim().slice(0, 100);
  const appId = apps.some((a) => a.id === q.app) ? q.app : undefined;
  const typeName = types.some((t) => t.name === q.type) ? q.type : undefined;
  const triageOn = triageSettings.enabled || (await deps.db.query('SELECT 1 FROM triage_results WHERE workspace_id = $1 LIMIT 1', [wid])).rows.length > 0;
  const triageSpec = triageOn ? parseTriageFilter(q.triage, triageSettings.config) : null;
  const confSpec = triageOn ? confidenceFilter(q.conf) : null;
  const list = {
    triage: [triageSpec, confSpec].filter((x) => x !== null),
    status: filter.status,
    search: search || undefined,
    appId,
    ticketType: typeName,
  };
  return { n, filter, search, appId, typeName, triageSettings, triageOn, triageSpec, confSpec, apps, types, list };
}

export function registerTicketRoutes(app: FastifyInstance, web: Web): void {
  const { deps, processor } = web;

  // Old URLs keep working.
  app.get('/w/:wid/submissions', async (req, reply) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return reply.redirect(`/w/${(req.params as { wid: string }).wid}/tickets${qs}`);
  });
  app.get('/w/:wid/submissions/:id', async (req, reply) => {
    const p = req.params as { wid: string; id: string };
    return reply.redirect(`/w/${p.wid}/tickets/${p.id}`);
  });

  // ---- Inbox ------------------------------------------------------------------------------------

  app.get('/w/:wid/tickets', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'inbox.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    const q = req.query as InboxQuery & { page?: string };
    const { n, filter, search, appId, typeName, triageSettings, triageOn, triageSpec, confSpec, apps, types, list } = await inboxFilters(deps, wid, q);
    const triageFilter = triageSpec?.value;
    const conf = confSpec?.value;
    const page = Math.max(1, Number(q.page) || 1);
    const { rows, total } = await listSubmissions(deps.db, wid, { ...list, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
    const names = await userNames(deps.db, rows.map((r) => r.resolved_by));
    const triage = triageOn ? await triageSummaries(deps.db, wid, rows.map((r) => r.id)) : undefined;
    // Bulk Apply/Dismiss of the suggestions these filters are about.
    const act = triageOn && can(ctx.membership, 'triage.review.edit');
    const matcher = actionMatcher({ triage: triageSpec?.value, conf: confSpec?.value }, triageSettings.config);
    const matches = (s: SubmissionRow) => {
      const t = triage?.get(s.id);
      return t?.status === 'done' && (t.suggestions ?? []).some(matcher.test);
    };
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const link = (p: Record<string, string | number | undefined>) => {
      const params = new URLSearchParams();
      const merged = { status: filter.key, q: search || undefined, app: appId, type: typeName, triage: triageFilter, conf, ...p };
      for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== '') params.set(k, String(v));
      return `${b}/tickets?${params.toString()}`;
    };
    const filtered = Boolean(search || appId || typeName || triageFilter || conf);
    const emptyState = rows.length
      ? ''
      : filtered
        ? empty('search-x', 'No tickets match these filters', 'Try another search, app, type or triage filter.', linkBtn(link({ q: undefined, app: undefined, type: undefined, triage: undefined, conf: undefined, page: undefined }), 'Clear filters'))
        : filter.key === 'attention'
          ? empty('circle-check', 'All caught up', 'No tickets need attention.', linkBtn(link({ status: 'all', page: undefined }), 'View all tickets', { variant: 'ghost' }), 'ok')
          : n.all === 0
            ? empty('inbox', 'No tickets yet', 'Tickets appear here as soon as members use the panel in Discord.')
            : empty('inbox', 'No tickets here', 'Nothing matches this filter.');

    const body = html`
      ${await toolHeader(web, ctx, 'tickets', 'inbox')}
      <div class="card">
        <div class="toolbar">
          ${segLinks('Filter by status', FILTERS.map((f) => ({ href: link({ status: f.key, page: undefined }), label: f.label, count: n[f.key], current: f.key === filter.key })))}
          <form method="get" action="${b}/tickets" class="tools" role="search">
            <input type="hidden" name="status" value="${filter.key}">
            <span class="search sm">${icon('search', 14)}<input type="search" name="q" value="${search}" placeholder="Title, reporter or reference" aria-label="Search tickets" data-filter-rows="#ticket-rows" data-filter-empty="no-match"></span>
            <button type="button" class="btn sm filters-btn" data-toggle-filters="ticket-filters" aria-expanded="false" aria-controls="ticket-filters"><span class="lead">${icon('list-filter', 14)}</span><span class="lbl">Filters</span></button>
            <div class="row filter-selects" id="ticket-filters">
              ${selectWrap(html`<select name="app" aria-label="Filter by app" data-autosubmit><option value="">All apps</option>${apps.map((a) => html`<option value="${a.id}" ${a.id === appId ? raw('selected') : ''}>${a.name}</option>`)}</select>`, { sm: true })}
              ${types.length ? selectWrap(html`<select name="type" aria-label="Filter by type" data-autosubmit><option value="">All types</option>${types.map((t) => html`<option value="${t.name}" ${t.name === typeName ? raw('selected') : ''}>${t.name}</option>`)}</select>`, { sm: true }) : ''}
              ${triageOn ? selectWrap(html`<select name="triage" aria-label="Filter by triage" data-autosubmit><option value="">All triage</option>${triageFilterGroups(triageSettings.config, { untriaged: true }).map((g) => html`<optgroup label="${g.label}">${g.options.map((o) => html`<option value="${o.value}" ${o.value === triageFilter ? raw('selected') : ''}>${o.label}</option>`)}</optgroup>`)}</select>`, { sm: true }) : ''}
              ${triageOn ? selectWrap(html`<select name="conf" aria-label="Filter by triage confidence" data-autosubmit><option value="">Any confidence</option>${CONFIDENCE_STEPS.map((c) => html`<option value="${String(c)}" ${String(c) === conf ? raw('selected') : ''}>Confidence ${String(c)}%+</option>`)}</select>`, { sm: true }) : ''}
            </div>
            <button type="submit" class="btn sm nojs">Apply</button>
          </form>
        </div>
        ${act ? await bulkBanner(web, ctx) : ''}
        ${act && rows.length ? bulkBar(ctx, { matcher, selectable: rows.length, matching: total, from: 'inbox', hidden: { status: filter.key, q: search || undefined, app: appId, type: typeName, triage: triageFilter, conf }, back: link({ page }) }) : ''}
        <div class="card-b flush" id="ticket-rows">
          ${rows.length ? ticketList(b, rows, (s) => decryptPayload(deps.box, s)?.title ?? null, names, { triage, select: act ? { matches } : undefined }) : emptyState}
          <div id="no-match" hidden>${empty('search-x', 'No tickets match', html`Nothing on this page matches “<span data-term></span>”. Press Enter to search all tickets by reporter or reference.`, html`<button type="button" class="btn" data-clear-search>Clear search</button>`)}</div>
        </div>
        ${pages > 1 ? html`<div class="pager"><span>Page ${String(page)} of ${String(pages)} · ${plural(total, 'ticket')}</span><div class="row">
          ${page > 1 ? linkBtn(link({ page: page - 1 }), 'Previous', { size: 'sm', icon: 'chevron-left' }) : ''}${page < pages ? linkBtn(link({ page: page + 1 }), 'Next', { size: 'sm', trail: 'chevron-right' }) : ''}</div></div>` : ''}
      </div>`;
    return web.render(reply, ctx, 'Discord tickets', 'tickets', body, { width: 'full' });
  });

  // ---- Ticket detail ----------------------------------------------------------------------------

  app.get('/w/:wid/tickets/:id', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'inbox.view' });
    if (!ctx) return reply;
    const s = await getSubmission(deps.db, ctx.workspace.id, (req.params as { id: string }).id);
    if (!s) return reply.callNotFound();
    const b = ctx.base;
    const events = await listEvents(deps.db, s.id);
    const triageRow = await web.triage.getResult(ctx.workspace.id, s.id);
    const files = await listTicketFiles(deps.db, s.id);
    const names = await userNames(deps.db, [s.resolved_by, ...events.map((e) => (typeof e.detail.by === 'string' ? e.detail.by : null)), ...files.flatMap((f) => [f.added_by, f.deleted_by])]);
    const payload = decryptPayload(deps.box, s);
    const live: LiveIssue | null = s.status === 'created' && s.issue_number ? await loadLiveIssue(deps, s) : null;
    const act = can(ctx.membership, 'inbox.edit');
    const actionBase = `${b}/tickets/${s.id}`;
    const repo = `${s.repo_owner}/${s.repo_name}`;
    const repoUrl = `https://github.com/${repo}`;
    const canResend = Boolean(payload?.description);
    const unresolved = s.status === 'failed' || s.status === 'uncertain';
    const st = TICKET_STATUS[s.status];

    // Header actions depend on the status.
    const linkItem = { dialog: 'link-dialog', label: 'Link existing issue…', icon: 'link' } as const;
    const closeItem = { dialog: 'close-dialog', label: 'Close ticket…', icon: 'circle-slash', danger: true } as const;
    const retryConfirm = s.status === 'uncertain'
      ? { title: 'Retry this ticket?', body: 'GitHub is checked first. The issue is only created if none exists yet, so it’s never filed twice.', label: 'Retry' }
      : undefined;
    let actions: SafeHtml[] = [];
    if (s.status === 'uncertain' && act) {
      actions = [
        postBtn(`${actionBase}/recheck`, 'Check GitHub', ctx.csrf, { variant: 'primary', icon: 'search-check', loading: 'Checking…' }),
        postBtn(`${actionBase}/retry`, 'Retry', ctx.csrf, { icon: 'rotate-ccw', loading: 'Working…', disabled: !canResend, confirm: retryConfirm, title: canResend ? undefined : 'The ticket text is no longer stored' }),
        menu([linkItem, 'sep', closeItem], { size: 'md' }),
      ];
    } else if (s.status === 'failed' && act) {
      actions = [
        postBtn(`${actionBase}/retry`, 'Retry', ctx.csrf, { variant: 'primary', icon: 'rotate-ccw', loading: 'Working…', disabled: !canResend, title: canResend ? undefined : 'The ticket text is no longer stored' }),
        menu([linkItem, 'sep', closeItem], { size: 'md' }),
      ];
    } else if (s.status === 'created' && s.issue_url) {
      actions = [
        linkBtn(s.issue_url, 'Open on GitHub', { trail: 'arrow-up-right', external: true }),
        menu([{ copy: s.issue_url, label: 'Copy issue link', icon: 'copy' }], { size: 'md' }),
      ];
    }

    const resolvedBy = s.resolved_by ? names.get(s.resolved_by) : null;
    const statusNotice =
      s.status === 'uncertain'
        ? notice('warn', 'GitHub didn’t confirm this issue', s.next_attempt_at
            ? `${s.reconcile_attempts ? `Checked ${plural(s.reconcile_attempts, 'time')} so far` : 'GitHub is searched automatically'} for the reference ${s.ref}, so it’s never filed twice. ${s.next_attempt_at.getTime() > Date.now() ? `Next check ${timeAgo(s.next_attempt_at)}.` : 'Next check shortly.'}`
            : `Automatic checks found no issue with the reference ${s.ref} (${plural(s.reconcile_attempts, 'check')}). Search ${repo} for it, then link the issue, retry or close this ticket.`, { icon: 'circle-help' })
        : s.status === 'failed'
          ? notice('danger', s.error_code === 'issues_disabled' ? `Issues are disabled in ${repo}` : 'This ticket couldn’t be filed', s.error_code === 'issues_disabled' ? 'Turn on Issues for the repository, then retry. The member was told the team has their ticket.' : `${s.error_message ?? 'GitHub didn’t accept the issue.'} The member was told the team has their ticket.`, {
              action: s.error_code === 'issues_disabled' ? linkBtn(`${repoUrl}/settings`, 'Open repository settings', { size: 'sm', trail: 'arrow-up-right', external: true }) : null,
            })
          : s.status === 'pending'
            ? notice('info', s.attempts ? 'Waiting for GitHub' : 'Queued', s.next_attempt_at && s.next_attempt_at.getTime() > Date.now() ? `${s.error_code ? `${ERROR_REASONS[s.error_code] ?? 'GitHub was unavailable'}. ` : ''}Retrying automatically ${timeAgo(s.next_attempt_at)}.` : 'It will be filed in a moment.', { icon: 'clock' })
            : s.status === 'processing'
              ? notice('info', 'Filing now', 'This ticket is being sent to GitHub right now.', { icon: 'clock' })
              : s.status === 'dismissed'
                ? notice('info', 'Closed without filing', [resolvedBy ? `${resolvedBy} closed this ticket` : 'Closed by an admin', s.resolution_note].filter(Boolean).join(' · '), { icon: 'circle-slash' })
                : '';

    const title = payload?.title ?? `Ticket ${s.ref}`;
    const typeName = s.ticket_type_name;
    const body = html`
      ${pageHeader({
        crumbs: [{ href: `${b}/tickets`, label: 'Discord tickets' }, { label: html`<span class="mono">${s.ref}</span>` }],
        title,
        after: [statusPill(s.status), s.source === 'admin_test' ? tag('Test') : '', !act ? viewOnlyTag(viewOnlyText('inbox')) : ''],
        description: `${appLine(s)} · Submitted ${timeAgo(s.created_at)} by ${s.reporter_display_name}`,
        actions,
      })}
      ${statusNotice}
      ${unresolved && !act ? html`<div class="viewonly">${icon('eye', 16)}View only. Check, retry, link and close need Edit on the Inbox. Ask an admin or the owner.</div>` : ''}

      <div class="detail-grid">
        <div class="a-desc a-col"><div class="card"><div class="card-h"><h2>Description</h2>${live && s.issue_url ? html`<a class="small inline gap-4 nowrap" href="${s.issue_url}" target="_blank" rel="noopener noreferrer">Edit on GitHub${icon('arrow-up-right', 14)}</a>` : ''}</div>
          <div class="card-b">${live
            ? live.kind === 'ok'
              ? ticketText(live.text.description, live.text.answers)
              : live.kind === 'missing'
                ? html`<p class="muted small">The GitHub issue was deleted, so its description is gone too.</p>`
                : html`<p class="muted small">Couldn’t load the description from GitHub right now. Reload to try again, or <a href="${s.issue_url ?? '#'}" target="_blank" rel="noopener noreferrer">open the issue on GitHub</a>.</p>`
            : payload?.description
              ? ticketText(payload.description, payload.answers ?? [])
              : html`<p class="muted small">${s.payload_purged_at ? `Deleted after the retention period (${formatDate(s.payload_purged_at)}).` : 'Not available.'}</p>`}</div>
          ${live?.kind === 'ok' ? html`<div class="card-note">Shown live from the GitHub issue, including edits made there. It isn’t stored here.</div>` : ''}
          ${!live && payload?.description && (unresolved || s.status === 'pending') ? html`<div class="card-note">Stored encrypted so the ticket can be retried. Kept until it’s resolved, at most 90 days.</div>` : ''}
        </div>
        ${files.length || (act && s.status === 'created') ? filesCard({ files, actionBase, csrf: ctx.csrf, canAct: act, filed: s.status === 'created', names }) : ''}</div>

        <div class="a-activity card"><div class="card-h"><h2>Activity</h2></div>
          <div class="card-b"><ol class="activity">${events.map((e) => {
            const v = eventView(e, s, names);
            return html`<li>${v.actor ? avatar(v.actor, 24) : html`<span class="marker">${icon(v.icon ?? 'info', 14, v.tone ?? 'muted')}</span>`}
              <div>${v.text}</div><time class="when" datetime="${e.at.toISOString()}" title="${formatDate(e.at)}">${timeAgo(e.at)}</time></li>`;
          })}</ol></div>
        </div>

        <div class="a-details a-col"><aside class="card"><div class="card-h"><h2>Details</h2></div>
          <dl class="props">
            <dt>Status</dt><dd>${pill(st.label, st.tone)}</dd>
            <dt>App</dt><dd>${s.app_name}</dd>
            ${typeName ? html`<dt>Type</dt><dd>${tag(typeName, { icon: typeIcon({ name: typeName }) })}</dd>` : ''}
            <dt>Reporter</dt><dd>${avatar(s.reporter_display_name, 20)}<span>${s.reporter_display_name}</span>${s.reporter_username ? html`<span class="muted">@${s.reporter_username}</span>` : ''}</dd>
            <dt>Discord ID</dt><dd><span class="mono">${s.reporter_discord_id}</span>${copyBtn(s.reporter_discord_id, 'Copy Discord ID')}</dd>
            <dt>Repository</dt><dd>${icon('folder-git-2', 14)}<a class="mono" href="${repoUrl}" target="_blank" rel="noopener noreferrer">${repo}</a>${tag(s.repo_private ? 'Private' : 'Public', { icon: s.repo_private ? 'lock' : 'globe' })}</dd>
            ${s.labels.length ? html`<dt>Labels</dt><dd>${s.labels.map((l) => labelTag(l))}</dd>` : ''}
            <dt>GitHub issue</dt><dd>${s.issue_url ? html`${issueRef(s)}${live ? issueStatePill(live) : ''}` : html`<span class="muted">Not filed yet</span>`}</dd>
            <dt>Reference</dt><dd><span class="mono">${s.ref}</span>${copyBtn(s.ref, 'Copy reference')}</dd>
            <dt>Submitted</dt><dd>${when(s.created_at)}</dd>
            ${s.attempts > 1 ? html`<dt>Attempts</dt><dd>${String(s.attempts)}</dd>` : ''}
            ${s.error_code && (unresolved || s.status === 'pending') ? html`<dt>Last error</dt><dd><code>${s.error_code}</code></dd>` : ''}
            ${s.warnings.length ? html`<dt>Warnings</dt><dd><span class="small">${s.warnings.join(' ')}</span></dd>` : ''}
            <dt>Member</dt><dd class="small">${s.member_notice ? s.member_notice : s.source === 'admin_test' ? html`<span class="muted">Not notified (test)</span>` : html`<span class="muted">Not notified yet</span>`}</dd>
          </dl>
        </aside>
        ${triageRow ? triageCard(triageRow, s, { act: can(ctx.membership, 'triage.review.edit'), csrf: ctx.csrf, actionBase, knowledge: knowledgeLink(ctx, s.app_id) }) : ''}</div>
      </div>

      ${unresolved && act ? html`
        ${dialog('link-dialog', {
          title: 'Link an existing issue',
          action: `${actionBase}/link`,
          csrf: ctx.csrf,
          body: html`<p>The ticket is marked filed and linked to this issue.</p>
            <div class="field"><label for="issue-number">Issue number</label>
              <div class="input-group"><span class="addon">${repo} #</span><input id="issue-number" type="number" class="wide" name="issue_number" min="1" required autofocus inputmode="numeric"></div>
              <div class="hint">Only issues in this repository can be linked.</div></div>`,
          submit: submitBtn('Link issue', { variant: 'primary', loading: 'Verifying…' }),
        })}
        ${dialog('close-dialog', {
          title: 'Close this ticket?',
          action: `${actionBase}/dismiss`,
          csrf: ctx.csrf,
          body: html`<p>It won’t be filed on GitHub. The reporter isn’t notified.</p>
            ${choices('reason', CLOSE_REASONS, 'Spam')}
            <div class="field"><div class="field-head"><label for="close-note">Note <span class="opt">(optional)</span></label><span class="counter" data-counter-for="close-note">0 / 300</span></div>
              <textarea id="close-note" name="note" maxlength="300" rows="2"></textarea></div>`,
          submit: submitBtn('Close ticket', { variant: 'danger-solid' }),
        })}` : ''}`;
    return web.render(reply, ctx, title, 'tickets', body);
  });

  function action(name: string, run: (wid: string, id: string, userId: string, body: Record<string, string>) => Promise<string>) {
    app.post(`/w/:wid/tickets/:id/${name}`, async (req, reply) => {
      const ctx = await web.requireWorkspace(req, reply, { permission: 'inbox.edit' });
      if (!ctx) return reply;
      const id = (req.params as { id: string }).id;
      try {
        setFlash(reply, 'success', await run(ctx.workspace.id, id, ctx.user.id, (req.body ?? {}) as Record<string, string>));
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
        setFlash(reply, 'error', err.message);
      }
      return reply.redirect(`${ctx.base}/tickets/${id}`);
    });
  }

  action('recheck', async (wid, id, uid) => {
    const r = await processor.recheck(wid, id, uid);
    return r === 'found' ? 'Found the issue on GitHub. The ticket is now marked filed.' : r === 'not_found' ? 'Checked GitHub: no matching issue yet.' : 'GitHub couldn’t be reached. Try again later.';
  });
  action('retry', async (wid, id, uid) => {
    const r = await processor.retry(wid, id, uid);
    return {
      created: 'The issue was created.',
      found_existing: 'The issue already existed on GitHub, so nothing new was created. It’s now linked.',
      queued: 'GitHub is busy. The ticket was queued and will be filed automatically.',
      failed: 'The retry failed. See the details below.',
      uncertain: 'GitHub didn’t confirm the result. It will be checked automatically.',
    }[r];
  });
  action('link', async (wid, id, uid, body) => {
    const num = Number(body.issue_number);
    if (!Number.isInteger(num) || num < 1) throw new UserFacingError('Enter a valid issue number.');
    await processor.linkIssue(wid, id, num, uid);
    return `Linked to issue #${num}.`;
  });
  action('dismiss', async (wid, id, uid, body) => {
    const reason = CLOSE_REASONS.some((r) => r.value === body.reason) && body.reason !== 'Other' ? body.reason : '';
    const note = String(body.note ?? '').trim();
    await processor.dismiss(wid, id, [reason, note].filter(Boolean).join(' · ').slice(0, 300), uid);
    return 'Ticket closed.';
  });

  // ---- Settings tab -----------------------------------------------------------------------------

  app.get('/w/:wid/tickets/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'ticket-settings.view' });
    if (!ctx) return reply;
    const ws = ctx.workspace;
    // Without Edit: the same limits, turned off.
    const edit = can(ctx.membership, 'ticket-settings.edit');
    const num = (name: string, value: number, min: number, max: number, label: string) =>
      html`<input type="number" id="${name}" name="${name}" value="${String(value)}" min="${String(min)}" max="${String(max)}" required aria-label="${label}">`;
    const head = html`<div class="card-h"><div><h2>Spam and duplicates</h2><div class="desc">Limits apply to each Discord member.</div></div></div>`;
    const limits = html`
        ${setting('Rate limit', 'How many tickets one member can open in a time window.',
          html`${num('rate_limit_count', ws.rate_limit_count, 1, 100, 'Tickets per member')}<span class="connector">tickets every</span>${num('rate_limit_window_minutes', ws.rate_limit_window_minutes, 1, 1440, 'Time window in minutes')}<span class="connector">min</span>`)}
        ${setting('Duplicate window', 'Identical tickets from the same member inside this window are ignored. 0 turns it off.',
          html`${num('duplicate_window_minutes', ws.duplicate_window_minutes, 0, 1440, 'Duplicate window in minutes')}<span class="connector">min</span>`)}`;
    const body = html`
      ${await toolHeader(web, ctx, 'tickets', 'ticket-settings')}
      ${edit
        ? html`<form method="post" action="${ctx.base}/tickets/settings" class="card" data-dirty>
            ${csrfField(ctx.csrf)}
            ${head}
            ${limits}
            <div class="card-f"><div class="end">
              <button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>
              ${submitBtn('Save changes', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
            </div></div>
          </form>`
        : html`<div class="card">
            ${head}
            <fieldset class="plain view-only" disabled>${limits}</fieldset>
            <div class="card-f">${viewOnlyFooter('these limits')}</div>
          </div>`}`;
    return web.render(reply, ctx, 'Settings · Discord tickets', 'tickets', body);
  });

  const limitsSchema = z.object({
    rate_limit_count: z.coerce.number().int().min(1).max(100),
    rate_limit_window_minutes: z.coerce.number().int().min(1).max(1440),
    duplicate_window_minutes: z.coerce.number().int().min(0).max(1440),
  });

  app.post('/w/:wid/tickets/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'ticket-settings.edit' });
    if (!ctx) return reply;
    const parsed = limitsSchema.safeParse(req.body);
    if (!parsed.success) {
      setFlash(reply, 'error', 'Check the values: tickets 1–100, window 1–1440 minutes, duplicate window 0–1440 minutes.');
      return reply.redirect(`${ctx.base}/tickets/settings`);
    }
    await updateTicketLimits(deps.db, ctx.workspace.id, {
      rateLimitCount: parsed.data.rate_limit_count,
      rateLimitWindowMinutes: parsed.data.rate_limit_window_minutes,
      duplicateWindowMinutes: parsed.data.duplicate_window_minutes,
    });
    setFlash(reply, 'success', 'Settings saved');
    return reply.redirect(`${ctx.base}/tickets/settings`);
  });
}

export type { SubmissionStatus };
