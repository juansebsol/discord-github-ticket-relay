/**
 * Moderation: Ticket management (a queue of open tickets and issues on the left, the one opened
 * on the right with its whole history, triage's verdict and the tools to close it), the Mod log,
 * and Replies & reasons (what the app posts on GitHub for moderators, written by admins).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { refreshBoardSoon, setIssueOverride, getKnownIssuesSettings } from '../../bot-features/known-issues.js';
import { can } from '../../domain/permissions.js';
import { listApps } from '../../domain/store.js';
import { UserFacingError, type AppRow } from '../../domain/types.js';
import { userNames } from '../../domain/workspaces.js';
import { GitHubApiError, type TimelineEvent } from '../../github/client.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import {
  activeJobs, canUndo, changeLabels, checkOriginal, closeOne, getAction, markDuplicate, MAX_JOB, modTarget, notDuplicate, postReply, recordPin, reopenOne, startCloseJob, stopJob, undoAction,
  type JobProgress, type ModActionRow,
} from '../../moderation/actions.js';
import { detailSig, loadDetail, type Detail, type HistoryItem } from '../../moderation/detail.js';
import { forgetLive, warmLive } from '../../moderation/live.js';
import {
  closedRows, duplicateGroups, isQueue, keyOf, parseKey, parseSearch, QUEUES, queueCounts, queueRows, QUIET_DAYS,
  type ClosedRow, type DuplicateGroup, type IssueKey, type QueueKey, type QueueLabels, type QueueRow, type QueueScope, type Source,
} from '../../moderation/queue.js';
import {
  fillTemplate, getModerationSettings, GITHUB_CLOSE_NAMES, isReason, LIMITS, newReplyId, REASON_DEFAULTS, reasonsOn, saveReason, saveReplies, setModerationEnabled,
  type ModerationSettings, type Reason, type ReasonKey,
} from '../../moderation/settings.js';
import { getTriageSettings, type TriageConfig } from '../../triage/settings.js';
import { renderMarkdown } from '../markdown.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import {
  avatar, btn, csrfField, dialog, empty, formatDate, icon, iconBtn, labelTag, linkBtn, menu, notice, pill, plural, postBtn, segLinks, selectWrap, submitBtn, switchInput, tag, timeAgo,
  type IconName,
} from '../ui.js';
import { eventView } from './tickets.js';
import { areaHref, canOpen, toolHeader } from './tool.js';
import { workspacePath } from './triage-bulk.js';

const PAGE = 50;
const GROUPS = 15;
const GROUP_ROWS = 5;
const n = (x: number) => x.toLocaleString('en-US');

/** Label names (lower case) the Spam and "Needs info, quiet" lists look for. */
function queueLabels(s: ModerationSettings, c: TriageConfig): QueueLabels {
  const lower = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => Boolean(x?.trim())).map((x) => x.trim().toLowerCase()))];
  return { spam: lower([s.reasons.find((r) => r.key === 'spam')?.label, c.spam.label]), needsInfo: lower([c.needsInfo.label]) };
}

interface ListState {
  queue: QueueKey;
  app: string | null;
  source: Source;
  q: string;
  orig: string | null;
  limit: number;
  open: string | null;
}

function readState(query: Record<string, string | undefined>): ListState {
  const limit = Math.min(MAX_JOB, Math.max(PAGE, Number(query.limit) || PAGE));
  return {
    queue: isQueue(query.queue) ? query.queue : 'open',
    app: query.app || null,
    source: query.source === 'discord' || query.source === 'github' ? query.source : 'all',
    q: (query.q ?? '').trim().slice(0, 200),
    orig: parseKey(query.orig) ? query.orig! : null,
    limit,
    open: parseKey(query.open) ? query.open! : null,
  };
}

function listHref(ctx: WorkspaceRequestContext, s: ListState, patch: Partial<ListState> = {}): string {
  const m = { ...s, ...patch };
  const p = new URLSearchParams();
  if (m.queue !== 'open') p.set('queue', m.queue);
  if (m.app) p.set('app', m.app);
  if (m.source !== 'all') p.set('source', m.source);
  if (m.q) p.set('q', m.q);
  if (m.orig) p.set('orig', m.orig);
  if (m.limit > PAGE) p.set('limit', String(m.limit));
  if (m.open) p.set('open', m.open);
  const qs = p.toString();
  return `${areaHref(ctx, 'moderation')}${qs ? `?${qs}` : ''}`;
}

function ago(d: Date): SafeHtml {
  return html`<time datetime="${d.toISOString()}" title="${formatDate(d)}">${timeAgo(d)}</time>`;
}

function shortAgo(d: Date, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - d.getTime()) / 60_000));
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const days = Math.round(h / 24);
  return days < 365 ? `${days}d` : `${Math.round(days / 365)}y`;
}

const ASSOCIATION: Record<string, string> = { OWNER: 'Owner', MEMBER: 'Member', COLLABORATOR: 'Collaborator', CONTRIBUTOR: 'Contributor' };

function reasonName(key: string | null): string {
  return key && isReason(key) ? REASON_DEFAULTS[key].name : 'a reason';
}

// ---- The list ---------------------------------------------------------------------------------------

type Chip = { text: string; tone: 'accent' | 'ok' | 'warn' | 'danger' | 'plain' };

function rowChips(r: QueueRow, now = Date.now()): Chip[] {
  const out: Chip[] = [];
  if (r.dup_of) out.push({ text: `Duplicate of #${r.dup_of}${r.dup_conf ? ` · ${r.dup_conf}%` : r.dup_marked ? ' · marked' : ''}`, tone: 'accent' });
  if (r.fixed_by) out.push({ text: `Fixed in #${r.fixed_by}`, tone: 'ok' });
  else if (r.triage_fixed) out.push({ text: 'Already fixed', tone: 'ok' });
  if (r.spam_conf !== null) out.push({ text: `Spam · ${r.spam_conf}%`, tone: 'danger' });
  else if (r.spam_label) out.push({ text: 'Spam label', tone: 'danger' });
  if (r.needs_info) {
    const quiet = Math.floor((now - r.updated_at.getTime()) / 86_400_000);
    out.push({ text: quiet >= QUIET_DAYS ? `Needs info · quiet ${quiet}d` : 'Needs info', tone: 'warn' });
  }
  return out.slice(0, 2);
}

function chipHtml(c: Chip): SafeHtml {
  return html`<span class="mod-chip ${c.tone}">${c.text}</span>`;
}

function repoName(apps: AppRow[], repoId: number): string {
  return apps.find((a) => a.repo_id === repoId)?.repo_name ?? 'repo';
}

function issueRow(ctx: WorkspaceRequestContext, s: ListState, apps: AppRow[], r: QueueRow, o: { open: boolean; select: boolean }): SafeHtml {
  const key = keyOf({ repoId: r.repo_id, number: r.number });
  return html`<li class="mod-row${o.open ? ' open' : ''}">
    ${o.select ? html`<input type="checkbox" class="rule-check" form="mod-bulk" name="item" value="${key}" aria-label="Select ${r.title}">` : ''}
    <a class="mod-row-a" href="${listHref(ctx, s, { open: key })}" ${o.open ? raw('aria-current="true"') : ''} data-mod-row>
      <span class="mod-row-l1"><span class="mod-row-t">${r.title}</span><span class="mod-row-age" title="Last activity ${formatDate(r.updated_at)}">${shortAgo(r.updated_at)}</span></span>
      <span class="mod-row-l2"><span class="mono">${repoName(apps, r.repo_id)}#${String(r.number)}</span>${r.sub_ref ? html` · <span class="mono">${r.sub_ref}</span>` : ''} · ${r.sub_id ? 'Discord' : 'Opened on GitHub'}</span>
      ${rowChips(r).length ? html`<span class="mod-row-c">${rowChips(r).map(chipHtml)}</span>` : ''}
    </a>
  </li>`;
}

function closedRow(ctx: WorkspaceRequestContext, s: ListState, apps: AppRow[], r: ClosedRow, names: Map<string, string>, open: boolean): SafeHtml {
  const key = keyOf({ repoId: r.repo_id, number: r.number });
  const who = r.user_id ? names.get(r.user_id) ?? 'Someone' : 'Someone';
  return html`<li class="mod-row${open ? ' open' : ''}">
    <a class="mod-row-a" href="${listHref(ctx, s, { open: key })}" ${open ? raw('aria-current="true"') : ''} data-mod-row>
      <span class="mod-row-l1"><span class="mod-row-t">${r.title || `#${r.number}`}</span><span class="mod-row-age" title="${formatDate(r.at)}">${shortAgo(r.at)}</span></span>
      <span class="mod-row-l2"><span class="mono">${repoName(apps, r.repo_id)}#${String(r.number)}</span>${r.sub_ref ? html` · <span class="mono">${r.sub_ref}</span>` : ''}</span>
      <span class="mod-row-c"><span class="mod-chip plain">${reasonName(r.reason)}${r.duplicate_of ? ` of #${r.duplicate_of}` : ''} · ${who}</span></span>
    </a>
  </li>`;
}

/** What the group's original is doing: fixed and released, being fixed, closed, or nothing yet. */
function originalLine(g: Pick<DuplicateGroup, 'original' | 'pull' | 'release' | 'number'>): { text: string; tone: 'ok' | 'warn' | 'accent' | 'plain' } {
  const o = g.original;
  if (o?.state === 'closed' && o.state_reason === 'not_planned') return { text: 'Original closed as not planned. Check before closing these.', tone: 'warn' };
  if (g.pull?.merged_at) return { text: `Fixed in #${g.pull.number}${g.release ? `, released in ${g.release.tag}` : ', not released yet'}`, tone: 'ok' };
  if (o?.state === 'closed') return { text: `Original closed${o.state_reason === 'completed' ? ' as completed' : ''}`, tone: 'ok' };
  if (g.pull) return { text: `Being fixed in #${g.pull.number}${g.pull.draft ? ' (draft)' : ''}`, tone: 'accent' };
  return { text: o ? `No fix yet · first reported ${timeAgo(o.created_at)}` : 'Original not in the issue copy yet', tone: 'plain' };
}

/** The reason a group's "Close all" uses: fixed when the original is fixed, otherwise duplicate. */
function groupReason(g: DuplicateGroup): ReasonKey | null {
  const o = g.original;
  if (o?.state === 'closed' && o.state_reason === 'not_planned') return null;
  return g.pull?.merged_at || (o?.state === 'closed' && o.state_reason === 'completed') ? 'fixed' : 'duplicate';
}

function groupBlock(ctx: WorkspaceRequestContext, s: ListState, apps: AppRow[], g: DuplicateGroup, o: { openKey: string | null; select: boolean; act: boolean; settings: ModerationSettings }): SafeHtml {
  const origKey = keyOf({ repoId: g.repoId, number: g.number });
  const line = originalLine(g);
  const reason = groupReason(g);
  const reasonOn = reason ? o.settings.reasons.find((r) => r.key === reason)?.on : false;
  const shown = s.orig ? g.rows : g.rows.slice(0, GROUP_ROWS);
  const title = g.original?.title ?? `#${g.number}`;
  return html`<li class="mod-group">
    <div class="mod-group-h">
      <div class="mod-group-main">
        <a class="mod-group-t" href="${listHref(ctx, s, { open: origKey })}">${title}</a>
        <span class="mod-group-s"><span class="mono">${repoName(apps, g.repoId)}#${String(g.number)}</span> · ${g.original?.state === 'closed' ? 'Closed' : 'Open'}</span>
        <span class="mod-group-fix ${line.tone}">${line.text}</span>
      </div>
      <div class="mod-group-side">
        <span class="mod-group-n" title="Open duplicates">${n(g.rows.length)}</span>
        ${o.act && reason && reasonOn
          ? html`<button type="button" class="btn sm" data-dialog="mod-close-group" data-group="${origKey}" data-group-reason="${reason}" data-group-of="${String(g.number)}" data-group-title="Close ${plural(g.rows.length, 'duplicate')} of #${String(g.number)}${reason === 'fixed' ? ' as fixed' : ''}">Close ${n(g.rows.length)}…</button>`
          : o.act && !reason ? linkBtn(listHref(ctx, s, { orig: origKey, open: null }), 'Review', { size: 'sm', variant: 'ghost' }) : ''}
      </div>
    </div>
    <ul class="mod-rows">${shown.map((r) => issueRow(ctx, s, apps, r, { open: o.openKey === keyOf({ repoId: r.repo_id, number: r.number }), select: o.select }))}</ul>
    ${g.rows.length > shown.length ? html`<a class="mod-group-more" href="${listHref(ctx, s, { orig: origKey, open: null })}">Show all ${n(g.rows.length)}</a>` : ''}
  </li>`;
}

// ---- The open ticket --------------------------------------------------------------------------------

function ticketText(t: NonNullable<Detail['text']>, repoUrl: string): SafeHtml {
  if (t.kind === 'body') return t.body.trim() ? html`<div class="kn-doc mod-md">${renderMarkdown(t.body, repoUrl)}</div>` : html`<p class="small muted">No description.</p>`;
  return html`${t.description ? html`<p class="ticket-text">${t.description}</p>` : html`<p class="small muted">No description.</p>`}
    ${t.answers.length ? html`<dl class="mod-answers">${t.answers.map((a) => html`<dt>${a.question}</dt><dd>${a.value}</dd>`)}</dl>` : ''}`;
}

function marker(name: IconName, tone = 'muted'): SafeHtml {
  return html`<span class="marker">${icon(name, 14, tone)}</span>`;
}

function githubLine(e: TimelineEvent, labels: { added: string[]; removed: string[] } | undefined, d: Detail): { lead: SafeHtml; text: SafeHtml; body?: SafeHtml } | null {
  const who = html`<span class="actor">${e.actor ?? 'Someone'}</span>`;
  switch (e.kind) {
    case 'comment':
      return {
        lead: avatar(e.actor ?? '?', 24),
        text: html`${who} commented${e.association && ASSOCIATION[e.association] ? html` ${tag(ASSOCIATION[e.association]!)}` : ''}`,
        body: e.body.trim() ? html`<div class="mod-bubble kn-doc mod-md">${renderMarkdown(e.body, d.repoUrl)}</div>` : undefined,
      };
    case 'labeled':
    case 'unlabeled': {
      const l = labels ?? { added: e.kind === 'labeled' ? [e.label] : [], removed: e.kind === 'unlabeled' ? [e.label] : [] };
      return { lead: marker('tag'), text: html`${who} ${l.added.length ? html`added ${l.added.map((x) => labelTag(x))}` : ''}${l.added.length && l.removed.length ? ' and ' : ''}${l.removed.length ? html`removed ${l.removed.map((x) => labelTag(x))}` : ''}` };
    }
    case 'closed':
      return { lead: marker('circle-slash'), text: html`${who} closed it${e.reason === 'not_planned' ? ' as not planned' : e.reason === 'duplicate' ? ' as a duplicate' : e.reason === 'completed' ? ' as completed' : ''}` };
    case 'reopened':
      return { lead: marker('rotate-ccw'), text: html`${who} reopened it` };
    case 'duplicate':
      return { lead: marker('copy'), text: html`${who} marked it as a duplicate` };
    case 'mentioned':
      return {
        lead: marker(e.isPull ? (e.merged ? 'git-merge' : 'git-pull-request') : 'link', e.merged ? 'ok' : 'muted'),
        text: html`${who} mentioned this in <a href="${e.url}" target="_blank" rel="noopener noreferrer">${e.isPull ? 'PR ' : ''}${e.repo && e.repo.toLowerCase() !== `${d.app.repo_owner}/${d.app.repo_name}`.toLowerCase() ? e.repo : ''}#${String(e.number)} ${e.title}</a> ${tag(e.isPull ? (e.merged ? 'Merged' : e.state === 'open' ? 'Open' : 'Closed') : e.state === 'open' ? 'Open' : 'Closed')}`,
      };
  }
}

function modLine(a: ModActionRow, names: Map<string, string>): SafeHtml {
  const who = html`<span class="actor">${a.user_id ? names.get(a.user_id) ?? 'Someone' : 'Someone'}</span>`;
  const undone = a.undone_at ? html` <span class="muted">· undone${a.undone_by ? ` by ${names.get(a.undone_by) ?? 'someone'}` : ''}</span>` : '';
  const note = a.note ? html`<div class="extra">Note for the team: ${a.note}</div>` : '';
  switch (a.kind) {
    case 'close':
      return html`${who} closed it: ${reasonName(a.reason)}${a.duplicate_of ? ` of #${a.duplicate_of}` : ''}${a.detail.commented ? ', with the reason’s comment' : ''}${a.job_id ? ' (closing several)' : ''}${undone}${note}`;
    case 'reopen':
      return html`${who} reopened it${undone}`;
    case 'duplicate':
      return html`${who} marked it as a duplicate of #${String(a.duplicate_of ?? '')}${undone}`;
    case 'not_duplicate':
      return html`${who} said it isn’t a duplicate${a.detail.removed?.length ? html` and took off ${a.detail.removed.map((x) => labelTag(x))}` : ''}${undone}`;
    case 'reply':
      return html`${who} posted the saved reply “${a.detail.reply ?? ''}”${undone}`;
    case 'labels':
      return html`${who} ${a.detail.added?.length ? html`added ${a.detail.added.map((x) => labelTag(x))}` : ''}${a.detail.added?.length && a.detail.removed?.length ? ' and ' : ''}${a.detail.removed?.length ? html`took off ${a.detail.removed.map((x) => labelTag(x))}` : ''}`;
    case 'pin':
      return html`${who} pinned it to the Known-issues board`;
  }
}

/** What an action did, for the Mod log's "What" column. */
function modWhat(a: ModActionRow, names: Map<string, string>): SafeHtml {
  const what = (() => {
    switch (a.kind) {
      case 'close': return html`Closed: ${reasonName(a.reason)}${a.duplicate_of ? ` of #${a.duplicate_of}` : ''}${a.detail.commented ? ', with the comment' : ''}`;
      case 'reopen': return html`Reopened`;
      case 'duplicate': return html`Marked as a duplicate of #${String(a.duplicate_of ?? '')}`;
      case 'not_duplicate': return html`Not a duplicate${a.detail.removed?.length ? html`, took off ${a.detail.removed.map((x) => labelTag(x))}` : ''}`;
      case 'reply': return html`Posted “${a.detail.reply ?? ''}”`;
      case 'labels': return html`${a.detail.added?.length ? html`Added ${a.detail.added.map((x) => labelTag(x))}` : ''}${a.detail.added?.length && a.detail.removed?.length ? ', ' : ''}${a.detail.removed?.length ? html`${a.detail.added?.length ? 'took' : 'Took'} off ${a.detail.removed.map((x) => labelTag(x))}` : ''}`;
      case 'pin': return html`Pinned to the Known-issues board`;
    }
  })();
  return html`<div>${what}</div>${a.note ? html`<div class="sub">Note: ${a.note}</div>` : ''}${a.undone_at ? html`<div class="sub">Undone${a.undone_by ? ` by ${names.get(a.undone_by) ?? 'someone'}` : ''} ${ago(a.undone_at)}</div>` : ''}`;
}

function historyList(d: Detail, names: Map<string, string>): SafeHtml {
  const subject = d.ticket ?? { repo_owner: d.app.repo_owner, repo_name: d.app.repo_name, issue_number: d.key.number, reporter_display_name: d.indexed?.author ?? 'Someone', source: 'discord' as const, resolution_note: null };
  const item = (h: HistoryItem): SafeHtml => {
    const time = html`<span class="when">${ago(h.at)}</span>`;
    if (h.kind === 'filed') {
      return html`<li class="mod-h">${avatar(h.reporter, 24)}<div class="mod-h-b"><div class="mod-h-l"><span><span class="actor">${h.reporter}</span>${h.username ? html` <span class="muted">@${h.username}</span>` : ''} filed this from Discord${h.channel ? ` in #${h.channel}` : ''}</span>${time}</div>
        <div class="mod-text">${d.text ? ticketText(d.text, d.repoUrl) : html`<p class="small muted">${d.liveError === 'missing' ? 'The GitHub issue was deleted, so its text is gone too.' : d.loading ? 'Loading the text from GitHub…' : 'The text couldn’t be loaded from GitHub right now.'}</p>`}</div></div></li>`;
    }
    if (h.kind === 'opened') {
      return html`<li class="mod-h">${avatar(h.author ?? '?', 24)}<div class="mod-h-b"><div class="mod-h-l"><span><span class="actor">${h.author ?? 'Someone'}</span> opened this on GitHub</span>${time}</div>
        <div class="mod-text">${d.text ? ticketText(d.text, d.repoUrl) : html`<p class="small muted">${d.liveError === 'missing' ? 'This issue was deleted on GitHub.' : d.loading ? 'Loading the text from GitHub…' : 'The text couldn’t be loaded from GitHub right now.'}</p>`}</div></div></li>`;
    }
    if (h.kind === 'event') {
      const v = eventView({ id: 0, at: h.at, kind: h.event.kind, detail: h.event.detail }, subject, names);
      return html`<li class="mod-h">${v.actor ? avatar(v.actor, 24) : marker(v.icon ?? 'info', v.tone ?? 'muted')}<div class="mod-h-b"><div class="mod-h-l"><span>${v.text}</span>${time}</div></div></li>`;
    }
    if (h.kind === 'mod') {
      return html`<li class="mod-h">${marker('shield', 'accent')}<div class="mod-h-b"><div class="mod-h-l"><span>${modLine(h.action, names)}</span>${time}</div></div></li>`;
    }
    const g = githubLine(h.event, h.labels, d);
    if (!g) return html``;
    return html`<li class="mod-h${g.body ? ' comment' : ''}">${g.lead}<div class="mod-h-b"><div class="mod-h-l"><span>${g.text}</span>${time}</div>${g.body ?? ''}</div></li>`;
  };
  return html`<ol class="mod-history">${d.history.map(item)}</ol>
    ${d.historyMore ? html`<p class="small muted">GitHub has more than this. <a href="${d.url}" target="_blank" rel="noopener noreferrer">See the rest on GitHub</a>.</p>` : ''}
    ${d.loading
      ? html`<p class="mod-loading small muted" data-mod-loading>${icon('loader-circle', 14, 'mod-spin')}<span><span data-mod-loading-text>${d.live ? 'Checking GitHub for anything new…' : 'Loading the comments and activity from GitHub…'}</span> <a href="" class="nojs">Reload</a></span></p>`
      : d.liveError === 'error'
        ? notice('warn', null, d.live && d.liveAt ? `GitHub couldn’t be reached just now, so this is GitHub’s side as it was ${timeAgo(d.liveAt)}. Reload to try again.` : 'GitHub couldn’t be reached, so its comments aren’t shown. Reload to try again.')
        : ''}`;
}

/** The history, filled in by the page once GitHub's side is read when the copy kept here is out of date. */
function historyBox(ctx: WorkspaceRequestContext, d: Detail, names: Map<string, string>): SafeHtml {
  const src = d.loading ? `${ctx.base}/moderation/history?item=${keyOf(d.key)}&s=${detailSig(d)}` : null;
  return html`<div class="mod-history-box" data-mod-history ${src ? html`data-src="${src}"` : ''}>${historyList(d, names)}</div>`;
}

function issueCard(o: { href: string; github: string; icon: IconName; tone: string; eyebrow: string; title: string; sub: string }): SafeHtml {
  return html`<div class="mod-ref">${icon(o.icon, 16, o.tone)}<span class="mod-ref-b"><span class="mod-ref-e">${o.eyebrow}</span><a class="mod-ref-t" href="${o.href}">${o.title}</a><span class="mod-ref-s">${o.sub}</span></span>${iconBtn('arrow-up-right', 'Open on GitHub', { size: 'xs', href: o.github, external: true })}</div>`;
}

function pullCard(pull: NonNullable<Detail['pull']>, release: Detail['pullRelease'], eyebrow: string): SafeHtml {
  const state = pull.merged_at ? `Merged ${timeAgo(pull.merged_at)}${release ? `, in ${release.tag}` : ', not released yet'}` : pull.state === 'open' ? `${pull.draft ? 'Draft' : 'Open'}, not merged yet` : 'Closed without merging';
  return html`<div class="mod-ref">${icon(pull.merged_at ? 'git-merge' : 'git-pull-request', 16, pull.merged_at ? 'ok' : 'accent')}<span class="mod-ref-b"><span class="mod-ref-e">${eyebrow}</span><a class="mod-ref-t" href="${pull.html_url}" target="_blank" rel="noopener noreferrer">PR #${String(pull.number)} ${pull.title}</a><span class="mod-ref-s">${state}${pull.author ? ` · by ${pull.author}` : ''} · updated ${timeAgo(pull.updated_at)}</span></span></div>`;
}

function quickClose(ctx: WorkspaceRequestContext, d: Detail, reason: ReasonKey, label: string, back: string, o: { duplicateOf?: number; primary?: boolean; key?: string } = {}): SafeHtml {
  return html`<form method="post" action="${ctx.base}/moderation/close" class="inline-form">${csrfField(ctx.csrf)}
    <input type="hidden" name="item" value="${keyOf(d.key)}"><input type="hidden" name="reason" value="${reason}"><input type="hidden" name="comment_${reason}" value="1"><input type="hidden" name="back" value="${back}">
    ${o.duplicateOf ? html`<input type="hidden" name="duplicate_of" value="${String(o.duplicateOf)}">` : ''}
    ${submitBtn(label, { variant: o.primary ? 'primary' : 'secondary', size: 'sm', loading: 'Closing…', attrs: o.key ? html`data-mod-key="${o.key}"` : undefined })}</form>`;
}

function verdictBox(ctx: WorkspaceRequestContext, d: Detail, o: { act: boolean; back: string; settings: ModerationSettings; listOf: (k: IssueKey) => string }): SafeHtml {
  const v = d.verdict;
  const open = d.state === 'open';
  const on = (k: ReasonKey) => o.act && open && o.settings.reasons.some((r) => r.key === k && r.on);
  const parts: SafeHtml[] = [];
  if (v.duplicate && d.original) {
    const orig = d.original;
    const by = v.duplicate.by === 'moderator' ? 'Marked as a duplicate' : 'Triage says this is a duplicate';
    const fixed = orig.pull?.merged_at || (orig.issue?.state === 'closed' && orig.issue.state_reason === 'completed');
    parts.push(html`<div class="mod-v-h">${icon('copy', 16, 'accent')}<span>${by} of <strong>#${String(orig.number)}</strong></span>${v.duplicate.confidence !== null ? html`<span class="muted">${String(v.duplicate.confidence)}% sure</span>` : ''}${v.duplicate.waiting ? html`<span class="mod-chip warn">Waiting in Review</span>` : ''}</div>
      <div class="mod-refs">
        ${issueCard({ href: o.listOf({ repoId: d.key.repoId, number: orig.number }), github: orig.issue?.html_url ?? `${d.repoUrl}/issues/${orig.number}`, icon: orig.issue?.state === 'closed' ? 'circle-check' : 'circle-dot', tone: orig.issue?.state === 'closed' ? 'muted' : 'ok', eyebrow: 'Original', title: `#${orig.number} ${orig.issue?.title ?? ''}`, sub: `${orig.issue?.state === 'closed' ? `Closed${orig.issue.state_reason === 'not_planned' ? ' as not planned' : ''}` : 'Open'} · ${plural(orig.duplicates, 'open duplicate')}${orig.issue ? ` · reported ${timeAgo(orig.issue.created_at)}` : ''}` })}
        ${orig.pull ? pullCard(orig.pull, orig.release, 'Fix for the original') : ''}
      </div>
      ${open && o.act ? html`<div class="row">
        ${on('fixed') && fixed ? quickClose(ctx, d, 'fixed', 'Close as fixed', o.back, { primary: true }) : ''}
        ${on('duplicate') ? quickClose(ctx, d, 'duplicate', `Close as duplicate of #${orig.number}`, o.back, { duplicateOf: orig.number, primary: !fixed, key: 'd' }) : ''}
        ${postBtn(`${ctx.base}/moderation/not-duplicate`, 'Not a duplicate', ctx.csrf, { size: 'sm', variant: 'ghost', fields: { item: keyOf(d.key), back: o.listOf(d.key) }, loading: 'Saving…' })}
      </div>` : ''}`);
  } else if (d.pull?.merged_at || v.fixed) {
    parts.push(html`<div class="mod-v-h">${icon('circle-check', 16, 'ok')}<span>${d.pull?.merged_at ? 'A merged pull request fixes this' : `Triage says this was already fixed${v.fixed?.work?.ref ? ` in ${v.fixed.work.ref}` : ''}`}</span></div>
      ${d.pull ? html`<div class="mod-refs">${pullCard(d.pull, d.pullRelease, 'The fix')}</div>` : ''}
      ${on('fixed') ? html`<div class="row">${quickClose(ctx, d, 'fixed', 'Close as fixed', o.back, { primary: true })}</div>` : ''}`);
  } else if (v.spam) {
    parts.push(html`<div class="mod-v-h">${icon('triangle-alert', 16, 'danger')}<span>Triage thinks this is spam</span><span class="muted">${String(v.spam.confidence)}% sure</span></div>
      ${on('spam') ? html`<div class="row">${quickClose(ctx, d, 'spam', 'Close as spam', o.back, { primary: true })}</div>` : ''}`);
  } else if (d.pull || v.inProgress) {
    parts.push(html`<div class="mod-v-h">${icon('git-pull-request', 16, 'accent')}<span>Being worked on${v.inProgress?.work?.ref && !d.pull ? ` in ${v.inProgress.work.ref}` : ''}</span></div>
      ${d.pull ? html`<div class="mod-refs">${pullCard(d.pull, d.pullRelease, 'Pull request')}</div>` : ''}`);
  } else if (v.needsInfo) {
    const quiet = Math.floor((Date.now() - (d.live?.updatedAt ?? d.indexed?.updated_at ?? new Date()).getTime()) / 86_400_000);
    parts.push(html`<div class="mod-v-h">${icon('message-circle-question', 16, 'warn')}<span>Triage asked for more details</span>${quiet >= 1 ? html`<span class="muted">nothing new for ${plural(quiet, 'day')}</span>` : ''}</div>
      ${on('noReply') && quiet >= QUIET_DAYS ? html`<div class="row">${quickClose(ctx, d, 'noReply', 'Close: no reply', o.back, { primary: true })}</div>` : ''}`);
  }
  return parts.length ? html`<section class="mod-verdict" aria-label="What’s known">${parts}</section>` : html``;
}

function facts(ctx: WorkspaceRequestContext, d: Detail, o: { act: boolean; listOf: (k: IssueKey) => string }): SafeHtml {
  const t = d.ticket;
  const reporter = t
    ? html`<div class="mod-f"><span class="mod-f-k">Reporter</span><span class="mod-f-v">${avatar(t.reporter_display_name, 20)}<strong>${t.reporter_display_name}</strong>${t.reporter_username ? html`<span class="muted">@${t.reporter_username}</span>` : ''}</span>
      ${canOpen(ctx.membership, 'inbox') && t.reporter_username ? html`<a class="small" href="${areaHref(ctx, 'inbox')}?status=all&amp;q=${encodeURIComponent(t.reporter_username)}">${plural(d.reporterTickets, 'ticket')} in the last 30 days</a>` : html`<span class="small muted">${plural(d.reporterTickets, 'ticket')} in the last 30 days</span>`}</div>`
    : html`<div class="mod-f"><span class="mod-f-k">Opened by</span><span class="mod-f-v">${avatar(d.indexed?.author ?? d.live?.author ?? '?', 20)}<strong>${d.indexed?.author ?? d.live?.author ?? 'Someone'}</strong><span class="muted">on GitHub</span></span></div>`;
  return html`<aside class="mod-facts" aria-label="Details">
    ${reporter}
    <div class="mod-f"><span class="mod-f-k">App</span><span class="mod-f-v">${d.app.name}${t?.ticket_type_name ? html` · ${t.ticket_type_name}` : ''}</span></div>
    <div class="mod-f"><span class="mod-f-k">Labels</span><span class="mod-f-v wrap">${d.labels.length ? d.labels.map((l) => labelTag(l)) : html`<span class="muted small">None</span>`}
      ${o.act && d.state === 'open' ? html`<button type="button" class="mod-add" data-dialog="mod-labels">${icon('plus', 12)}Label</button>` : ''}</span></div>
    <div class="mod-f"><span class="mod-f-k">Repository</span><a class="mono small" href="${d.repoUrl}" target="_blank" rel="noopener noreferrer">${d.app.repo_owner}/${d.app.repo_name}</a></div>
    ${o.act && d.state === 'open' && !d.verdict.duplicate ? html`<div class="mod-f"><button type="button" class="btn sm ghost" data-dialog="mod-dup">${icon('copy', 14)}<span class="lbl">Mark as a duplicate…</span></button></div>` : ''}
    ${d.similar.length ? html`<div class="mod-f mod-similar"><span class="mod-f-k">Looks similar</span>${d.similar.map((h) => html`<a href="${o.listOf({ repoId: h.repo_id, number: h.number })}"><span>#${String(h.number)} ${h.title}</span><span class="muted">${h.state === 'closed' ? `Closed${h.state_reason === 'not_planned' ? ' as not planned' : ''}` : 'Open'}${h.duplicate_of ? ` · duplicate of #${h.duplicate_of}` : ''}</span></a>`)}</div>` : ''}
  </aside>`;
}

function stateTag(d: Detail): SafeHtml {
  if (d.liveError === 'missing') return pill('Deleted on GitHub', 'warn');
  if (d.state === 'open') return pill('Open', 'ok');
  return pill(d.stateReason === 'not_planned' ? 'Closed · not planned' : d.stateReason === 'duplicate' ? 'Closed · duplicate' : 'Closed', 'closed');
}

function detailPane(ctx: WorkspaceRequestContext, d: Detail, names: Map<string, string>, o: { act: boolean; settings: ModerationSettings; back: string; prev: string | null; next: string | null; position: string; listOf: (k: IssueKey) => string }): SafeHtml {
  const t = d.ticket;
  const open = d.state === 'open';
  const undo = d.lastClose && canUndo(d.lastClose) ? d.lastClose : null;
  const discord = d.discord
    ? d.discord.channel
      ? menu([{ href: d.discord.profile, label: `Message ${t?.reporter_display_name ?? 'the reporter'}`, icon: 'send', external: true }, { href: d.discord.channel, label: 'Open the channel it came from', icon: 'hash', external: true }], { button: { label: 'Open in Discord', opts: { icon: 'message-circle', size: 'sm' } } })
      : linkBtn(d.discord.profile, 'Open in Discord', { icon: 'message-circle', size: 'sm', external: true })
    : '';
  const actions = html`${discord}${linkBtn(d.url, 'Open on GitHub', { size: 'sm', trail: 'arrow-up-right', external: true })}
    ${o.act && open && d.liveError !== 'missing' ? btn('Close…', { variant: 'primary', size: 'sm', icon: 'circle-check', attrs: raw('data-dialog="mod-close" data-mod-key="c"') }) : ''}
    ${o.act && !open && undo ? postBtn(`${ctx.base}/moderation/undo/${undo.id}`, 'Undo close', ctx.csrf, { size: 'sm', variant: 'primary', icon: 'undo-2', fields: { back: o.listOf(d.key) }, loading: 'Undoing…' }) : ''}
    ${o.act && !open && !undo && d.liveError !== 'missing' ? postBtn(`${ctx.base}/moderation/reopen`, 'Reopen', ctx.csrf, { size: 'sm', icon: 'rotate-ccw', fields: { item: keyOf(d.key), back: o.listOf(d.key) }, loading: 'Reopening…', confirm: { title: 'Reopen this issue?', body: 'It’s reopened on GitHub. Nothing is posted.', label: 'Reopen' } }) : ''}`;
  const meta = [
    html`<span class="mono">${d.app.repo_name}#${String(d.key.number)}</span>`,
    t ? html`<span class="mono">${t.ref}</span>` : null,
    html`<span>${t ? `Filed from Discord by ${t.reporter_display_name}, ${timeAgo(t.created_at)}` : `Opened on GitHub${d.indexed?.author ? ` by ${d.indexed.author}` : ''}, ${timeAgo(d.live?.createdAt ?? d.indexed?.created_at ?? new Date())}`}</span>`,
  ].filter(Boolean) as SafeHtml[];
  const replyBox = o.act && o.settings.replies.length && d.liveError !== 'missing'
    ? html`<form method="post" action="${ctx.base}/moderation/reply" class="mod-reply" data-reply-form>${csrfField(ctx.csrf)}
        <input type="hidden" name="item" value="${keyOf(d.key)}"><input type="hidden" name="back" value="${o.listOf(d.key)}">
        <div class="mod-reply-h"><label for="mod-reply-pick">Reply on GitHub</label><span class="small muted">from the saved replies</span>
          ${selectWrap(html`<select id="mod-reply-pick" name="reply" data-reply-pick>${o.settings.replies.map((r) => html`<option value="${r.id}">${r.name}</option>`)}</select>`, { sm: true, cls: 'grow-select' })}</div>
        ${o.settings.replies.map((r, i) => html`<p class="mod-reply-text" data-reply-text="${r.id}" ${i ? raw('hidden') : ''}>${fillTemplate(r.text, { app: d.app.name })}</p>`)}
        <div class="row end">${submitBtn('Post reply', { size: 'sm', icon: 'reply', loading: 'Posting…' })}</div>
      </form>`
    : '';
  return html`<div class="mod-d-bar">
      ${o.prev ? iconBtn('chevron-left', 'Previous', { href: o.prev, secondary: true, size: 'sm' }) : iconBtn('chevron-left', 'Previous', { secondary: true, size: 'sm', disabled: true })}
      ${o.next ? iconBtn('chevron-right', 'Next', { href: o.next, secondary: true, size: 'sm' }) : iconBtn('chevron-right', 'Next', { secondary: true, size: 'sm', disabled: true })}
      <span class="small muted">${o.position}</span>
      <div class="mod-d-actions">${actions}</div>
    </div>
    <div class="mod-d-b">
      <div><h2 class="mod-d-t">${d.title}</h2><div class="mod-d-meta">${stateTag(d)}${meta.map((m, i) => html`${i ? html`<span aria-hidden="true">·</span>` : ''}${m}`)}</div></div>
      ${verdictBox(ctx, d, { act: o.act, back: o.back, settings: o.settings, listOf: o.listOf })}
      <div class="mod-d-cols">
        <section class="mod-d-main" aria-label="History"><div class="mod-sec-h"><h3>History</h3><span class="small muted">Discord, Ticket Relay and GitHub, in order</span></div>
          ${historyBox(ctx, d, names)}${replyBox}</section>
        ${facts(ctx, d, { act: o.act, listOf: o.listOf })}
      </div>
    </div>
    <div class="mod-keys js-only" aria-hidden="true"><span><kbd>J</kbd> <kbd>K</kbd> next, previous</span>${o.act && open ? html`<span><kbd>C</kbd> close</span>${d.verdict.duplicate ? html`<span><kbd>D</kbd> close as duplicate</span>` : ''}${replyBox ? html`<span><kbd>R</kbd> reply</span>` : ''}` : ''}<span class="grow"></span>${o.act ? html`<span>After closing, the next one opens</span>` : ''}</div>`;
}

// ---- Close dialogs ------------------------------------------------------------------------------------

/** The reasons, the original's number, what's posted on GitHub and the team's note. */
function closeFields(s: ModerationSettings, o: { checked: ReasonKey; duplicateOf: number | null; app: string | null; only?: ReasonKey[]; idPrefix: string; askOriginal?: boolean }): SafeHtml {
  const reasons = reasonsOn(s).filter((r) => !o.only || o.only.includes(r.key));
  const checked = reasons.some((r) => r.key === o.checked) ? o.checked : reasons[0]?.key;
  const preview = (r: Reason) => {
    const parts = fillTemplate(r.comment.replace(/\{duplicate\}/g, '\u0000'), { app: o.app }).split('\u0000');
    return html`${parts.map((p, i) => html`${i ? html`<span data-dup-ref>${o.duplicateOf ? `#${o.duplicateOf}` : '#…'}</span>` : ''}${p}`)}`;
  };
  return html`<div class="choices mod-reasons" role="radiogroup">${reasons.map((r) => html`<label class="choice"><input type="radio" name="reason" value="${r.key}" ${r.key === checked ? raw('checked') : ''}><span><span class="t">${r.name}</span><span class="d">${r.desc}</span></span></label>`)}</div>
    ${o.askOriginal !== false && reasons.some((r) => r.key === 'duplicate') ? html`<div class="field" data-shown-for="reason=duplicate"><label for="${o.idPrefix}-dup">Duplicate of</label>
      <div class="input-group"><span class="addon">#</span><input id="${o.idPrefix}-dup" type="number" class="wide" name="duplicate_of" min="1" inputmode="numeric" value="${o.duplicateOf ? String(o.duplicateOf) : ''}" data-dup-input></div>
      <div class="hint">An issue in the same repository. It’s checked on GitHub first.</div></div>` : ''}
    ${reasons.map((r) => html`<div class="mod-gh" data-shown-for="reason=${r.key}">
      <div class="mod-gh-h">On GitHub</div>
      <p class="small">${r.label ? html`Adds ${labelTag(r.label)} and closes` : 'Closes'} it as <strong>${GITHUB_CLOSE_NAMES[r.github]}</strong>.</p>
      ${r.comment.trim() ? html`<label class="mod-check"><input type="checkbox" name="comment_${r.key}" value="1" checked> Post this comment</label><p class="mod-reply-text">${preview(r)}</p>` : html`<p class="small muted">No comment is posted for ${r.name}.</p>`}
    </div>`)}
    <div class="field"><div class="field-head"><label for="${o.idPrefix}-note">Note for the team <span class="opt">(optional, stays in Ticket Relay)</span></label><span class="counter" data-counter-for="${o.idPrefix}-note">0 / ${String(LIMITS.note)}</span></div>
      <textarea id="${o.idPrefix}-note" name="note" maxlength="${String(LIMITS.note)}" rows="2"></textarea></div>`;
}

function closeDialogs(ctx: WorkspaceRequestContext, s: ModerationSettings, o: { detail: Detail | null; back: string; listBack: string; repoLabels: string[] }): SafeHtml {
  const d = o.detail;
  const dialogs: SafeHtml[] = [];
  if (d && d.state === 'open') {
    const v = d.verdict;
    const checked: ReasonKey = v.duplicate ? (d.original?.pull?.merged_at ? 'fixed' : 'duplicate') : d.pull?.merged_at || v.fixed ? 'fixed' : v.spam ? 'spam' : 'notPlanned';
    dialogs.push(dialog('mod-close', {
      title: `Close ${d.app.repo_name}#${d.key.number}`,
      action: `${ctx.base}/moderation/close`,
      csrf: ctx.csrf,
      fields: { item: keyOf(d.key), back: o.back },
      body: closeFields(s, { checked, duplicateOf: v.duplicate?.of ?? null, app: d.app.name, idPrefix: 'mc' }),
      submit: submitBtn('Close on GitHub', { variant: 'primary', loading: 'Closing…' }),
    }));
    dialogs.push(dialog('mod-dup', {
      title: 'Mark as a duplicate',
      action: `${ctx.base}/moderation/duplicate`,
      csrf: ctx.csrf,
      fields: { item: keyOf(d.key), back: o.back },
      body: html`<p>It’s grouped under the original in Repeat bugs, and triage learns it. Nothing changes on GitHub.</p>
        <div class="field"><label for="md-dup">Original issue</label><div class="input-group"><span class="addon">${d.app.repo_owner}/${d.app.repo_name} #</span><input id="md-dup" type="number" class="wide" name="duplicate_of" min="1" required autofocus inputmode="numeric"></div></div>`,
      submit: submitBtn('Mark as a duplicate', { variant: 'primary', loading: 'Checking…' }),
    }));
    dialogs.push(dialog('mod-labels', {
      title: 'Labels',
      action: `${ctx.base}/moderation/labels`,
      csrf: ctx.csrf,
      fields: { item: keyOf(d.key), back: o.back },
      body: html`${d.labels.length ? html`<fieldset class="mod-label-list"><legend class="small muted">Untick to take a label off</legend>${d.labels.map((l) => html`<label class="mod-check"><input type="checkbox" name="keep" value="${l}" checked> ${labelTag(l)}<input type="hidden" name="had" value="${l}"></label>`)}</fieldset>` : html`<p>It has no labels yet.</p>`}
        <div class="field"><label for="ml-add">Add a label</label><input id="ml-add" type="text" name="add" list="ml-names" maxlength="50" autocomplete="off" placeholder="A label the repository has">
          <datalist id="ml-names">${o.repoLabels.filter((l) => !d.labels.includes(l)).map((l) => html`<option value="${l}"></option>`)}</datalist>
          <div class="hint">Only labels that already exist in ${d.app.repo_owner}/${d.app.repo_name}.</div></div>`,
      submit: submitBtn('Save labels', { variant: 'primary', loading: 'Saving…' }),
    }));
  }
  // Several at once: the ticked rows (their boxes belong to this form).
  dialogs.push(html`<dialog class="dialog" id="mod-close-bulk" aria-labelledby="mod-close-bulk-title">
    <form method="post" action="${ctx.base}/moderation/close" id="mod-bulk">${csrfField(ctx.csrf)}<input type="hidden" name="back" value="${o.listBack}">
      <div class="dlg-h"><h2 id="mod-close-bulk-title">Close the selected tickets</h2>${iconBtn('x', 'Close', { size: 'sm', attrs: raw('data-dialog-close') })}</div>
      <div class="dlg-b"><p data-selected-text="mod-bulk" data-selected-plain data-empty-text="Nothing selected.">Nothing selected.</p>${closeFields(s, { checked: 'duplicate', duplicateOf: null, app: null, idPrefix: 'mb' })}
        <p class="small muted">They’re closed in the background, one at a time. Ones closed since are skipped.</p></div>
      <div class="dlg-f">${btn('Cancel', { attrs: raw('data-dialog-close') })}${submitBtn('Close on GitHub', { variant: 'primary', loading: 'Starting…' })}</div>
    </form></dialog>`);
  // A whole group of duplicates (app.js fills in which group).
  dialogs.push(html`<dialog class="dialog" id="mod-close-group" aria-labelledby="mod-close-group-title">
    <form method="post" action="${ctx.base}/moderation/close">${csrfField(ctx.csrf)}<input type="hidden" name="back" value="${o.listBack}"><input type="hidden" name="group" value="" data-group-input>
      <div class="dlg-h"><h2 id="mod-close-group-title" data-group-heading>Close the duplicates</h2>${iconBtn('x', 'Close', { size: 'sm', attrs: raw('data-dialog-close') })}</div>
      <div class="dlg-b">${closeFields(s, { checked: 'duplicate', duplicateOf: null, app: null, only: ['duplicate', 'fixed'], idPrefix: 'mg', askOriginal: false })}
        <p class="small muted">Every open duplicate in the group is closed in the background, one at a time.</p></div>
      <div class="dlg-f">${btn('Cancel', { attrs: raw('data-dialog-close') })}${submitBtn('Close on GitHub', { variant: 'primary', loading: 'Starting…' })}</div>
    </form></dialog>`);
  return html`${dialogs}`;
}

// ---- Bulk closes in progress --------------------------------------------------------------------------

function jobsStatus(ctx: WorkspaceRequestContext, jobs: JobProgress[]): SafeHtml {
  return html`<div class="card-b tight bulk-status">${jobs.map((j) => {
    const finished = j.done + j.skipped + j.failed;
    const waiting = j.status === 'running' && j.waiting_until_at && j.waiting_until_at.getTime() > Date.now();
    return html`<div class="bulk-line">
      ${icon(j.status === 'running' ? 'loader-circle' : j.failed ? 'triangle-alert' : 'circle-check', 16, j.status === 'running' ? 'muted' : j.failed ? 'warn' : 'ok')}
      <div class="grow"><div class="small"><strong>${j.status === 'running' ? 'Closing' : j.status === 'stopped' ? 'Stopped closing' : 'Closed'} ${j.description}</strong>: ${n(j.done)} of ${n(j.total)} closed${j.skipped ? ` · ${n(j.skipped)} skipped` : ''}${j.failed ? ` · ${n(j.failed)} failed` : ''}${waiting ? ` · waiting for GitHub’s hourly limit until ${j.waiting_until_at!.toISOString().slice(11, 16)} UTC` : ''}</div>
        ${j.status === 'running' ? html`<progress class="bar wide" max="${String(j.total || 1)}" value="${String(finished)}"></progress>` : ''}</div>
      ${j.status === 'running' && can(ctx.membership, 'moderation.edit') ? postBtn(`${ctx.base}/moderation/jobs/${j.id}/stop`, 'Stop', ctx.csrf, { size: 'sm', icon: 'circle-x', confirm: { title: 'Stop closing?', body: 'What’s closed stays closed. The rest stay open.', label: 'Stop' } }) : ''}
    </div>`;
  })}${jobs.some((j) => j.status === 'running') ? '' : html`<span data-live-reload hidden></span>`}</div>`;
}

async function jobsBanner(web: Web, ctx: WorkspaceRequestContext): Promise<SafeHtml> {
  const jobs = await activeJobs(web.deps.db, ctx.workspace.id);
  if (!jobs.length) return html``;
  const running = jobs.some((j) => j.status === 'running');
  return html`<div class="card mod-jobs" ${running ? raw(`data-live="4000" data-live-src="${ctx.base}/moderation/jobs/status"`) : ''}>${jobsStatus(ctx, jobs)}</div>`;
}

// ---- Routes -------------------------------------------------------------------------------------------

export function registerModerationRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  function offState(ctx: WorkspaceRequestContext): SafeHtml {
    const admin = can(ctx.membership, 'manage');
    return html`<div class="card">${empty('shield', 'Moderation is off', admin
      ? 'Turn it on to close, reopen and sort out tickets here. Check the close reasons and saved replies first: they’re what the app posts on GitHub for moderators.'
      : 'An admin hasn’t turned it on yet.', admin
      ? html`<div class="row">${postBtn(`${ctx.base}/moderation/enable`, 'Turn on Moderation', ctx.csrf, { variant: 'primary', fields: { on: '1' } })}${canOpen(ctx.membership, 'mod-replies') ? linkBtn(areaHref(ctx, 'mod-replies'), 'Replies & reasons') : ''}</div>`
      : null)}</div>`;
  }

  app.get('/w/:wid/moderation', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'moderation.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const [settings, triageSettings, apps] = await Promise.all([getModerationSettings(deps.db, wid), getTriageSettings(deps.db, wid), listApps(deps.db, wid)]);
    const header = await toolHeader(web, ctx, 'moderation', 'moderation');
    if (!settings.enabled) return web.render(reply, ctx, 'Ticket management', 'moderation', html`${header}${offState(ctx)}`);

    const s = readState(req.query as Record<string, string | undefined>);
    const act = can(ctx.membership, 'moderation.edit');
    const appRow = apps.find((a) => a.id === s.app) ?? null;
    const scope: QueueScope = { workspaceId: wid, apps, app: appRow, source: s.source, search: s.q, orig: parseKey(s.orig) };
    const labels = queueLabels(settings, triageSettings.config);
    const counts = await queueCounts(deps.db, { ...scope, orig: null }, labels);

    // The list: groups of duplicates (Repeat bugs), what moderators closed, or open issues.
    let groups: DuplicateGroup[] = [];
    let rows: QueueRow[] = [];
    let closed: ClosedRow[] = [];
    if (s.queue === 'repeat') groups = await duplicateGroups(deps.db, scope, labels);
    else if (s.queue === 'closed') closed = await closedRows(deps.db, scope, { limit: s.limit });
    else rows = await queueRows(deps.db, scope, labels, s.queue, { limit: s.limit });
    const shownGroups = s.orig ? groups : groups.slice(0, Math.max(GROUPS, Math.floor(s.limit / PAGE) * GROUPS));
    const keys: string[] = s.queue === 'repeat'
      ? shownGroups.flatMap((g) => (s.orig ? g.rows : g.rows.slice(0, GROUP_ROWS)).map((r) => keyOf({ repoId: r.repo_id, number: r.number })))
      : s.queue === 'closed' ? closed.map((r) => keyOf({ repoId: r.repo_id, number: r.number })) : rows.map((r) => keyOf({ repoId: r.repo_id, number: r.number }));

    // The open one: picked, found by an exact search, or the first in the list.
    const search = parseSearch(s.q, apps);
    let openKey = s.open;
    if (!openKey && search?.kind === 'issue' && search.repoId && search.repoId > 0) openKey = keyOf({ repoId: search.repoId, number: search.number });
    if (!openKey && search?.kind === 'issue' && search.repoId === null && apps.length) {
      const repo = [...new Set(apps.map((a) => a.repo_id))].find((id) => keys.includes(keyOf({ repoId: id, number: search.number })));
      if (repo) openKey = keyOf({ repoId: repo, number: search.number });
    }
    openKey ??= keys[0] ?? null;
    const openParsed = parseKey(openKey);
    const detail = openParsed
      ? await loadDetail(deps, wid, openParsed, { ticket: (id) => web.triage.getResult(wid, id), issue: () => web.triage.getIssueResult(wid, openParsed.repoId, openParsed.number) })
      : null;
    const at = openKey ? keys.indexOf(openKey) : -1;
    const ahead = (at >= 0 ? keys.slice(at + 1, at + 3) : keys.filter((k) => k !== openKey).slice(0, 2)).map(parseKey).filter((k): k is IssueKey => k !== null);
    warmLive(deps, wid, { now: detail?.loading ? detail.key : null, ahead });
    const nextKey = at >= 0 ? keys[at + 1] ?? null : keys[0] ?? null;
    const prevKey = at > 0 ? keys[at - 1]! : null;
    const listOf = (k: IssueKey) => listHref(ctx, s, { open: keyOf(k) });
    const next = nextKey && nextKey !== openKey ? listHref(ctx, s, { open: nextKey }) : null;
    const prev = prevKey ? listHref(ctx, s, { open: prevKey }) : null;
    // After closing, the next one in the list opens (the closed one drops out of it).
    const afterClose = listHref(ctx, s, { open: nextKey && nextKey !== openKey ? nextKey : null });
    const queueDef = QUEUES.find((q) => q.key === s.queue)!;
    const total = s.queue === 'repeat' && s.orig ? keys.length : counts[s.queue];
    const position = at >= 0 ? `${n(at + 1)} of ${n(total)} in ${queueDef.label}` : detail ? 'Not in this list' : '';

    const names = await userNames(deps.db, [...(detail?.userIds ?? []), ...closed.map((r) => r.user_id)]);
    const repoLabels = detail && detail.state === 'open' && act
      ? (await deps.db.query<{ l: string }>(`SELECT DISTINCT l.value AS l FROM issue_index i, json_each(i.labels) l WHERE i.repo_id = $1 LIMIT 300`, [detail.key.repoId])).rows.map((r) => r.l).sort((a, b) => a.localeCompare(b))
      : [];

    const select = act;
    const listBody = s.queue === 'repeat'
      ? shownGroups.length
        ? html`<ul class="mod-groups">${shownGroups.map((g) => groupBlock(ctx, s, apps, g, { openKey, select, act, settings }))}</ul>
          ${!s.orig && groups.length > shownGroups.length ? html`<div class="mod-more"><a href="${listHref(ctx, s, { limit: s.limit + PAGE, open: openKey })}">Show more groups</a> · ${plural(groups.length - shownGroups.length, 'group')} not shown</div>` : ''}`
        : empty('circle-check', 'No repeat bugs', s.orig ? 'Nothing open is a duplicate of that issue now.' : 'Duplicates triage finds, or someone marks, show up here, grouped under the original.', null, 'ok')
      : s.queue === 'closed'
        ? closed.length ? html`<ul class="mod-rows">${closed.map((r) => closedRow(ctx, s, apps, r, names, openKey === keyOf({ repoId: r.repo_id, number: r.number })))}</ul>` : empty('circle-slash', 'Nothing closed here yet', 'What moderators close here in the last 30 days shows up in this list.')
        : rows.length
          ? html`<ul class="mod-rows">${rows.map((r) => issueRow(ctx, s, apps, r, { open: openKey === keyOf({ repoId: r.repo_id, number: r.number }), select }))}</ul>
            ${rows.length >= s.limit && s.limit < MAX_JOB ? html`<div class="mod-more"><a href="${listHref(ctx, s, { limit: s.limit + PAGE, open: openKey })}">Show ${PAGE} more</a> · ${n(rows.length)} of ${n(counts[s.queue])} shown</div>` : ''}`
          : s.q ? empty('search-x', 'Nothing matches', `No open ticket or issue in ${queueDef.label} matches “${s.q}”.`, linkBtn(listHref(ctx, s, { q: '', open: null }), 'Clear search'))
            : empty('circle-check', `Nothing in ${queueDef.label}`, queueDef.desc, null, 'ok');

    const bulk = select && s.queue !== 'closed' && keys.length
      ? html`<div class="bulk-bar mod-bulk"><span class="bulk-lead"><input type="checkbox" class="rule-check" data-select-all="mod-bulk" aria-label="Select everything in the list"><span class="small muted" data-selected-text="mod-bulk" data-selected-plain data-empty-text="Select some to close them together.">Select some to close them together.</span></span>
          <button type="button" class="btn sm primary" data-dialog="mod-close-bulk" data-needs-selection="mod-bulk" disabled><span class="lbl">Close…</span></button></div>`
      : '';
    const filters = html`<form method="get" action="${areaHref(ctx, 'moderation')}" class="tools mod-filters" role="search">
      ${s.queue !== 'open' ? html`<input type="hidden" name="queue" value="${s.queue}">` : ''}
      ${selectWrap(html`<select name="app" aria-label="App" data-autosubmit><option value="">All apps</option>${apps.map((a) => html`<option value="${a.id}" ${a.id === s.app ? raw('selected') : ''}>${a.name}</option>`)}</select>`, { sm: true })}
      ${selectWrap(html`<select name="source" aria-label="Source" data-autosubmit><option value="all">Discord and GitHub</option><option value="discord" ${s.source === 'discord' ? raw('selected') : ''}>Discord tickets</option><option value="github" ${s.source === 'github' ? raw('selected') : ''}>Opened on GitHub</option></select>`, { sm: true })}
      <span class="search sm">${icon('search', 14)}<input type="search" name="q" value="${s.q}" placeholder="TR-…, #1287, a link or words" aria-label="Find a ticket or issue"></span>
      <button type="submit" class="btn sm nojs">Find</button>
    </form>`;

    const body = html`${header}
      ${await jobsBanner(web, ctx)}
      <div class="mod-top">
        ${segLinks('Lists', QUEUES.map((q) => ({ href: listHref(ctx, s, { queue: q.key, orig: null, open: null, limit: PAGE }), label: q.label, count: counts[q.key], current: q.key === s.queue })))}
        ${filters}
      </div>
      ${s.orig ? html`<div class="mod-orig">${icon('copy', 14, 'muted')}<span>Duplicates of <strong class="mono">#${s.orig.split('-')[1]}</strong></span>${linkBtn(listHref(ctx, s, { orig: null, open: null }), 'All repeat bugs', { size: 'sm', variant: 'ghost', icon: 'x' })}</div>` : ''}
      <div class="mod-split" data-mod-split ${next ? html`data-mod-next="${next}"` : ''} ${prev ? html`data-mod-prev="${prev}"` : ''}>
        <section class="card mod-list" aria-label="${queueDef.label}">${bulk}${listBody}</section>
        <article class="card mod-detail" id="mod-detail" aria-label="${detail?.title ?? 'Ticket'}">
          ${detail
            ? detailPane(ctx, detail, names, { act, settings, back: afterClose, prev, next, position, listOf })
            : openParsed ? empty('search-x', 'Not found', 'That issue isn’t in this workspace’s repositories, or GitHub doesn’t know it.') : empty('inbox', 'Nothing open', 'Pick a ticket on the left.')}
        </article>
      </div>
      ${act ? closeDialogs(ctx, settings, { detail, back: afterClose, listBack: listHref(ctx, s, { open: null }), repoLabels }) : ''}`;
    return web.render(reply, ctx, 'Ticket management', 'moderation', body, { width: 'full' });
  });

  // The open ticket's history once GitHub's side is read (the page shows the copy kept here first).
  app.get('/w/:wid/moderation/history', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'moderation.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const q = req.query as Record<string, string | undefined>;
    const k = parseKey(q.item);
    const settings = await getModerationSettings(deps.db, wid);
    const d = settings.enabled && k ? await loadDetail(deps, wid, k, { ticket: (id) => web.triage.getResult(wid, id), issue: () => web.triage.getIssueResult(wid, k.repoId, k.number) }, { fresh: true }) : null;
    reply.header('x-live-partial', '1').type('text/html');
    if (!d) return reply.send(String(notice('warn', null, 'This ticket couldn’t be loaded. Reload to try again.')));
    const names = await userNames(deps.db, d.userIds);
    const changed = q.s && q.s !== detailSig(d) ? notice('info', null, html`It changed on GitHub since this page was loaded. <a href="">Reload</a> to see it.`) : '';
    return reply.send(String(html`${changed}${historyList(d, names)}`));
  });

  app.get('/w/:wid/moderation/jobs/status', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'moderation.view' });
    if (!ctx) return reply;
    const jobs = await activeJobs(deps.db, ctx.workspace.id);
    reply.header('x-live-partial', '1').type('text/html');
    return reply.send(String(jobsStatus(ctx, jobs)));
  });

  // ---- Actions ----------------------------------------------------------------------------------------

  /** Runs an action for people with Edit on Ticket management, with Moderation on, then goes back. */
  function action(path: string, run: (ctx: WorkspaceRequestContext, body: Record<string, string | string[] | undefined>, settings: ModerationSettings) => Promise<{ message: string; tone?: 'success' | 'warn'; back?: string }>) {
    app.post(`/w/:wid/moderation${path}`, async (req, reply) => {
      const ctx = await web.requireWorkspace(req, reply, { permission: 'moderation.edit' });
      if (!ctx) return reply;
      const body = (req.body ?? {}) as Record<string, string | string[] | undefined>;
      const back = workspacePath(ctx, body.back, ['/moderation']) ?? areaHref(ctx, 'moderation');
      try {
        const settings = await getModerationSettings(deps.db, ctx.workspace.id);
        if (!settings.enabled) throw new UserFacingError('Moderation is off. An admin can turn it on.');
        const r = await run(ctx, body, settings);
        setFlash(reply, r.tone ?? 'success', r.message);
        return reply.redirect(r.back ?? back);
      } catch (err) {
        return failed(reply, err, back);
      }
    });
  }

  function failed(reply: FastifyReply, err: unknown, back: string) {
    if (err instanceof UserFacingError) setFlash(reply, 'error', err.message);
    else if (err instanceof GitHubApiError) setFlash(reply, 'error', err.isRateLimit ? 'GitHub’s hourly limit is used up. Try again in a few minutes.' : `GitHub didn’t accept it (${err.status} ${err.githubMessage}). Try again in a moment.`);
    else throw err;
    return reply.redirect(back);
  }

  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const many = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
  const keyFrom = (body: Record<string, string | string[] | undefined>) => {
    const k = parseKey(one(body.item));
    if (!k) throw new UserFacingError('Pick a ticket first.');
    return k;
  };
  const backWith = (ctx: WorkspaceRequestContext, body: Record<string, string | string[] | undefined>, k: IssueKey) => {
    const back = workspacePath(ctx, body.back, ['/moderation']) ?? areaHref(ctx, 'moderation');
    const url = new URL(back, 'http://relay.invalid');
    url.searchParams.set('open', keyOf(k));
    return `${url.pathname}${url.search}`;
  };

  action('/close', async (ctx, body, settings) => {
    const reason = one(body.reason);
    if (!isReason(reason)) throw new UserFacingError('Pick a reason.');
    const input = { reason, duplicateOf: Number(one(body.duplicate_of)) || null, postComment: one(body[`comment_${reason}`]) === '1', note: String(one(body.note) ?? '') };
    const wid = ctx.workspace.id;
    let keys = many(body.item).map(parseKey).filter((k): k is IssueKey => k !== null);
    const group = parseKey(one(body.group));
    if (group) {
      const [apps, triageSettings] = await Promise.all([listApps(deps.db, wid), getTriageSettings(deps.db, wid)]);
      const g = (await duplicateGroups(deps.db, { workspaceId: wid, apps, source: 'all' }, queueLabels(settings, triageSettings.config))).find((x) => x.repoId === group.repoId && x.number === group.number);
      if (!g?.rows.length) throw new UserFacingError('Nothing in that group is open any more.');
      keys = g.rows.map((r) => ({ repoId: r.repo_id, number: r.number }));
      if (reason === 'duplicate') input.duplicateOf = group.number;
    }
    if (!keys.length) throw new UserFacingError('Pick the tickets to close.');
    if (keys.length === 1) {
      const t = await modTarget(deps, wid, keys[0]!);
      const r = await closeOne(deps, t, settings, { ...input, userId: ctx.user.id });
      await forgetLive(deps.db, keys[0]!);
      if (r.status === 'skipped') return { message: `${r.note}, so nothing changed.`, tone: 'warn' };
      return { message: `Closed ${t.repo}#${t.number} as ${reasonName(reason)}${input.duplicateOf && reason === 'duplicate' ? ` of #${input.duplicateOf}` : ''}${r.commented ? ', with the comment' : ''}. You can undo it from the ticket or the Mod log for 15 minutes.` };
    }
    if (reason === 'duplicate') {
      if (new Set(keys.map((k) => k.repoId)).size > 1) throw new UserFacingError('A duplicate’s original must be in the same repository. Pick tickets from one repository, or another reason.');
      keys = keys.filter((k) => k.number !== input.duplicateOf);
      if (!keys.length) throw new UserFacingError('An issue can’t be a duplicate of itself.');
      await checkOriginal(deps, await modTarget(deps, wid, keys[0]!), input.duplicateOf);
    }
    const description = `${plural(keys.length, 'ticket')} as ${reasonName(reason)}${reason === 'duplicate' ? ` of #${input.duplicateOf}` : ''}`;
    const job = await startCloseJob(deps.db, wid, ctx.user.id, keys, input, description);
    return { message: `Closing ${plural(job.count, 'ticket')} in the background. You can follow it at the top of the page.` };
  });

  action('/reopen', async (ctx, body) => {
    const k = keyFrom(body);
    const t = await modTarget(deps, ctx.workspace.id, k);
    const r = await reopenOne(deps, t, ctx.user.id);
    await forgetLive(deps.db, k);
    return { message: r === 'already' ? 'It was already open.' : `Reopened ${t.repo}#${t.number}.`, tone: r === 'already' ? 'warn' : 'success', back: backWith(ctx, body, k) };
  });

  app.post('/w/:wid/moderation/undo/:id', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'moderation.edit' });
    if (!ctx) return reply;
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const back = workspacePath(ctx, body.back, ['/moderation']) ?? areaHref(ctx, 'moderation');
    try {
      const { action: a, t } = await undoAction(deps, ctx.workspace.id, (req.params as { id: string }).id, ctx.user.id);
      await forgetLive(deps.db, t);
      setFlash(reply, 'success', a.kind === 'close' ? `Undone: ${t.repo}#${t.number} is open again${a.comment_id ? ' and the comment was deleted' : ''}.` : 'Undone: the reply was deleted.');
      return reply.redirect(back);
    } catch (err) {
      return failed(reply, err, back);
    }
  });

  action('/not-duplicate', async (ctx, body, settings) => {
    const k = keyFrom(body);
    const wid = ctx.workspace.id;
    const t = await modTarget(deps, wid, k);
    const triageSettings = await getTriageSettings(deps.db, wid);
    const dismiss = async () => {
      try {
        if (t.ticket) await web.triage.dismissSuggestion(wid, t.ticket.id, 'duplicate', ctx.user.id);
        else await web.triage.dismissIssueSuggestion(wid, k.repoId, k.number, 'duplicate', ctx.user.id);
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
      }
    };
    const r = await notDuplicate(deps, t, settings, { dismiss, triageLabel: triageSettings.config.duplicate.label || null, userId: ctx.user.id });
    await forgetLive(deps.db, k);
    return { message: `Kept open: it’s no longer listed as a duplicate${r.removed.length ? `, and ${r.removed.join(', ')} was taken off` : ''}.`, back: backWith(ctx, body, k) };
  });

  action('/duplicate', async (ctx, body) => {
    const k = keyFrom(body);
    const t = await modTarget(deps, ctx.workspace.id, k);
    const of = await markDuplicate(deps, t, one(body.duplicate_of), ctx.user.id);
    return { message: `Marked as a duplicate of #${of}. It’s in Repeat bugs now; nothing changed on GitHub.`, back: backWith(ctx, body, k) };
  });

  action('/reply', async (ctx, body, settings) => {
    const k = keyFrom(body);
    const t = await modTarget(deps, ctx.workspace.id, k);
    const name = await postReply(deps, t, settings, one(body.reply), ctx.user.id);
    await forgetLive(deps.db, k);
    return { message: `Posted “${name}” on GitHub. You can undo it from the Mod log for 15 minutes.`, back: backWith(ctx, body, k) };
  });

  action('/labels', async (ctx, body) => {
    const k = keyFrom(body);
    const t = await modTarget(deps, ctx.workspace.id, k);
    const keep = new Set(many(body.keep));
    const r = await changeLabels(deps, t, { add: many(body.add), remove: many(body.had).filter((l) => !keep.has(l)), userId: ctx.user.id });
    await forgetLive(deps.db, k);
    return { message: [r.added.length ? `Added ${r.added.join(', ')}` : '', r.removed.length ? `took off ${r.removed.join(', ')}` : ''].filter(Boolean).join(' and ').replace(/^t/, 'T') + '.', back: backWith(ctx, body, k) };
  });

  action('/pin', async (ctx, body) => {
    if (!can(ctx.membership, 'known-issues.edit')) throw new UserFacingError('Pinning needs Edit on the Known-issues board.', 403);
    const k = keyFrom(body);
    const ki = await getKnownIssuesSettings(deps.db, ctx.workspace.id);
    if (!ki.enabled) throw new UserFacingError('The Known-issues board is off.');
    const t = await modTarget(deps, ctx.workspace.id, k);
    await setIssueOverride(deps.db, ctx.workspace.id, k.repoId, k.number, { pinned: true });
    await refreshBoardSoon(deps, ctx.workspace.id);
    await recordPin(deps.db, t, '', ctx.user.id);
    return { message: `#${k.number} is pinned to the Known-issues board.` };
  });

  app.post('/w/:wid/moderation/jobs/:id/stop', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'moderation.edit' });
    if (!ctx) return reply;
    try {
      const left = await stopJob(deps.db, ctx.workspace.id, (req.params as { id: string }).id);
      setFlash(reply, 'success', `Stopped. ${plural(left, 'ticket')} stay${left === 1 ? 's' : ''} open.`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(areaHref(ctx, 'moderation'));
  });

  // ---- Mod log ----------------------------------------------------------------------------------------

  const LOG_KINDS = [
    { key: 'all', label: 'Everything', kinds: null },
    { key: 'close', label: 'Closed', kinds: ['close'] },
    { key: 'reopen', label: 'Reopened', kinds: ['reopen'] },
    { key: 'duplicate', label: 'Duplicates', kinds: ['duplicate', 'not_duplicate'] },
    { key: 'reply', label: 'Replies', kinds: ['reply'] },
    { key: 'labels', label: 'Labels', kinds: ['labels', 'pin'] },
  ] as const;
  const LOG_PAGE = 50;

  app.get('/w/:wid/moderation/log', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'mod-log.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const header = await toolHeader(web, ctx, 'moderation', 'mod-log');
    const q = req.query as { kind?: string; before?: string };
    const kind = LOG_KINDS.find((k) => k.key === q.kind) ?? LOG_KINDS[0];
    const before = Number(q.before) || null;
    const [apps, settings] = await Promise.all([listApps(deps.db, wid), getModerationSettings(deps.db, wid)]);
    const params: unknown[] = [wid, JSON.stringify([...new Set(apps.map((a) => a.repo_id))])];
    const where = ['m.workspace_id = $1', 'm.repo_id IN (SELECT value FROM json_each($2))'];
    if (kind.kinds) {
      params.push(JSON.stringify(kind.kinds));
      where.push(`m.kind IN (SELECT value FROM json_each($${params.length}))`);
    }
    if (before) {
      params.push(before);
      where.push(`m.at < $${params.length}`);
    }
    params.push(LOG_PAGE + 1);
    const { rows } = await deps.db.query<ModActionRow & { sub_ref: string | null; html_url: string | null }>(
      `SELECT m.*, s.ref AS sub_ref, i.html_url FROM mod_actions m LEFT JOIN submissions s ON s.id = m.submission_id LEFT JOIN issue_index i ON i.repo_id = m.repo_id AND i.number = m.number
       WHERE ${where.join(' AND ')} ORDER BY m.at DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, LOG_PAGE);
    const names = await userNames(deps.db, page.flatMap((r) => [r.user_id, r.undone_by]));
    const act = can(ctx.membership, 'moderation.edit') && settings.enabled && canOpen(ctx.membership, 'moderation');
    const manage = canOpen(ctx.membership, 'moderation');
    const back = `${areaHref(ctx, 'mod-log')}${kind.key !== 'all' ? `?kind=${kind.key}` : ''}`;
    const link = (k: string) => `${areaHref(ctx, 'mod-log')}${k !== 'all' ? `?kind=${k}` : ''}`;
    const body = html`${header}
      <div class="card">
        <div class="toolbar">${segLinks('Show', LOG_KINDS.map((k) => ({ href: link(k.key), label: k.label, current: k.key === kind.key })))}</div>
        ${page.length ? html`<div class="table-wrap"><table>
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Ticket or issue</th><th class="actions"><span class="sr-only">Undo</span></th></tr></thead>
          <tbody>${page.map((a) => {
            const key = keyOf({ repoId: a.repo_id, number: a.number });
            return html`<tr class="${a.undone_at ? 'off' : ''}">
              <td class="nowrap small">${ago(a.at)}</td>
              <td>${a.user_id ? html`<span class="inline gap-6">${avatar(names.get(a.user_id) ?? '?', 20)}${names.get(a.user_id) ?? 'Someone'}</span>` : html`<span class="muted">Someone</span>`}</td>
              <td>${modWhat(a, names)}</td>
              <td><div>${manage ? html`<a class="cell-title" href="${areaHref(ctx, 'moderation')}?open=${key}">${a.title || `#${a.number}`}</a>` : html`<span class="cell-title">${a.title || `#${a.number}`}</span>`}</div>
                <div class="sub"><span class="mono">${repoName(apps, a.repo_id)}#${String(a.number)}</span>${a.sub_ref ? html` · <span class="mono">${a.sub_ref}</span>` : ''}${a.html_url ? html` · <a href="${a.html_url}" target="_blank" rel="noopener noreferrer">GitHub</a>` : ''}</div></td>
              <td class="actions">${act && canUndo(a) ? postBtn(`${ctx.base}/moderation/undo/${a.id}`, 'Undo', ctx.csrf, { size: 'sm', icon: 'undo-2', fields: { back }, loading: 'Undoing…', confirm: a.kind === 'close' ? { title: 'Undo this close?', body: 'It’s reopened on GitHub, and the comment and label the app added are taken off.', label: 'Undo' } : { title: 'Delete this reply?', body: 'The comment is deleted on GitHub.', label: 'Delete reply' } }) : ''}</td>
            </tr>`;
          })}</tbody></table></div>
          ${rows.length > LOG_PAGE ? html`<div class="pager"><span></span>${linkBtn(`${link(kind.key)}${kind.key === 'all' ? '?' : '&'}before=${page.at(-1)!.at.getTime()}`, 'Older', { size: 'sm', trail: 'chevron-right' })}</div>` : ''}`
          : empty('history', 'Nothing yet', kind.kinds ? 'Nothing of this kind has been done here yet.' : 'What moderators close, reopen, mark and reply shows up here.')}
        <div class="card-note">Closes and replies can be undone for 15 minutes. Notes for the team are shown on the ticket in Ticket management.</div>
      </div>`;
    return web.render(reply, ctx, 'Mod log', 'moderation', body, { width: 'full' });
  });

  // ---- Replies & reasons ----------------------------------------------------------------------------

  app.get('/w/:wid/moderation/replies', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'mod-replies.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const settings = await getModerationSettings(deps.db, wid);
    const admin = can(ctx.membership, 'manage');
    const header = await toolHeader(web, ctx, 'moderation', 'mod-replies', { after: admin ? [] : [tag('Only admins change these')] });
    const b = ctx.base;
    const openBtn = html`<span class="btn sm cl-open" aria-hidden="true"><span class="o">${admin ? 'Edit' : 'Details'}</span><span class="c">Close</span></span>`;
    const reasonRow = (r: Reason) => html`<details class="ki-row" id="r-${r.key}">
      <summary class="ki-sum"><span class="ki-ico" aria-hidden="true">${icon(r.key === 'duplicate' ? 'copy' : r.key === 'spam' ? 'triangle-alert' : r.key === 'fixed' ? 'circle-check' : 'circle-slash', 14)}</span>
        <span class="ki-main"><span class="ki-title">${r.name}${r.on ? '' : html` ${tag('Off')}`}</span><span class="ki-gist"><span>${r.desc}</span>
          <span class="ki-chips"><span class="ki-chip">Closed as ${GITHUB_CLOSE_NAMES[r.github]}</span>${r.label ? html`<span class="ki-chip">Adds ${r.label}</span>` : ''}<span class="ki-chip${r.comment.trim() ? '' : ' off'}">Comment</span></span></span></span>
        <span class="ki-side">${openBtn}</span></summary>
      <div class="ki-body">${admin
        ? html`<form method="post" action="${b}/moderation/reasons/${r.key}">${csrfField(ctx.csrf)}<div class="card-b mod-form">
            <div class="setting switch-row flat"><div><div class="lbl">Moderators can pick it</div><div class="desc">Off: it isn’t offered when closing.</div></div><div class="control">${switchInput({ name: 'on', checked: r.on, label: `${r.name}: offered`, value: '1' })}</div></div>
            <div class="field"><label for="rl-${r.key}">Label it adds <span class="opt">(optional)</span></label><input id="rl-${r.key}" type="text" name="label" value="${r.label}" maxlength="${String(LIMITS.label)}" autocomplete="off"><div class="hint">Made in the repository if it isn’t there yet.</div></div>
            <div class="field"><div class="field-head"><label for="rc-${r.key}">Comment it posts <span class="opt">(optional)</span></label><span class="counter" data-counter-for="rc-${r.key}">${String(r.comment.length)} / ${String(LIMITS.comment)}</span></div>
              <textarea id="rc-${r.key}" name="comment" maxlength="${String(LIMITS.comment)}" rows="3">${r.comment}</textarea>
              <div class="hint">${r.key === 'duplicate' ? html`<code>{duplicate}</code> becomes the original (#1204). ` : ''}<code>{app}</code> becomes the app’s name. Empty: nothing is posted. Moderators can still choose not to post it.</div></div>
          </div><div class="card-f"><span></span><div class="end">${submitBtn('Save', { variant: 'primary', loading: 'Saving…' })}</div></div></form>`
        : html`<div class="card-b"><p class="small muted">${r.label ? html`Adds ${labelTag(r.label)}. ` : ''}${r.comment.trim() ? 'Posts:' : 'Posts no comment.'}</p>${r.comment.trim() ? html`<p class="mod-reply-text">${r.comment}</p>` : ''}</div>`}</div>
    </details>`;
    const replyRow = (r: ModerationSettings['replies'][number]) => html`<details class="ki-row" id="p-${r.id}">
      <summary class="ki-sum"><span class="ki-ico" aria-hidden="true">${icon('reply', 14)}</span><span class="ki-main"><span class="ki-title">${r.name}</span><span class="ki-gist"><span class="ki-quote">${r.text}</span></span></span><span class="ki-side">${openBtn}</span></summary>
      <div class="ki-body">${admin
        ? html`<form method="post" action="${b}/moderation/replies/${r.id}">${csrfField(ctx.csrf)}<div class="card-b mod-form">
            <div class="field"><label for="pn-${r.id}">Name</label><input id="pn-${r.id}" type="text" name="name" value="${r.name}" maxlength="${String(LIMITS.replyName)}" required></div>
            <div class="field"><div class="field-head"><label for="pt-${r.id}">Text</label><span class="counter" data-counter-for="pt-${r.id}">${String(r.text.length)} / ${String(LIMITS.replyText)}</span></div><textarea id="pt-${r.id}" name="text" maxlength="${String(LIMITS.replyText)}" rows="3" required>${r.text}</textarea><div class="hint"><code>{app}</code> becomes the app’s name.</div></div>
          </div><div class="card-f">${submitBtn('Delete', { variant: 'ghost danger', size: 'sm', name: 'op', value: 'delete', attrs: raw('data-confirm-title="Delete this reply?" data-confirm-body="Moderators can no longer post it. Comments already posted stay." data-confirm-label="Delete" data-confirm-danger') })}<div class="end">${submitBtn('Save', { variant: 'primary', loading: 'Saving…' })}</div></div></form>`
        : html`<div class="card-b"><p class="mod-reply-text">${r.text}</p></div>`}</div>
    </details>`;
    const body = html`${header}
      <div class="stack">
        <div class="card"><div class="card-h strip"><div><h2>Moderation is ${settings.enabled ? 'on' : 'off'}</h2><div class="desc">${settings.enabled ? `On${settings.enabledAt ? ` since ${formatDate(settings.enabledAt)}` : ''}. People with Edit on Ticket management can close, reopen and reply.` : 'Ticket management stays empty until it’s on. Check what’s below first: it’s what the app posts on GitHub for moderators.'}</div></div>
          ${admin ? html`<div class="actions">${postBtn(`${b}/moderation/enable`, settings.enabled ? 'Turn off' : 'Turn on', ctx.csrf, { variant: settings.enabled ? 'secondary' : 'primary', fields: { on: settings.enabled ? '0' : '1' }, confirm: settings.enabled ? { title: 'Turn off Moderation?', body: 'Moderators can’t close or reply from Ticket management until it’s back on. Bulk closes running now stop at the next ticket. The Mod log is kept.', label: 'Turn off' } : undefined })}</div>` : pill(settings.enabled ? 'On' : 'Off', settings.enabled ? 'ok' : 'neutral')}</div></div>

        <section class="ki-sec"><h2>Close reasons <span class="ki-count">${String(reasonsOn(settings).length)} on</span></h2><p class="small muted">What moderators pick when they close something. Each adds its label, posts its comment and closes the issue the way GitHub shows it.</p></section>
        <div class="ki-list">${settings.reasons.map(reasonRow)}</div>

        <section class="ki-sec"><h2>Saved replies <span class="ki-count">${String(settings.replies.length)}</span></h2><p class="small muted">Comments moderators can post on an issue without closing it. They can’t write their own: what goes on GitHub is always text from here.</p></section>
        <div class="ki-list">${settings.replies.map(replyRow)}
          ${admin && settings.replies.length < LIMITS.replies ? html`<details class="ki-row" id="p-new"><summary class="ki-sum"><span class="ki-ico" aria-hidden="true">${icon('plus', 14)}</span><span class="ki-main"><span class="ki-title">Add a reply</span></span><span class="ki-side"></span></summary>
            <div class="ki-body"><form method="post" action="${b}/moderation/replies">${csrfField(ctx.csrf)}<div class="card-b mod-form">
              <div class="field"><label for="pn-new">Name</label><input id="pn-new" type="text" name="name" maxlength="${String(LIMITS.replyName)}" required placeholder="Ask for the log file"></div>
              <div class="field"><div class="field-head"><label for="pt-new">Text</label><span class="counter" data-counter-for="pt-new">0 / ${String(LIMITS.replyText)}</span></div><textarea id="pt-new" name="text" maxlength="${String(LIMITS.replyText)}" rows="3" required></textarea></div>
            </div><div class="card-f"><span></span><div class="end">${submitBtn('Add reply', { variant: 'primary', loading: 'Adding…' })}</div></div></form></div></details>` : ''}
          ${!settings.replies.length && !admin ? html`<p class="ki-empty">No saved replies yet.</p>` : ''}</div>
      </div>`;
    return web.render(reply, ctx, 'Replies & reasons', 'moderation', body);
  });

  /** Admin-only settings: saves, then back to the row that was changed. */
  function adminPost(path: string, run: (ctx: WorkspaceRequestContext, body: Record<string, string | undefined>, params: Record<string, string>) => Promise<{ message: string; hash?: string; back?: string }>) {
    app.post(`/w/:wid/moderation${path}`, async (req, reply) => {
      const ctx = await web.requireWorkspace(req, reply, { permission: 'manage' });
      if (!ctx) return reply;
      const back = areaHref(ctx, 'mod-replies');
      try {
        const r = await run(ctx, (req.body ?? {}) as Record<string, string | undefined>, req.params as Record<string, string>);
        setFlash(reply, 'success', r.message);
        return reply.redirect(r.back ?? `${back}${r.hash ?? ''}`);
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
        setFlash(reply, 'error', err.message);
        return reply.redirect(back);
      }
    });
  }

  adminPost('/enable', async (ctx, body) => {
    const on = body.on === '1';
    await setModerationEnabled(deps.db, ctx.workspace.id, on, ctx.user.id);
    if (!on) await deps.db.query(`UPDATE mod_jobs SET status = 'stopped', finished_at = now_ms() WHERE workspace_id = $1 AND status = 'running'`, [ctx.workspace.id]);
    return { message: on ? 'Moderation is on. Give moderators Ticket management on Members & permissions.' : 'Moderation is off.', back: on ? areaHref(ctx, 'moderation') : undefined };
  });

  adminPost('/reasons/:key', async (ctx, body, params) => {
    const key = params.key;
    if (!isReason(key)) throw new UserFacingError('That reason doesn’t exist.', 404);
    const label = String(body.label ?? '').trim();
    const comment = String(body.comment ?? '').replace(/\r\n/g, '\n').trim();
    if (label.length > LIMITS.label) throw new UserFacingError(`Labels can be at most ${LIMITS.label} characters.`);
    if (comment.length > LIMITS.comment) throw new UserFacingError(`The comment can be at most ${LIMITS.comment} characters.`);
    await saveReason(deps.db, ctx.workspace.id, key, { on: body.on === '1', label, comment }, ctx.user.id);
    return { message: `${REASON_DEFAULTS[key].name} saved.`, hash: `#r-${key}` };
  });

  const replyFields = (body: Record<string, string | undefined>) => {
    const name = String(body.name ?? '').trim();
    const text = String(body.text ?? '').replace(/\r\n/g, '\n').trim();
    if (!name || name.length > LIMITS.replyName) throw new UserFacingError(`Give the reply a name of up to ${LIMITS.replyName} characters.`);
    if (!text || text.length > LIMITS.replyText) throw new UserFacingError(`Write the reply, up to ${LIMITS.replyText} characters.`);
    return { name, text };
  };

  adminPost('/replies', async (ctx, body) => {
    const s = await getModerationSettings(deps.db, ctx.workspace.id);
    if (s.replies.length >= LIMITS.replies) throw new UserFacingError(`There can be at most ${LIMITS.replies} saved replies.`);
    const r = { id: newReplyId(), ...replyFields(body) };
    await saveReplies(deps.db, ctx.workspace.id, [...s.replies, r], ctx.user.id);
    return { message: `Added “${r.name}”.`, hash: `#p-${r.id}` };
  });

  adminPost('/replies/:id', async (ctx, body, params) => {
    const s = await getModerationSettings(deps.db, ctx.workspace.id);
    const r = s.replies.find((x) => x.id === params.id);
    if (!r) throw new UserFacingError('That reply was already deleted.', 404);
    if (body.op === 'delete') {
      await saveReplies(deps.db, ctx.workspace.id, s.replies.filter((x) => x.id !== r.id), ctx.user.id);
      return { message: `Deleted “${r.name}”.` };
    }
    const v = replyFields(body);
    await saveReplies(deps.db, ctx.workspace.id, s.replies.map((x) => (x.id === r.id ? { ...x, ...v } : x)), ctx.user.id);
    return { message: `Saved “${v.name}”.`, hash: `#p-${r.id}` };
  });
}
