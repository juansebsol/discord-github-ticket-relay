/**
 * Everything Ticket management shows about one issue: the ticket and what was filed, triage's
 * verdict, the original it duplicates with its fix, similar issues, and one history from
 * Discord, Ticket Relay and GitHub in order. GitHub's side is read live (and kept a minute).
 */
import type { Queryable } from '../db/database.js';
import { ftsQuery, getIndexed, searchIndex, type IndexedIssue, type SearchHit } from '../domain/issue-index.js';
import { pullsForIssues, releaseOf, repoReleases, type IndexedPull, type Release } from '../domain/pull-index.js';
import { getGitHubConnection, getDiscordConnection, listApps } from '../domain/store.js';
import { decryptPayload, listEvents } from '../domain/submissions.js';
import type { AppRow, Deps, SubmissionRow } from '../domain/types.js';
import { GitHubApiError, type IssueDetail, type TimelineEvent } from '../github/client.js';
import { parseIssueBody } from '../github/issue-content.js';
import type { IssueTriageRow, TriageAction, TriageResultRow } from '../triage/engine.js';
import { ticketFor, type ModActionRow } from './actions.js';
import type { IssueKey } from './queue.js';

const LIVE_TIMEOUT_MS = 5000;
const CACHE_MS = 60_000;
const CACHE_MAX = 300;

type Live = { issue: IssueDetail; events: TimelineEvent[]; more: boolean } | { error: 'missing' | 'error' };

/** GitHub's side of recently opened issues, so moving through a list stays quick. */
const cache = new Map<string, { at: number; live: Live }>();

export function forgetLive(key: IssueKey): void {
  cache.delete(`${key.repoId}-${key.number}`);
}

async function loadLive(deps: Deps, installationId: number, app: AppRow, number: number): Promise<Live> {
  const k = `${app.repo_id}-${number}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.live;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let live: Live;
  try {
    const gh = deps.github!;
    const [issue, timeline] = await Promise.race([
      Promise.all([gh.getIssueDetail(installationId, app.repo_owner, app.repo_name, number), gh.listIssueTimeline(installationId, app.repo_owner, app.repo_name, number)]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), LIVE_TIMEOUT_MS); }),
    ]);
    live = { issue, events: timeline.events, more: timeline.more };
  } catch (err) {
    live = { error: err instanceof GitHubApiError && (err.status === 404 || err.status === 410) ? 'missing' : 'error' };
  } finally {
    clearTimeout(timer);
  }
  if (!('error' in live && live.error === 'error')) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(k, { at: Date.now(), live });
  }
  return live;
}

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

export async function loadDetail(deps: Deps, workspaceId: string, key: IssueKey, triage: { ticket: (id: string) => Promise<TriageResultRow | null>; issue: () => Promise<IssueTriageRow | null> }): Promise<Detail | null> {
  const { db } = deps;
  const [apps, conn, dc] = await Promise.all([listApps(db, workspaceId), getGitHubConnection(db, workspaceId), getDiscordConnection(db, workspaceId)]);
  const inRepo = apps.filter((a) => a.repo_id === key.repoId);
  if (!inRepo.length) return null;
  const [indexed, ticket] = await Promise.all([getIndexed(db, key.repoId, [key.number]).then((m) => m.get(key.number) ?? null), ticketFor(db, workspaceId, key.repoId, key.number)]);
  const app = inRepo.find((a) => a.id === ticket?.app_id) ?? inRepo.find((a) => a.name === indexed?.app_name) ?? inRepo[0]!;
  const live = deps.github && conn ? await loadLive(deps, conn.installation_id, app, key.number) : ({ error: 'error' } as const);
  if (!indexed && !ticket && 'error' in live) return null;
  const issue = 'error' in live ? null : live.issue;
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
  if (!('error' in live)) {
    const events = live.events.filter((e) => !((e.kind === 'closed' || e.kind === 'reopened' || e.kind === 'labeled' || e.kind === 'unlabeled') && e.actor?.endsWith('[bot]') && nearMod(e.at)));
    history.push(...groupLabels(events));
  }
  for (const a of actions) history.push({ kind: 'mod', at: a.at, action: a });
  history.sort((a, b) => a.at.getTime() - b.at.getTime());

  const lastClose = actions.find((a) => a.kind === 'close' && !a.undone_at) ?? null;
  const state = issue?.state ?? indexed?.state ?? 'open';
  return {
    key, app, repoUrl: `https://github.com/${app.repo_owner}/${app.repo_name}`, indexed, live: issue, liveError: 'error' in live ? live.error : null, ticket, text, title,
    state, stateReason: issue?.stateReason ?? indexed?.state_reason ?? null, labels: issue?.labels ?? indexed?.labels ?? [],
    url: issue?.url ?? indexed?.html_url ?? `https://github.com/${app.repo_owner}/${app.repo_name}/issues/${key.number}`,
    verdict, original, pull, pullRelease: pull?.merged_at && releases ? releaseOf(pull.merged_at, releases) : null, similar, reporterTickets,
    discord: ticket ? { profile: `https://discord.com/users/${ticket.reporter_discord_id}`, channel: ticket.discord_guild_id && ticket.discord_channel_id ? `https://discord.com/channels/${ticket.discord_guild_id}/${ticket.discord_channel_id}` : null } : null,
    history, historyMore: 'error' in live ? false : live.more,
    lastClose: state === 'closed' ? lastClose : null,
    userIds: actions.flatMap((a) => [a.user_id, a.undone_by]).concat(history.flatMap((h) => (h.kind === 'event' && typeof h.event.detail.by === 'string' ? [h.event.detail.by] : []))).filter((x): x is string => Boolean(x)),
  };
}
