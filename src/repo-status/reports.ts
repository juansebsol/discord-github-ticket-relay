/**
 * Repo status › Most reported: GitHub issues ranked by how many Discord tickets are about them.
 *
 * A ticket counts for the issue it filed or, when it's a duplicate (applied by triage, or marked on
 * GitHub and picked up by the issue index), for the original it copies. Duplicates Claude suggested
 * that nobody has reviewed yet count too, kept apart so the page can say so. Issues opened directly
 * on GitHub as duplicates are counted on the side. Everything comes from the database: nothing is
 * asked of GitHub, and nothing is changed.
 */
import type { Queryable } from '../db/database.js';
import { decryptPayload } from '../domain/submissions.js';
import type { SecretBox } from '../lib/crypto.js';
import type { RepoRef } from './tracker.js';

export const PERIODS = [
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: 'all', label: 'All time', days: null },
] as const;
export type PeriodId = (typeof PERIODS)[number]['id'];
export const DEFAULT_PERIOD: PeriodId = '30d';

export function periodOf(id: string | undefined): (typeof PERIODS)[number] {
  return PERIODS.find((p) => p.id === id) ?? PERIODS.find((p) => p.id === DEFAULT_PERIOD)!;
}

export function periodStart(id: PeriodId, now = Date.now()): Date | null {
  const days = periodOf(id).days;
  return days === null ? null : new Date(now - days * 86_400_000);
}

export interface Report {
  /** The ticket (submission) id, for its page. */
  id: string;
  ref: string;
  reporterId: string;
  reporter: string;
  at: Date;
  title: string | null;
  /** The issue this ticket filed. */
  issue: number;
  /** Counted because Claude suggested it's a duplicate, and nobody has reviewed that yet. */
  suggested: boolean;
}

export interface Reported {
  repo: RepoRef;
  number: number;
  title: string;
  url: string;
  /** null when the issue isn't in the issue index (not synced yet, or gone from GitHub). */
  state: 'open' | 'closed' | null;
  stateReason: string | null;
  closedAt: Date | null;
  /** Newest first. */
  reports: Report[];
  confirmed: number;
  suggested: number;
  people: number;
  /** Issues opened directly on GitHub about it in the period (the original, if it was, and its duplicates). */
  github: number;
  /** Reports since it was closed as fixed. */
  afterClosed: number;
  firstAt: Date;
  lastAt: Date;
}

/** "[Bug] [PhotoCraft] Export crashes" → "Export crashes": the type and app prefixes tickets file with. */
const stripPrefix = (title: string) => title.replace(/^(\s*\[[^\]]*\])+\s*/, '').trim();

interface TicketRow {
  id: string;
  ref: string;
  repo_id: number;
  issue_number: number;
  reporter_discord_id: string;
  reporter_display_name: string;
  created_at: Date;
  payload_enc: string | null;
  applied_actions: { kind: string; duplicateOf?: number }[] | null;
  suggestions: { kind: string; duplicateOf?: number }[] | null;
}

/** Every reported issue of these repositories since `since` (all time when null), most reported first. */
export async function mostReported(q: Queryable, box: SecretBox, workspaceId: string, repos: RepoRef[], since: Date | null): Promise<Reported[]> {
  if (!repos.length) return [];
  const ids = repos.map((r) => r.id);
  const byId = new Map(repos.map((r) => [r.id, r]));
  const from = since ?? new Date(0);
  const { rows: tickets } = await q.query<TicketRow>(
    `SELECT s.id, s.ref, s.repo_id, s.issue_number, s.reporter_discord_id, s.reporter_display_name, s.created_at, s.payload_enc, t.applied_actions, t.suggestions
       FROM submissions s LEFT JOIN triage_results t ON t.submission_id = s.id
      WHERE s.workspace_id = $1 AND s.source = 'discord' AND s.status = 'created' AND s.issue_number IS NOT NULL
        AND s.repo_id IN (SELECT value FROM json_each($2)) AND s.created_at >= $3
      ORDER BY s.created_at DESC`,
    [workspaceId, ids, from],
  );
  // "Duplicate of" links, to follow each issue to the one everything else copies.
  const { rows: dups } = await q.query<{ repo_id: number; number: number; duplicate_of: number; created_at: Date }>(
    'SELECT repo_id, number, duplicate_of, created_at FROM issue_index WHERE repo_id IN (SELECT value FROM json_each($1)) AND duplicate_of IS NOT NULL AND gone = 0',
    [ids],
  );
  const key = (repo: number, n: number) => `${repo}:${n}`;
  const dupOf = new Map(dups.map((d) => [key(d.repo_id, d.number), d.duplicate_of]));
  const original = (repo: number, n: number) => {
    const seen = new Set([n]);
    for (let hops = 0; hops < 5; hops++) {
      const next = dupOf.get(key(repo, n));
      if (!next || seen.has(next)) break;
      seen.add(next);
      n = next;
    }
    return n;
  };

  const groups = new Map<string, { repo: number; number: number; reports: Report[]; github: Set<number> }>();
  const group = (repo: number, n: number) => {
    const k = key(repo, n);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { repo, number: n, reports: [], github: new Set() }));
    return g;
  };
  for (const t of tickets) {
    // Spam isn't a report.
    if ((t.applied_actions ?? []).some((a) => a.kind === 'spam')) continue;
    const applied = (t.applied_actions ?? []).find((a) => a.kind === 'duplicate' && a.duplicateOf)?.duplicateOf;
    let target = original(t.repo_id, applied ?? t.issue_number);
    let suggested = false;
    if (target === t.issue_number) {
      const maybe = (t.suggestions ?? []).find((a) => a.kind === 'duplicate' && a.duplicateOf)?.duplicateOf;
      if (maybe && maybe !== t.issue_number) {
        target = original(t.repo_id, maybe);
        suggested = true;
      }
    }
    group(t.repo_id, target).reports.push({
      id: t.id, ref: t.ref, reporterId: t.reporter_discord_id, reporter: t.reporter_display_name, at: t.created_at,
      title: decryptPayload(box, t)?.title ?? null, issue: t.issue_number, suggested,
    });
  }
  if (!groups.size) return [];

  // Issues opened on GitHub (not by a ticket, from any workspace) that copy a reported one.
  const { rows: filed } = await q.query<{ repo_id: number; issue_number: number }>(
    'SELECT DISTINCT repo_id, issue_number FROM submissions WHERE repo_id IN (SELECT value FROM json_each($1)) AND issue_number IS NOT NULL',
    [ids],
  );
  const fromTicket = new Set(filed.map((f) => key(f.repo_id, f.issue_number)));
  for (const d of dups) {
    if (fromTicket.has(key(d.repo_id, d.number)) || d.created_at < from) continue;
    groups.get(key(d.repo_id, original(d.repo_id, d.number)))?.github.add(d.number);
  }

  // The originals' titles and states.
  const out: Reported[] = [];
  for (const repoId of new Set([...groups.values()].map((g) => g.repo))) {
    const repo = byId.get(repoId)!;
    const numbers = [...groups.values()].filter((g) => g.repo === repoId).map((g) => g.number);
    const { rows } = await q.query<{ number: number; title: string; state: 'open' | 'closed'; state_reason: string | null; html_url: string; created_at: Date; closed_at: Date | null; gone: number }>(
      'SELECT number, title, state, state_reason, html_url, created_at, closed_at, gone FROM issue_index WHERE repo_id = $1 AND number IN (SELECT value FROM json_each($2))',
      [repoId, numbers],
    );
    const known = new Map(rows.map((r) => [r.number, r]));
    for (const n of numbers) {
      const g = groups.get(key(repoId, n))!;
      const i = known.get(n);
      const live = i && !i.gone ? i : null;
      if (live && !fromTicket.has(key(repoId, n)) && live.created_at >= from) g.github.add(n);
      const reports = g.reports.sort((a, b) => b.at.getTime() - a.at.getTime());
      const fixedAt = live?.state === 'closed' && (live.state_reason ?? 'completed') === 'completed' ? live.closed_at : null;
      const own = reports.find((r) => r.issue === n);
      out.push({
        repo, number: n,
        title: stripPrefix(live?.title ?? i?.title ?? own?.title ?? '') || `Issue #${n}`,
        url: live?.html_url ?? `https://github.com/${repo.owner}/${repo.name}/issues/${n}`,
        state: live?.state ?? null,
        stateReason: live?.state_reason ?? null,
        closedAt: live?.closed_at ?? null,
        reports,
        confirmed: reports.filter((r) => !r.suggested).length,
        suggested: reports.filter((r) => r.suggested).length,
        people: new Set(reports.map((r) => r.reporterId)).size,
        github: g.github.size,
        afterClosed: fixedAt ? reports.filter((r) => r.at > fixedAt).length : 0,
        firstAt: reports.at(-1)!.at,
        lastAt: reports[0]!.at,
      });
    }
  }
  return out.sort((a, b) => b.reports.length - a.reports.length || b.confirmed - a.confirmed || b.github - a.github || b.lastAt.getTime() - a.lastAt.getTime());
}
