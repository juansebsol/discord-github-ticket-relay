/**
 * Discord tickets › My tickets: a member's own tickets in this server and what's happening with
 * each, shown privately from the panel's My tickets button. A ticket marked the same as an earlier
 * report follows that report. The statuses are the known-issues board's, in its words (Looking into
 * it, Being worked on, Fixed in v1.4…), plus the ones only a ticket can have (being sent, needs
 * more information, closed). Everything comes from the database: nothing is asked of GitHub.
 * When admins allow it, a ticket's page also lets the member add details or screenshots, or close it
 * (member-actions.ts does them).
 */
import { getKnownIssuesSettings, issueStatus, statusLine, type IssueStatus, type KnownIssuesSettings } from '../bot-features/known-issues.js';
import { ComponentType, CustomId, EPHEMERAL, escapeMarkdown, NO_MENTIONS, truncate } from '../discord/messages.js';
import { DISCORD_FILE_TYPES } from './files.js';
import { MAX_NEW_FILES, MEMBER_CLOSE, MEMBER_LIMITS, type MemberActions, type MemberCloseKey } from './member-actions.js';
import { queueLabels } from '../moderation/queue.js';
import { getModerationSettings } from '../moderation/settings.js';
import { fixesFor } from '../repo-status/pulls.js';
import { getTriageSettings } from '../triage/settings.js';
import { repoReleases } from './pull-index.js';
import { decryptPayload } from './submissions.js';
import type { Deps } from './types.js';

/** The newest this many are shown. */
export const MAX_TICKETS = 100;
export const PAGE_SIZE = 10;

/** Only a ticket can be these; the rest are the board's. */
export const TICKET_STATUS_TEXT = {
  sending: '⏳ Being sent to the team',
  failed: '⚠️ Not filed yet: the team has been told',
  info: '❓ The team needs more information',
  closed: '🚫 Closed: not planned',
  duplicate: '🔁 Closed: the same as another report',
  removed: '🗑️ No longer on GitHub',
  yours: '☑️ You closed it',
} as const;
export type TicketStatus = IssueStatus | keyof typeof TICKET_STATUS_TEXT;

/** Shorter words for the Closed group's one-line entries. */
const CLOSED_SHORT: Partial<Record<TicketStatus, string>> = { closed: 'Not planned', duplicate: 'Same as another report' };

const DONE: TicketStatus[] = ['released', 'fixed', 'closed', 'duplicate', 'removed', 'yours'];

/** What the member did on it from My tickets, and the team reopening it. */
export interface MemberUpdate {
  kind: 'details' | 'files' | 'closed' | 'reopened';
  at: Date;
  /** files: how many screenshots. */
  count?: number;
  /** closed: why. */
  why?: MemberCloseKey;
}

export interface MemberTicket {
  ref: string;
  app: string;
  type: string | null;
  title: string;
  at: Date;
  filedAt: Date | null;
  status: TicketStatus;
  /** The release it was fixed in. */
  version: string | null;
  releaseAt: Date | null;
  /** Its issue; url null for a private repository (no links). */
  issue: { number: number; url: string | null } | null;
  /** The earlier report it was marked the same as; the status is that one's. */
  sameAs: { number: number; title: string; url: string | null; at: Date | null } | null;
  /** The pull request about it (or about the report it's the same as). */
  pull: { number: number; url: string | null; open: boolean; at: Date } | null;
  /** When the issue whose status is shown was closed. */
  closedAt: Date | null;
  done: boolean;
  repoPrivate: boolean;
  /** Filed and still open on GitHub: the member can add to it or close it (when admins allow it). */
  issueOpen: boolean;
  /** Other reports were marked as the same problem as this one, so only the team closes it. */
  shared: boolean;
  updates: MemberUpdate[];
}

interface TicketRow {
  id: string;
  ref: string;
  app_name: string;
  ticket_type_name: string | null;
  repo_id: number;
  repo_private: boolean;
  issue_number: number | null;
  issue_url: string | null;
  issue_state: 'open' | 'closed' | 'missing' | null;
  issue_closed_at: Date | null;
  status: string;
  payload_enc: string | null;
  created_at: Date;
  completed_at: Date | null;
  applied_actions: { kind: string; duplicateOf?: number }[] | null;
}

interface IssueRow {
  number: number;
  title: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  labels: string[];
  duplicate_of: number | null;
  html_url: string;
  closed_at: Date | null;
  gone: number;
}

/** "[Bug] [PhotoCraft] Export crashes" → "Export crashes": the prefixes tickets file with. */
const stripPrefix = (title: string) => title.replace(/^(\s*\[[^\]]*\])+\s*/, '').trim();

/** This member's tickets here (the newest MAX_TICKETS): open ones first, newest first. */
export async function memberTickets(deps: Pick<Deps, 'db' | 'box'>, workspaceId: string, discordUserId: string): Promise<MemberTicket[]> {
  const { db } = deps;
  const { rows } = await db.query<TicketRow>(
    `SELECT s.id, s.ref, s.app_name, s.ticket_type_name, s.repo_id, s.repo_private, s.issue_number, s.issue_url, s.issue_state, s.issue_closed_at, s.status, s.payload_enc,
            s.created_at, s.completed_at, t.applied_actions
       FROM submissions s LEFT JOIN triage_results t ON t.submission_id = s.id
      WHERE s.workspace_id = $1 AND s.reporter_discord_id = $2 AND s.source = 'discord' AND s.status <> 'dismissed'
      ORDER BY s.created_at DESC LIMIT ${MAX_TICKETS}`,
    [workspaceId, discordUserId],
  );
  if (!rows.length) return [];
  const [needsInfo, updates] = await Promise.all([needsInfoLabels(deps, workspaceId), memberUpdates(deps, rows.map((r) => r.id))]);

  const out: MemberTicket[] = [];
  for (const repoId of new Set(rows.map((r) => r.repo_id))) {
    const mine = rows.filter((r) => r.repo_id === repoId);
    const appliedDup = (r: TicketRow) => (r.applied_actions ?? []).find((a) => a.kind === 'duplicate' && a.duplicateOf)?.duplicateOf;

    // The tickets' issues, and the reports they copy (following "duplicate of" a few hops).
    const known = new Map<number, IssueRow>();
    let wanted = mine.flatMap((r) => [r.issue_number, appliedDup(r)]).filter((n): n is number => typeof n === 'number');
    for (let hop = 0; hop < 5 && wanted.length; hop++) {
      const missing = [...new Set(wanted)].filter((n) => !known.has(n));
      if (!missing.length) break;
      const { rows: issues } = await db.query<IssueRow>(
        'SELECT number, title, state, state_reason, labels, duplicate_of, html_url, closed_at, gone FROM issue_index WHERE repo_id = $1 AND number IN (SELECT value FROM json_each($2))',
        [repoId, missing],
      );
      for (const i of issues) known.set(i.number, i);
      wanted = issues.map((i) => i.duplicate_of).filter((n): n is number => typeof n === 'number');
    }
    const original = (n: number) => {
      const seen = new Set([n]);
      for (let hops = 0; hops < 5; hops++) {
        const next = known.get(n)?.duplicate_of;
        if (!next || seen.has(next)) break;
        seen.add(next);
        n = next;
      }
      return n;
    };
    const targets = new Map(mine.filter((r) => r.issue_number).map((r) => [r.ref, original(appliedDup(r) ?? r.issue_number!)]));
    // Their issues that other reports follow (marked the same problem as them).
    const { rows: followed } = await db.query<{ duplicate_of: number }>(
      'SELECT DISTINCT duplicate_of FROM issue_index WHERE repo_id = $1 AND gone = 0 AND duplicate_of IN (SELECT value FROM json_each($2))',
      [repoId, mine.map((r) => r.issue_number).filter((n): n is number => typeof n === 'number')],
    );
    const shared = new Set(followed.map((f) => f.duplicate_of));
    const [fixes, releases] = await Promise.all([fixesFor(db, repoId, [...new Set(targets.values())]), repoReleases(db, repoId)]);

    for (const r of mine) {
      const hidden = r.repo_private;
      const own = r.issue_number ? known.get(r.issue_number) : undefined;
      const title = stripPrefix(own?.title ?? '') || decryptPayload(deps.box, r)?.title?.trim() || `Ticket ${r.ref}`;
      const theirs = updates.get(r.id) ?? [];
      const base = {
        ref: r.ref, app: r.app_name, type: r.ticket_type_name, title, at: r.created_at, filedAt: r.completed_at,
        version: null, releaseAt: null, sameAs: null, pull: null, closedAt: null, repoPrivate: r.repo_private, updates: theirs,
        issue: r.issue_number ? { number: r.issue_number, url: hidden ? null : (own?.html_url ?? r.issue_url) } : null,
      };
      if (r.status !== 'created' || !r.issue_number) {
        const status: TicketStatus = r.status === 'failed' ? 'failed' : 'sending';
        out.push({ ...base, status, done: false, issueOpen: false, shared: false });
        continue;
      }
      const target = targets.get(r.ref)!;
      const shown = known.get(target);
      const sameAs = target !== r.issue_number
        ? { number: target, title: stripPrefix(shown?.title ?? '') || `Issue #${target}`, url: hidden ? null : (shown?.html_url ?? null), at: own?.state === 'closed' ? own.closed_at : null }
        : null;
      const fix = fixes.get(target);
      const pull = fix ? { number: fix.pull.number, url: hidden ? null : fix.pull.html_url, open: fix.status === 'open', at: fix.pull.merged_at ?? fix.pull.created_at } : null;
      const ownState = own ? own.state : r.issue_state === 'closed' ? 'closed' : 'open';
      const gone = Boolean(own?.gone) || r.issue_state === 'missing';
      // Closed by them from My tickets, and not closed again by the team since.
      const ownClosedAt = own ? own.closed_at : r.issue_closed_at;
      const theirClose = [...theirs].reverse().find((u) => u.kind === 'closed');
      const closedByThem = !sameAs && ownState === 'closed' && theirClose && ownClosedAt && Math.abs(ownClosedAt.getTime() - theirClose.at.getTime()) < 10 * 60_000;
      let status: TicketStatus;
      let version: string | null = null;
      if (!sameAs && gone) status = 'removed';
      else if (closedByThem) status = 'yours';
      else if (shown?.state === 'closed' && shown.state_reason === 'duplicate') status = 'duplicate';
      else if (shown?.state === 'closed' && shown.state_reason === 'not_planned') status = 'closed';
      else if (!sameAs && shown?.state === 'open' && shown.labels.some((l) => needsInfo.includes(String(l).toLowerCase()))) status = 'info';
      else {
        const state = shown?.state ?? (r.issue_state === 'closed' ? 'closed' : 'open');
        ({ status, version } = issueStatus({ number: target, state, closedAt: shown?.closed_at ?? null }, fix, releases));
      }
      const releaseAt = version ? releases?.find((x) => x.tag === version)?.at ?? null : null;
      out.push({
        ...base, status, version, sameAs, pull,
        releaseAt: releaseAt ? new Date(releaseAt) : null,
        closedAt: shown?.state === 'closed' ? shown.closed_at : null,
        done: DONE.includes(status),
        issueOpen: ownState === 'open' && !gone,
        shared: shared.has(r.issue_number),
      });
    }
  }
  return out.sort((a, b) => Number(a.done) - Number(b.done) || b.at.getTime() - a.at.getTime());
}

/** What each ticket's member did on it from My tickets, oldest first, and the team reopening it. */
async function memberUpdates(deps: Pick<Deps, 'db'>, submissionIds: string[]): Promise<Map<string, MemberUpdate[]>> {
  const { rows } = await deps.db.query<{ submission_id: string; kind: string; detail: { count?: number; why?: string }; at: Date }>(
    `SELECT submission_id, kind, detail, at FROM submission_events
      WHERE submission_id IN (SELECT value FROM json_each($1)) AND kind IN ('member_details', 'member_files', 'member_closed', 'mod_reopened') ORDER BY id`,
    [JSON.stringify(submissionIds)],
  );
  const out = new Map<string, MemberUpdate[]>();
  for (const e of rows) {
    const u: MemberUpdate =
      e.kind === 'member_details' ? { kind: 'details', at: e.at }
        : e.kind === 'member_files' ? { kind: 'files', at: e.at, count: Number(e.detail.count ?? 1) }
          : e.kind === 'member_closed' ? { kind: 'closed', at: e.at, why: e.detail.why === 'notNeeded' ? 'notNeeded' : 'works' }
            : { kind: 'reopened', at: e.at };
    out.set(e.submission_id, [...(out.get(e.submission_id) ?? []), u]);
  }
  return out;
}

/** The label names (lower case) that mean the team is waiting for details. */
async function needsInfoLabels(deps: Pick<Deps, 'db'>, workspaceId: string): Promise<string[]> {
  const [moderation, triage] = await Promise.all([getModerationSettings(deps.db, workspaceId), getTriageSettings(deps.db, workspaceId)]);
  return queueLabels(moderation, triage.config).needsInfo;
}

/** The status in words: the board's for the statuses it has, else a ticket's own. */
export function statusText(t: Pick<MemberTicket, 'status' | 'version'>, board: Pick<KnownIssuesSettings, 'statusText'>): string {
  return t.status in TICKET_STATUS_TEXT
    ? TICKET_STATUS_TEXT[t.status as keyof typeof TICKET_STATUS_TEXT]
    : statusLine(board, { status: t.status as IssueStatus, version: t.version });
}

// ---- The messages ---------------------------------------------------------------------------------------

const COLORS = { brand: 0x5865f2, working: 0xd99a1e, done: 0x2e9e5b, closed: 0x80848e, failed: 0xd2453b };
const safe = (t: string) => escapeMarkdown(t).replace(/\s+/g, ' ').trim();
/** A Discord timestamp: "3 days ago", in the member's own language and time zone. */
const ago = (d: Date) => `<t:${Math.floor(d.getTime() / 1000)}:R>`;
const issueLink = (n: number, url: string | null, label = `#${n}`) => (url ? `[${label}](${url})` : label);

function colorOf(s: TicketStatus): number {
  if (s === 'working' || s === 'coming') return COLORS.working;
  if (s === 'released' || s === 'fixed') return COLORS.done;
  if (s === 'closed' || s === 'duplicate' || s === 'removed' || s === 'yours') return COLORS.closed;
  return s === 'failed' ? COLORS.failed : COLORS.brand;
}

/** "✅ Fixed in v1.4" → "✅" and "Fixed in v1.4" (no icon when the words don't start with one). */
function splitIcon(s: string): { icon: string; text: string } {
  const m = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*/u.exec(s);
  return m ? { icon: m[1]!, text: s.slice(m[0].length) } : { icon: '', text: s };
}

/**
 * Their tickets, a page at a time: open ones under an Open heading (title, then what's happening),
 * closed ones under a Closed heading one line each, and a menu to see one's story.
 */
export function myTicketsPage(tickets: MemberTicket[], requestedPage: number, board: Pick<KnownIssuesSettings, 'statusText'>) {
  const pageCount = Math.max(1, Math.ceil(tickets.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const slice = tickets.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const link = (t: MemberTicket) => (t.issue ? [issueLink(t.issue.number, t.issue.url)] : []);
  const openEntry = (t: MemberTicket) =>
    `**${safe(truncate(t.title, 90))}**\n${[statusText(t, board), safe(t.app), ...link(t), ago(t.at)].join(' · ')}${t.sameAs ? `\n↳ Same problem as ${issueLink(t.sameAs.number, t.sameAs.url)}` : ''}`;
  const closedEntry = (t: MemberTicket) => {
    const { icon, text } = splitIcon(statusText(t, board));
    return [`${icon ? `${icon} ` : ''}${safe(truncate(t.title, 90))}`, CLOSED_SHORT[t.status] ?? text, ...link(t), ago(t.at)].join(' · ');
  };
  // The headings count all of them, not only this page's.
  const open = slice.filter((t) => !t.done);
  const closed = slice.filter((t) => t.done);
  const groups = [
    ...(open.length ? [`**Open · ${tickets.filter((t) => !t.done).length}**\n${open.map(openEntry).join('\n\n')}`] : []),
    ...(closed.length ? [`**Closed · ${tickets.filter((t) => t.done).length}**\n${closed.map(closedEntry).join('\n')}`] : []),
  ];
  const description = tickets.length
    ? groups.join('\n\n')
    : 'You haven’t sent any tickets here yet. Press **Open a ticket** on the panel to tell the team about a problem.';
  // Discord says "Only you can see this" under the reply itself.
  const footer = pageCount > 1 ? `Page ${page + 1} of ${pageCount}` : '';
  return {
    content: '',
    embeds: [{ title: 'Your tickets', description: truncate(description, 4096), color: COLORS.brand, ...(footer ? { footer: { text: footer } } : {}) }],
    flags: EPHEMERAL,
    components: [
      ...(slice.length
        ? [{
            type: ComponentType.ActionRow,
            components: [{
              type: ComponentType.StringSelect,
              custom_id: CustomId.myTicketsPick(page),
              placeholder: 'See what happened with a ticket…',
              options: slice.map((t) => ({ label: truncate(t.title, 100), value: t.ref, description: truncate(statusText(t, board), 100) })),
            }],
          }]
        : []),
      ...(pageCount > 1
        ? [{
            type: ComponentType.ActionRow,
            components: [
              { type: ComponentType.Button, style: 2, label: 'Previous', custom_id: CustomId.myTicketsPage(page - 1), disabled: page === 0 },
              { type: ComponentType.Button, style: 2, label: 'Next', custom_id: CustomId.myTicketsPage(page + 1), disabled: page >= pageCount - 1 },
            ],
          }]
        : []),
    ],
    allowed_mentions: NO_MENTIONS,
  };
}

/** What the member did on it, in words. */
function updateText(u: MemberUpdate): string {
  if (u.kind === 'details') return 'You added details';
  if (u.kind === 'files') return `You added ${u.count ?? 1} screenshot${u.count === 1 ? '' : 's'}`;
  if (u.kind === 'closed') return `You closed it: ${MEMBER_CLOSE[u.why ?? 'works'].story}`;
  return 'The team reopened it';
}

/**
 * What happened with it, in order: sent, filed, the same as an earlier report, a fix, closed,
 * released, with what the member added or did from My tickets in its place by time.
 */
export function ticketStory(t: MemberTicket, o: { canAnswer?: boolean } = {}): { at: Date | null; text: string }[] {
  const story: { at: Date | null; text: string }[] = [{ at: t.at, text: 'You sent it' }];
  if (t.status === 'sending') return [...story, { at: null, text: 'It’s being sent to the team' }];
  if (t.status === 'failed') return [...story, { at: null, text: 'It couldn’t be filed yet. The team has been told and can file it for you' }];
  if (t.issue) story.push({ at: t.filedAt, text: `Filed as ${issueLink(t.issue.number, t.issue.url)}` });
  if (t.sameAs) story.push({ at: t.sameAs.at, text: `Marked as the same problem as ${issueLink(t.sameAs.number, t.sameAs.url)}, reported earlier` });
  if (t.status === 'info') story.push({ at: null, text: `The team asked for more information${t.issue?.url && !o.canAnswer ? ': see the ticket on GitHub' : ''}` });
  if (t.pull) {
    const pr = issueLink(t.pull.number, t.pull.url, `pull request #${t.pull.number}`);
    story.push({ at: t.pull.at, text: t.pull.open ? `Work on a fix started (${pr})` : `A fix was finished (${pr})` });
  }
  const closed: Partial<Record<TicketStatus, string>> = {
    coming: 'Marked as fixed', released: 'Marked as fixed', fixed: 'Marked as fixed',
    closed: 'Closed: not planned', duplicate: 'Closed as the same as another report',
  };
  if (t.closedAt && closed[t.status]) story.push({ at: t.closedAt, text: closed[t.status]! });
  if (t.status === 'removed') story.push({ at: null, text: 'The ticket was removed from GitHub' });
  if (t.status === 'coming') story.push({ at: null, text: 'The fix comes in the next update' });
  if (t.status === 'released' && t.version) story.push({ at: t.releaseAt, text: `Released in ${safe(t.version)}: update to get it` });
  // Their own updates go before the first step that came after them (else last).
  for (const u of t.updates) {
    const at = story.findIndex((x) => x.at && x.at.getTime() > u.at.getTime());
    story.splice(at < 0 ? story.length : at, 0, { at: u.at, text: updateText(u) });
  }
  return story;
}

/** The buttons a ticket's page can show: the actions admins turned on. */
export type TicketActions = Pick<MemberActions, 'details' | 'files' | 'close'>;
const NO_ACTIONS: TicketActions = { details: false, files: false, close: false };

/**
 * One ticket: its status, where it is, and its story, with the actions admins allow while it's open.
 * Back returns to the page it was picked from. `banner`: how an action went, above it. `busy`: an
 * action is being done, so no buttons until it's finished.
 */
export function myTicketDetail(t: MemberTicket, page: number, board: Pick<KnownIssuesSettings, 'statusText'>, o: { actions?: TicketActions; banner?: string; busy?: boolean } = {}) {
  const actions = t.issueOpen && !o.busy ? (o.actions ?? NO_ACTIONS) : NO_ACTIONS;
  const answer = t.status === 'info' && actions.details;
  const where = t.issue ? (t.issue.url ? `[#${t.issue.number} on GitHub](${t.issue.url})` : `#${t.issue.number} (private repository)`) : 'not filed yet';
  const lines = [
    `**Status:** ${statusText(t, board)}`,
    ...(answer ? ['Press **Add details** to answer the team.'] : []),
    `**App:** ${safe(t.app)}${t.type ? ` · **Type:** ${safe(t.type)}` : ''}`,
    `**Ticket:** ${where} · \`${t.ref}\``,
    ...(t.sameAs ? ['', `It’s the same problem as ${issueLink(t.sameAs.number, t.sameAs.url)} (**${safe(truncate(t.sameAs.title, 120))}**), so its status is shown.`] : []),
    '',
    '**What happened**',
    ...ticketStory(t, { canAnswer: answer }).map((s) => `- ${s.text}${s.at ? ` · ${ago(s.at)}` : ''}`),
  ];
  const buttons = [
    ...(actions.details ? [{ type: ComponentType.Button, style: answer ? 1 : 2, label: 'Add details', custom_id: CustomId.myTicket('d', t.ref, page) }] : []),
    ...(actions.files ? [{ type: ComponentType.Button, style: 2, label: 'Add screenshots', custom_id: CustomId.myTicket('f', t.ref, page) }] : []),
    ...(actions.close && !t.shared ? [{ type: ComponentType.Button, style: 2, label: 'Close my ticket', custom_id: CustomId.myTicket('c', t.ref, page) }] : []),
  ];
  return {
    content: o.banner ? truncate(o.banner, 2000) : '',
    embeds: [{ title: truncate(t.title, 256), description: truncate(lines.join('\n'), 4096), color: colorOf(t.status) }],
    flags: EPHEMERAL,
    components: o.busy ? [] : [
      ...(buttons.length ? [{ type: ComponentType.ActionRow, components: buttons }] : []),
      {
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, style: 2, label: 'Back to your tickets', custom_id: CustomId.myTicketsPage(page) },
          ...(t.issue?.url ? [{ type: ComponentType.Button, style: 5, label: 'Open on GitHub', url: t.issue.url }] : []),
        ],
      },
    ],
    allowed_mentions: NO_MENTIONS,
  };
}

/** Close my ticket: why, before it's closed. Cancel goes back to the ticket. */
export function closeConfirm(t: MemberTicket, page: number) {
  return {
    content: '',
    embeds: [{
      title: 'Close this ticket?',
      description: `**${safe(truncate(t.title, 200))}**\n\nTell the team why. It’s closed on GitHub and moves to your closed tickets. If the problem comes back, open a new ticket from the panel.`,
      color: COLORS.brand,
    }],
    flags: EPHEMERAL,
    components: [{
      type: ComponentType.ActionRow,
      components: [
        { type: ComponentType.Button, style: 3, label: MEMBER_CLOSE.works.label, custom_id: CustomId.myTicket('cw', t.ref, page) },
        { type: ComponentType.Button, style: 2, label: MEMBER_CLOSE.notNeeded.label, custom_id: CustomId.myTicket('cn', t.ref, page) },
        { type: ComponentType.Button, style: 2, label: 'Cancel', custom_id: CustomId.myTicket('v', t.ref, page) },
      ],
    }],
    allowed_mentions: NO_MENTIONS,
  };
}

/** What the modals say first: the ticket they add to, and who can read it (the Panel's notice). */
function modalLead(t: MemberTicket, notice: string): string {
  return truncate(`Adding to **${safe(truncate(t.title, 150))}**${t.issue ? ` (#${t.issue.number})` : ''}.\n\n${notice}`, 4000);
}

/** Add details: a paragraph the team gets as a comment on the issue. */
export function detailsModal(t: MemberTicket, page: number, notice: string) {
  return {
    custom_id: CustomId.myTicket('d', t.ref, page),
    title: 'Add details',
    components: [
      { type: ComponentType.TextDisplay, content: modalLead(t, notice) },
      {
        type: ComponentType.Label,
        label: 'What else should the team know?',
        description: 'For example the steps, what you tried, or when it happens.',
        component: { type: ComponentType.TextInput, custom_id: CustomId.detailsInput, style: 2, min_length: 10, max_length: MEMBER_LIMITS.details, required: true },
      },
    ],
  };
}

/** Add screenshots: images added to the issue like the ones sent with the ticket. */
export function screenshotsModal(t: MemberTicket, page: number, notice: string) {
  return {
    custom_id: CustomId.myTicket('f', t.ref, page),
    title: 'Add screenshots',
    components: [
      { type: ComponentType.TextDisplay, content: modalLead(t, notice) },
      {
        type: ComponentType.Label,
        label: 'Screenshots',
        description: `Up to ${MAX_NEW_FILES} PNG or JPG images. Hide anything private first.`,
        component: { type: ComponentType.FileUpload, custom_id: CustomId.screenshotsInput, min_values: 1, max_values: MAX_NEW_FILES, required: true, file_types: DISCORD_FILE_TYPES },
      },
    ],
  };
}

/** The board's status words, for the messages (its defaults when it was never set up). */
export async function statusWords(deps: Pick<Deps, 'db'>, workspaceId: string): Promise<Pick<KnownIssuesSettings, 'statusText'>> {
  return { statusText: (await getKnownIssuesSettings(deps.db, workspaceId)).statusText };
}
