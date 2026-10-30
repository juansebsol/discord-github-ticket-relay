/**
 * Everything Ticket management shows about one issue: the ticket and what was filed, triage's
 * verdict, the original it duplicates with its fix, similar issues, and one history from
 * Discord, Ticket Relay and GitHub in order. GitHub's side comes from the copy kept in the
 * database (live.ts), read again in the background when it's out of date.
 */
import { createHash } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import { ftsQuery, getIndexed, searchIndex, type IndexedIssue, type SearchHit } from '../domain/issue-index.js';
import { pullsForIssues, releaseOf, repoReleases, type IndexedPull, type Release } from '../domain/pull-index.js';
import { getGitHubConnection, getDiscordConnection, listApps } from '../domain/store.js';
import { decryptPayload, listEvents } from '../domain/submissions.js';
import type { AppRow, Deps, SubmissionRow } from '../domain/types.js';
import type { IssueDetail, TimelineEvent } from '../github/client.js';
import { parseIssueBody } from '../github/issue-content.js';
import type { IssueTriageRow, TriageAction, TriageResultRow } from '../triage/engine.js';
import { claimOf, type Claim } from '../mcp/claims.js';
import { ticketFor, type ModActionRow } from './actions.js';
import { isFresh, refreshLive, storedLive, type Live } from './live.js';
import type { IssueKey } from './queue.js';

export type HistoryItem =
  | { kind: 'filed'; at: Date; reporter: string; username: string | null; channel: string | null }
  | { kind: 'opened'; at: Date; author: string | null }
  | { kind: 'event'; at: Date; event: { kind: string; detail: Record<string, unknown> } }
  | { kind: 'github'; at: Date; event: TimelineEvent; labels?: { added: string[]; removed: string[] } }
  | { kind: 'mod'; at: Date; action: ModActionRow };

export interface Verdict {
  /** The original, triage's confidence (null: marked by someone or applied) and whether it's still waiting in Review. */
  duplicate: { of: number; confidence: number | null; waiting: boolean; by: 'triage' | 'moderator' } | null;
  fixed: TriageAction | null;
  inProgress: TriageAction | null;
  spam: TriageAction | null;
  needsInfo: TriageAction | null;
}

export interface Detail {
  key: IssueKey;
  app: AppRow;
  repoUrl: string;
  indexed: IndexedIssue | null;
  live: IssueDetail | null;
  /** When GitHub's side was read (null: not yet), and whether it's being read again now. */
  liveAt: Date | null;
  loading: boolean;
  liveError: 'missing' | 'error' | null;
  ticket: SubmissionRow | null;
  /** The ticket's text (from the GitHub issue, else stored until it's filed), or an issue's body. */
  text: { kind: 'ticket'; description: string; answers: { question: string; value: string }[] } | { kind: 'body'; body: string } | null;
  title: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: string[];
  url: string;
  verdict: Verdict;
  original: { number: number; issue: IndexedIssue | null; duplicates: number; pull: IndexedPull | null; release: Release | null } | null;
  /** A pull request for this issue itself (fixing it first). */
  pull: IndexedPull | null;
  pullRelease: Release | null;
  similar: SearchHit[];
  reporterTickets: number;
  discord: { profile: string; channel: string | null } | null;
  history: HistoryItem[];
  historyMore: boolean;
  /** The latest close here, while it can be undone or reopened. */
  lastClose: ModActionRow | null;
  /** Someone's coding agent claimed it ("I'm on it", MCP). */
  claim: Claim | null;
  userIds: string[];
}

function findAction(row: Pick<TriageResultRow, 'suggestions' | 'applied_actions'> | null, kind: string): { a: TriageAction; waiting: boolean } | null {
  const waiting = (row?.suggestions ?? []).find((a) => a.kind === kind);
  if (waiting) return { a: waiting, waiting: true };
  const applied = (row?.applied_actions ?? []).find((a) => a.kind === kind);
  return applied ? { a: applied, waiting: false } : null;
}

/** Label events GitHub lists one by one, as one line when the same person changed them together. */
function groupLabels(events: TimelineEvent[]): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const e of events) {
    const prev = out.at(-1);
    if ((e.kind === 'labeled' || e.kind === 'unlabeled') && prev?.kind === 'github' && prev.labels && prev.event.actor === e.actor && e.at.getTime() - prev.at.getTime() < 60_000) {
      (e.kind === 'labeled' ? prev.labels.added : prev.labels.removed).push(e.label);
      continue;
    }
    if (e.kind === 'labeled' || e.kind === 'unlabeled') out.push({ kind: 'github', at: e.at, event: e, labels: { added: e.kind === 'labeled' ? [e.label] : [], removed: e.kind === 'unlabeled' ? [e.label] : [] } });
    else out.push({ kind: 'github', at: e.at, event: e });
  }
  return out;
}

export async function modActionsFor(db: Queryable, workspaceId: string, key: IssueKey, limit = 50): Promise<ModActionRow[]> {
  const { rows } = await db.query<ModActionRow>('SELECT * FROM mod_actions WHERE workspace_id = $1 AND repo_id = $2 AND number = $3 ORDER BY at DESC LIMIT $4', [workspaceId, key.repoId, key.number, limit]);
  return rows;
}

/** How many open issues name this one as their original (moderators, triage or a suggestion). */
async function openDuplicates(db: Queryable, workspaceId: string, repoId: number, number: number): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*) AS n FROM issue_index i
     WHERE i.repo_id = $2 AND i.state = 'open' AND i.gone = 0 AND (i.duplicate_of = $3 OR EXISTS (
       SELECT 1 FROM submissions s JOIN triage_results t ON t.submission_id = s.id, json_each(COALESCE(t.suggestions, '[]')) a
       WHERE s.workspace_id = $1 AND s.repo_id = i.repo_id AND s.issue_number = i.number AND json_extract(a.value, '$.kind') = 'duplicate' AND json_extract(a.value, '$.duplicateOf') = $3
     ) OR EXISTS (
       SELECT 1 FROM issue_triage t, json_each(COALESCE(t.suggestions, '[]')) a
       WHERE t.workspace_id = $1 AND t.repo_id = i.repo_id AND t.number = i.number AND json_extract(a.value, '$.kind') = 'duplicate' AND json_extract(a.value, '$.duplicateOf') = $3
     ))`,
    [workspaceId, repoId, number],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function loadDetail(
  deps: Deps,
  workspaceId: string,
  key: IssueKey,
  triage: { ticket: (id: string) => Promise<TriageResultRow | null>; issue: () => Promise<IssueTriageRow | null> },
  o: { fresh?: boolean } = {},
): Promise<Detail | null> {
  const { db } = deps;
  const [apps, conn, dc] = await Promise.all([listApps(db, workspaceId), getGitHubConnection(db, workspaceId), getDiscordConnection(db, workspaceId)]);
  const inRepo = apps.filter((a) => a.repo_id === key.repoId);
  if (!inRepo.length) return null;
  const [indexed, ticket] = await Promise.all([getIndexed(db, key.repoId, [key.number]).then((m) => m.get(key.number) ?? null), ticketFor(db, workspaceId, key.repoId, key.number)]);
  const app = inRepo.find((a) => a.id === ticket?.app_id) ?? inRepo.find((a) => a.name === indexed?.app_name) ?? inRepo[0]!;
  // The page shows the copy kept here, whatever its age, and reads GitHub only when there's nothing
  // else to show; the history (o.fresh) waits for a copy under a minute old.
  const stored = await storedLive(deps, key);
  let live: Live | null = stored?.live ?? null;
  let liveAt = stored?.fetchedAt ?? null;
  let loading = false;
  let unreachable = false;
  if (!deps.github || !conn) unreachable = true;
  else if (o.fresh ? !isFresh(stored) : !stored && !indexed && !ticket) {
    const read = await refreshLive(deps, conn.installation_id, app, key.number);
    if ('error' in read && read.error === 'error') unreachable = true;
    else [live, liveAt] = [read, new Date()];
  } else loading = !isFresh(stored);
  if (!indexed && !ticket && (!live || 'error' in live)) return null;
  const issue = live && !('error' in live) ? live.issue : null;
  const events = live && !('error' in live) ? live : null;
  const liveError = live && 'error' in live ? live.error : unreachable ? 'error' : null;
  if (issue?.isPullRequest) return null;

  const triageRow = ticket ? await triage.ticket(ticket.id) : await triage.issue();
  const done = triageRow?.status === 'done' ? triageRow : null;
  const actions = await modActionsFor(db, workspaceId, key);
  const notDup = actions.find((a) => a.kind === 'not_duplicate' && !a.undone_at);
  const marked = actions.find((a) => a.kind === 'duplicate' && !a.undone_at);
  const dup = findAction(done, 'duplicate');
  const dupOf = notDup ? null : indexed?.duplicate_of ?? (dup?.waiting ? dup.a.duplicateOf ?? null : null);
  const verdict: Verdict = {
    duplicate: dupOf ? { of: dupOf, confidence: !marked && dup ? dup.a.confidence : null, waiting: Boolean(!marked && dup?.waiting && dup.a.duplicateOf === dupOf), by: marked ? 'moderator' : 'triage' } : null,
    fixed: findAction(done, 'fixed')?.a ?? null,
    inProgress: findAction(done, 'inProgress')?.a ?? null,
    spam: findAction(done, 'spam')?.a ?? null,
    needsInfo: findAction(done, 'needsInfo')?.a ?? null,
  };

  const title = issue?.title ?? indexed?.title ?? (ticket ? decryptPayload(deps.box, ticket)?.title : null) ?? `#${key.number}`;
  const releases = await repoReleases(db, key.repoId);
  const pulls = await pullsForIssues(db, key.repoId, [key.number, ...(dupOf ? [dupOf] : [])]);
  let original: Detail['original'] = null;
  if (dupOf) {
    const [o, n] = await Promise.all([getIndexed(db, key.repoId, [dupOf]).then((m) => m.get(dupOf) ?? null), openDuplicates(db, workspaceId, key.repoId, dupOf)]);
    const pull = pulls.get(dupOf)?.[0] ?? null;
    original = { number: dupOf, issue: o, duplicates: n, pull, release: pull?.merged_at && releases ? releaseOf(pull.merged_at, releases) : null };
  }
  const pull = pulls.get(key.number)?.[0] ?? null;

  const query = ftsQuery(title, indexed?.excerpt ?? '');
  const similar = query
    ? (await searchIndex(db, { repoIds: [key.repoId], query, limit: 6, exclude: { repoId: key.repoId, number: key.number } })).filter((h) => h.number !== dupOf).slice(0, 4)
    : [];
  const reporterTickets = ticket
    ? Number((await db.query<{ n: number }>('SELECT count(*) AS n FROM submissions WHERE workspace_id = $1 AND reporter_discord_id = $2 AND created_at >= $3', [workspaceId, ticket.reporter_discord_id, new Date(Date.now() - 30 * 86_400_000)])).rows[0]?.n ?? 0)
    : 0;

  let text: Detail['text'] = null;
  if (ticket && issue) text = { kind: 'ticket', ...parseIssueBody(issue.body) };
  else if (ticket) {
    const p = decryptPayload(deps.box, ticket);
    text = p?.description ? { kind: 'ticket', description: p.description, answers: p.answers ?? [] } : null;
  } else if (issue) text = { kind: 'body', body: issue.body };

  // One history, oldest first. GitHub's own record of what the app did for a moderator is left out
  // when the moderator's action is shown (closing and reopening within two minutes of it).
  const history: HistoryItem[] = [];
  const channel = ticket?.discord_channel_id && dc?.tickets_channel_id === ticket.discord_channel_id ? dc.tickets_channel_name : null;
  if (ticket) history.push({ kind: 'filed', at: ticket.created_at, reporter: ticket.reporter_display_name, username: ticket.reporter_username, channel });
  else history.push({ kind: 'opened', at: issue?.createdAt ?? indexed?.created_at ?? new Date(0), author: issue?.author ?? indexed?.author ?? null });
  if (ticket) {
    for (const e of await listEvents(db, ticket.id)) if (e.kind !== 'accepted' && !e.kind.startsWith('mod_')) history.push({ kind: 'event', at: e.at, event: e });
  } else if (triageRow && 'id' in triageRow) {
    const { rows } = await db.query<{ at: Date; kind: string; detail: Record<string, unknown> }>('SELECT at, kind, detail FROM issue_triage_events WHERE triage_id = $1 ORDER BY id', [triageRow.id]);
    for (const e of rows) history.push({ kind: 'event', at: e.at, event: e });
  }
  const modTimes = actions.filter((a) => a.kind === 'close' || a.kind === 'reopen' || a.kind === 'labels').map((a) => a.at.getTime());
  const nearMod = (at: Date) => modTimes.some((t) => Math.abs(t - at.getTime()) < 120_000);
  if (events) {
    const shown = events.events.filter((e) => !((e.kind === 'closed' || e.kind === 'reopened' || e.kind === 'labeled' || e.kind === 'unlabeled') && e.actor?.endsWith('[bot]') && nearMod(e.at)));
    history.push(...groupLabels(shown));
  }
  for (const a of actions) history.push({ kind: 'mod', at: a.at, action: a });
  history.sort((a, b) => a.at.getTime() - b.at.getTime());

  const lastClose = actions.find((a) => a.kind === 'close' && !a.undone_at) ?? null;
  const claim = await claimOf(db, workspaceId, key);
  const state = issue?.state ?? indexed?.state ?? 'open';
  return {
    key, app, repoUrl: `https://github.com/${app.repo_owner}/${app.repo_name}`, indexed, live: issue, liveAt, loading, liveError, ticket, text, title,
    state, stateReason: issue?.stateReason ?? indexed?.state_reason ?? null, labels: issue?.labels ?? indexed?.labels ?? [],
    url: issue?.url ?? indexed?.html_url ?? `https://github.com/${app.repo_owner}/${app.repo_name}/issues/${key.number}`,
    verdict, original, pull, pullRelease: pull?.merged_at && releases ? releaseOf(pull.merged_at, releases) : null, similar, reporterTickets,
    discord: ticket ? { profile: `https://discord.com/users/${ticket.reporter_discord_id}`, channel: ticket.discord_guild_id && ticket.discord_channel_id ? `https://discord.com/channels/${ticket.discord_guild_id}/${ticket.discord_channel_id}` : null } : null,
    history, historyMore: events?.more ?? false,
    lastClose: state === 'closed' ? lastClose : null,
    claim,
    userIds: actions.flatMap((a) => [a.user_id, a.undone_by]).concat(history.flatMap((h) => (h.kind === 'event' && typeof h.event.detail.by === 'string' ? [h.event.detail.by] : []))).filter((x): x is string => Boolean(x)),
  };
}

/** What the page shows from GitHub at the top (title, state, labels), to tell when a fresher read changed it. */
export function detailSig(d: Pick<Detail, 'title' | 'state' | 'stateReason' | 'labels' | 'liveError'>): string {
  const text = [d.title, d.state, d.stateReason ?? '', [...d.labels].sort().join('\n'), d.liveError === 'missing' ? 'missing' : ''].join('\u0000');
  return createHash('sha256').update(text).digest('base64url').slice(0, 12);
}
