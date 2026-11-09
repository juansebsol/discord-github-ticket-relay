/**
 * Discord tickets › My tickets: a member's own tickets in this server and what's happening with
 * each, shown privately from the panel's My tickets button. A ticket marked the same as an earlier
 * report follows that report. The statuses are the known-issues board's, in its words (Looking into
 * it, Being worked on, Fixed in v1.4…), plus the ones only a ticket can have (being sent, needs
 * more information, closed). Everything comes from the database: nothing is asked of GitHub.
 */
import { getKnownIssuesSettings, issueStatus, statusLine, type IssueStatus, type KnownIssuesSettings } from '../bot-features/known-issues.js';
import { ComponentType, CustomId, EPHEMERAL, escapeMarkdown, NO_MENTIONS, truncate } from '../discord/messages.js';
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
} as const;
export type TicketStatus = IssueStatus | keyof typeof TICKET_STATUS_TEXT;

/** Shorter words for the Closed group's one-line entries. */
const CLOSED_SHORT: Partial<Record<TicketStatus, string>> = { closed: 'Not planned', duplicate: 'Same as another report' };

const DONE: TicketStatus[] = ['released', 'fixed', 'closed', 'duplicate', 'removed'];

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
}

interface TicketRow {
  ref: string;
  app_name: string;
  ticket_type_name: string | null;
  repo_id: number;
  repo_private: boolean;
  issue_number: number | null;
  issue_url: string | null;
  issue_state: 'open' | 'closed' | 'missing' | null;
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
    `SELECT s.ref, s.app_name, s.ticket_type_name, s.repo_id, s.repo_private, s.issue_number, s.issue_url, s.issue_state, s.status, s.payload_enc,
            s.created_at, s.completed_at, t.applied_actions
       FROM submissions s LEFT JOIN triage_results t ON t.submission_id = s.id
      WHERE s.workspace_id = $1 AND s.reporter_discord_id = $2 AND s.source = 'discord' AND s.status <> 'dismissed'
      ORDER BY s.created_at DESC LIMIT ${MAX_TICKETS}`,
    [workspaceId, discordUserId],
  );
  if (!rows.length) return [];
  const needsInfo = await needsInfoLabels(deps, workspaceId);

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
    const [fixes, releases] = await Promise.all([fixesFor(db, repoId, [...new Set(targets.values())]), repoReleases(db, repoId)]);

    for (const r of mine) {
      const hidden = r.repo_private;
      const own = r.issue_number ? known.get(r.issue_number) : undefined;
      const title = stripPrefix(own?.title ?? '') || decryptPayload(deps.box, r)?.title?.trim() || `Ticket ${r.ref}`;
      const base = {
        ref: r.ref, app: r.app_name, type: r.ticket_type_name, title, at: r.created_at, filedAt: r.completed_at,
        version: null, releaseAt: null, sameAs: null, pull: null, closedAt: null,
        issue: r.issue_number ? { number: r.issue_number, url: hidden ? null : (own?.html_url ?? r.issue_url) } : null,
      };
      if (r.status !== 'created' || !r.issue_number) {
        const status: TicketStatus = r.status === 'failed' ? 'failed' : 'sending';
        out.push({ ...base, status, done: false });
        continue;
      }
      const target = targets.get(r.ref)!;
      const shown = known.get(target);
      const sameAs = target !== r.issue_number
        ? { number: target, title: stripPrefix(shown?.title ?? '') || `Issue #${target}`, url: hidden ? null : (shown?.html_url ?? null), at: own?.state === 'closed' ? own.closed_at : null }
        : null;
      const fix = fixes.get(target);
      const pull = fix ? { number: fix.pull.number, url: hidden ? null : fix.pull.html_url, open: fix.status === 'open', at: fix.pull.merged_at ?? fix.pull.created_at } : null;
      let status: TicketStatus;
      let version: string | null = null;
      if (!sameAs && (own?.gone || r.issue_state === 'missing')) status = 'removed';
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
      });
    }
  }
  return out.sort((a, b) => Number(a.done) - Number(b.done) || b.at.getTime() - a.at.getTime());
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
  if (s === 'closed' || s === 'duplicate' || s === 'removed') return COLORS.closed;
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

/** What happened with it, in order: sent, filed, the same as an earlier report, a fix, closed, released. */
export function ticketStory(t: MemberTicket): { at: Date | null; text: string }[] {
  const story: { at: Date | null; text: string }[] = [{ at: t.at, text: 'You sent it' }];
  if (t.status === 'sending') return [...story, { at: null, text: 'It’s being sent to the team' }];
  if (t.status === 'failed') return [...story, { at: null, text: 'It couldn’t be filed yet. The team has been told and can file it for you' }];
  if (t.issue) story.push({ at: t.filedAt, text: `Filed as ${issueLink(t.issue.number, t.issue.url)}` });
  if (t.sameAs) story.push({ at: t.sameAs.at, text: `Marked as the same problem as ${issueLink(t.sameAs.number, t.sameAs.url)}, reported earlier` });
  if (t.status === 'info') story.push({ at: null, text: `The team asked for more information${t.issue?.url ? ': see the ticket on GitHub' : ''}` });
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
  return story;
}

/** One ticket: its status, where it is, and its story. Back returns to the page it was picked from. */
export function myTicketDetail(t: MemberTicket, page: number, board: Pick<KnownIssuesSettings, 'statusText'>) {
  const where = t.issue ? (t.issue.url ? `[#${t.issue.number} on GitHub](${t.issue.url})` : `#${t.issue.number} (private repository)`) : 'not filed yet';
  const lines = [
    `**Status:** ${statusText(t, board)}`,
    `**App:** ${safe(t.app)}${t.type ? ` · **Type:** ${safe(t.type)}` : ''}`,
    `**Ticket:** ${where} · \`${t.ref}\``,
    ...(t.sameAs ? ['', `It’s the same problem as ${issueLink(t.sameAs.number, t.sameAs.url)} (**${safe(truncate(t.sameAs.title, 120))}**), so its status is shown.`] : []),
    '',
    '**What happened**',
    ...ticketStory(t).map((s) => `- ${s.text}${s.at ? ` · ${ago(s.at)}` : ''}`),
  ];
  return {
    content: '',
    embeds: [{ title: truncate(t.title, 256), description: truncate(lines.join('\n'), 4096), color: colorOf(t.status) }],
    flags: EPHEMERAL,
    components: [{
      type: ComponentType.ActionRow,
      components: [
        { type: ComponentType.Button, style: 2, label: 'Back to your tickets', custom_id: CustomId.myTicketsPage(page) },
        ...(t.issue?.url ? [{ type: ComponentType.Button, style: 5, label: 'Open on GitHub', url: t.issue.url }] : []),
      ],
    }],
    allowed_mentions: NO_MENTIONS,
  };
}

/** The board's status words, for the messages (its defaults when it was never set up). */
export async function statusWords(deps: Pick<Deps, 'db'>, workspaceId: string): Promise<Pick<KnownIssuesSettings, 'statusText'>> {
  return { statusText: (await getKnownIssuesSettings(deps.db, workspaceId)).statusText };
}
