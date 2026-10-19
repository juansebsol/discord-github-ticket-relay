/**
 * AI triage › Knowledge: each app's TRIAGE.md. Claude writes it from the app's repository and its
 * issues, open and closed (see knowledge-writer.ts), and reads it with every ticket for that app.
 * The team can add notes that Claude never changes. Also the questions Claude asks while
 * triaging, when a fact about the product would have made it surer (its missing_context answer),
 * the answers it later finds, and the team's own answers to them. All of it stays in the console: members never see it, and
 * nothing is written to the repositories.
 */
import type { Queryable } from '../db/database.js';
import type { AppRow } from '../domain/types.js';
import type { AppKnowledgeText } from './prompt.js';

/** Characters of team notes per app (about 2,500 tokens). */
export const KNOWLEDGE_MAX = 10_000;
/** Characters Claude's part may have. */
export const WRITTEN_MAX = 12_000;

/** The team's answers to Claude's questions, per app: each, and all together (about 3,000 tokens). */
export const ANSWER_MAX = 600;
export const TEAM_ANSWERS_MAX = 12_000;

/** What Claude writes, section by section (also shown before it has written anything). */
export const KNOWLEDGE_SECTIONS: { title: string; text: string }[] = [
  { title: 'What it is', text: 'What the app does, its main parts, who uses it.' },
  { title: 'Versions and platforms', text: 'The current version, supported platforms, what’s in beta.' },
  { title: 'Known issues', text: 'Open problems reported more than once, with their issue numbers.' },
  { title: 'Fixed recently', text: 'What the last releases fixed, and in which version.' },
  { title: 'Works as intended or declined', text: 'Reports that aren’t bugs, and requests closed as not planned.' },
  { title: 'Common questions', text: 'How-to and setup questions members ask, with the answer.' },
  { title: 'Names members use', text: 'Nicknames and old names for the app and its features.' },
];

/** What Claude read to write an app's TRIAGE.md. */
export interface KnowledgeSources {
  /** The README's path, when it could be read. */
  readme: string | null;
  /** Other files read (changelog, docs). */
  files: string[];
  releases: number;
  latestRelease: string | null;
  issues: { total: number; open: number; fixed: number; notPlanned: number };
  tickets: number;
  questions: number;
  /** GitHub didn't let the app read the repository's files (no Contents: read). */
  filesBlocked: boolean;
  /** Claude ran out of room before the end; the TRIAGE.md is what it wrote until then. */
  cutOff?: boolean;
}

/** One of Claude's questions from triage, and what it found when it last wrote the TRIAGE.md. */
export interface KnowledgeAnswer {
  question: string;
  /** null: not in the repository or the issues; the team knows. */
  answer: string | null;
}

export type WriteStatus = 'queued' | 'running' | 'done' | 'failed';

export interface AppKnowledge {
  app_id: string;
  /** The team's notes. */
  body: string;
  /** Who saved the team's notes last, and when. */
  updated_by: string | null;
  updated_by_name: string | null;
  notes_at: Date | null;
  /** What Claude wrote, and when (an update with merged changes too). */
  auto_body: string;
  auto_status: WriteStatus | null;
  auto_at: Date | null;
  /** The last full rewrite (new issues and questions count from it). */
  auto_full_at: Date | null;
  /** The last time the schedule looked and found nothing new (the next look is an interval later). */
  auto_checked_at: Date | null;
  auto_requested_at: Date | null;
  auto_error: string | null;
  auto_model: string | null;
  auto_sources: KnowledgeSources | null;
  auto_answers: KnowledgeAnswer[] | null;
  auto_input_tokens: number | null;
  auto_output_tokens: number | null;
  /** The team's answers to Claude's questions. */
  team_answers: TeamAnswer[];
  created_at: Date;
  updated_at: Date;
}

/** One of the team's answers: who wrote it and when (an ISO date). */
export interface TeamAnswer {
  question: string;
  answer: string;
  by: string | null;
  byName: string | null;
  at: string;
}

const SELECT = `SELECT k.app_id, k.body, k.updated_by, COALESCE(u.display_name, u.username) AS updated_by_name, k.notes_at,
    k.auto_body, k.auto_status, k.auto_at, k.auto_full_at, k.auto_checked_at, k.auto_requested_at, k.auto_error, k.auto_model, k.auto_sources, k.auto_answers,
    k.auto_input_tokens, k.auto_output_tokens, k.team_answers, k.created_at, k.updated_at
  FROM app_knowledge k LEFT JOIN users u ON u.id = k.updated_by`;

/** Every app's TRIAGE.md in the workspace, by app id (apps that never had one are missing). */
export async function listKnowledge(q: Queryable, workspaceId: string): Promise<Map<string, AppKnowledge>> {
  const { rows } = await q.query<AppKnowledge>(`${SELECT} WHERE k.workspace_id = $1`, [workspaceId]);
  return new Map(rows.map((r) => [r.app_id, r]));
}

export async function getKnowledge(q: Queryable, workspaceId: string, appId: string): Promise<AppKnowledge | null> {
  const { rows } = await q.query<AppKnowledge>(`${SELECT} WHERE k.workspace_id = $1 AND k.app_id = $2`, [workspaceId, appId]);
  return rows[0] ?? null;
}

/** Line endings and trailing spaces evened out, cut to the limit. */
export function cleanKnowledge(text: string, max = KNOWLEDGE_MAX): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim().slice(0, max);
}

/** Text that says nothing: empty, or only headings and empty bullets. */
export function isBlank(body: string): boolean {
  return !body.split('\n').some((l) => l.trim() && !/^#+\s/.test(l.trim()) && l.trim() !== '-');
}

/** Whether Claude has written the app's TRIAGE.md (an update may be running). */
export function isWritten(k: AppKnowledge | null | undefined): k is AppKnowledge {
  return Boolean(k?.auto_at && k.auto_body.trim());
}

/** The team's notes, when they say something. */
export function notesOf(k: AppKnowledge | null | undefined): string {
  return k && !isBlank(k.body) ? k.body : '';
}

/**
 * Saves the team's notes on an app. Returns false when nothing changed, so a save without
 * changes doesn't mark Claude's questions as seen.
 */
export async function saveKnowledge(q: Queryable, workspaceId: string, appId: string, body: string, userId: string): Promise<boolean> {
  const text = cleanKnowledge(body);
  const current = await getKnowledge(q, workspaceId, appId);
  if (current ? current.body === text : !text) return false;
  await q.query(
    `INSERT INTO app_knowledge (app_id, workspace_id, body, updated_by, notes_at) VALUES ($1, $2, $3, $4, now_ms())
     ON CONFLICT (app_id) DO UPDATE SET body = excluded.body, updated_by = excluded.updated_by, notes_at = now_ms(), updated_at = now_ms()`,
    [appId, workspaceId, text, userId],
  );
  return true;
}

/**
 * The team's answer to a question: saved (it replaces an earlier one), or taken out when empty.
 * Returns an error to show, or null.
 */
export async function saveTeamAnswer(q: Queryable, workspaceId: string, appId: string, question: string, answer: string, user: { id: string; name: string | null }): Promise<string | null> {
  const text = question.trim().slice(0, 400);
  const said = answer.replace(/\r\n?/g, '\n').trim();
  if (!text) return 'That question is gone.';
  if (said.length > ANSWER_MAX) return `An answer can be up to ${ANSWER_MAX} characters.`;
  const current = await getKnowledge(q, workspaceId, appId);
  const others = (current?.team_answers ?? []).filter((a) => keyOf(a.question) !== keyOf(text));
  const next = said ? [{ question: text, answer: said, by: user.id, byName: user.name, at: new Date().toISOString() }, ...others] : others;
  if (next.reduce((n, a) => n + a.question.length + a.answer.length, 0) > TEAM_ANSWERS_MAX) {
    return `Your team’s answers for this app are full (${TEAM_ANSWERS_MAX.toLocaleString('en-US')} characters). Shorten or remove some first.`;
  }
  await q.query(
    `INSERT INTO app_knowledge (app_id, workspace_id, team_answers) VALUES ($1, $2, $3)
     ON CONFLICT (app_id) DO UPDATE SET team_answers = excluded.team_answers, updated_at = now_ms()`,
    [appId, workspaceId, next],
  );
  return null;
}

/** The app's TRIAGE.md as the triage prompt takes it (Claude's part, the team's notes and answers). */
export function knowledgeTexts(apps: AppRow[], knowledge: Map<string, AppKnowledge>, appIds: (string | null)[], changes: Map<string, string[]> = new Map()): AppKnowledgeText[] {
  return apps
    .filter((a) => appIds.includes(a.id))
    .map((a) => {
      const k = knowledge.get(a.id);
      return { name: a.name, written: k?.auto_body ?? '', notes: notesOf(k), answers: (k?.team_answers ?? []).map(({ question, answer }) => ({ question, answer })), changes: changes.get(a.id) ?? [] };
    });
}

/** Rough token count (about four characters each). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w && !/^[#*-]+$/.test(w)).length;
}

/** The section headings in a TRIAGE.md ("## Known issues"), for the overview. */
export function sectionsOf(body: string): string[] {
  return [...body.matchAll(/^#{1,3}\s+(.+?)\s*$/gm)].map((m) => m[1]!).slice(0, 8);
}

// ---- Claude's questions ------------------------------------------------------------------------

/**
 * Every question Claude asked, with the app it's about: a ticket's app, or for an issue opened
 * on GitHub each app of its repository. Only finished results count (a re-queued ticket's old
 * question stays out until it's triaged again).
 */
function questionsSql(where = ''): string {
  return `SELECT 'ticket' AS kind, s.app_id AS app_id, t.question AS question, t.completed_at AS at,
        t.submission_id AS submission_id, s.repo_id AS repo_id, s.issue_number AS number, s.repo_name AS repo_name, x.title AS title,
        s.reporter_display_name AS who, x.excerpt AS excerpt
      FROM triage_results t JOIN submissions s ON s.id = t.submission_id
      LEFT JOIN issue_index x ON x.repo_id = s.repo_id AND x.number = s.issue_number
      WHERE t.workspace_id = $1 AND t.question IS NOT NULL AND t.status = 'done'${where}
    UNION ALL
    SELECT 'issue', a.id, t.question, t.completed_at, NULL, t.repo_id, t.number, a.repo_name, x.title, x.author, x.excerpt
      FROM issue_triage t JOIN apps a ON a.workspace_id = t.workspace_id AND a.repo_id = t.repo_id
      LEFT JOIN issue_index x ON x.repo_id = t.repo_id AND x.number = t.number
      WHERE t.workspace_id = $1 AND t.question IS NOT NULL AND t.status = 'done'${where.replace('s.app_id', 'a.id')}`;
}

const keyOf = (question: string) => question.trim().toLowerCase();

/** A short, stable id for a question: its anchor on the app's page ("q-1x2y3z"). */
export function questionAnchor(question: string): string {
  let h = 5381;
  for (const ch of keyOf(question)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `q-${h.toString(36)}`;
}

/**
 * Where a question stands:
 * - answered: by the team, or by Claude when it last wrote the TRIAGE.md;
 * - team: Claude looked in the repository and the issues and didn't find it;
 * - waiting: asked since Claude last wrote it, so it hasn't looked yet.
 */
export type QuestionStatus = 'answered' | 'team' | 'waiting';

interface StatusOf {
  status: QuestionStatus;
  answer: string | null;
  /** Who answered it (the team's answer wins over Claude's). */
  by: 'team' | 'claude' | null;
  team: TeamAnswer | null;
}

function statusOf(question: string, k: AppKnowledge | null | undefined): StatusOf {
  const team = (k?.team_answers ?? []).find((a) => keyOf(a.question) === keyOf(question)) ?? null;
  if (team) return { status: 'answered', answer: team.answer, by: 'team', team };
  const found = (k?.auto_answers ?? []).find((a) => keyOf(a.question) === keyOf(question));
  if (found?.answer) return { status: 'answered', answer: found.answer, by: 'claude', team: null };
  return { status: found ? 'team' : 'waiting', answer: null, by: null, team: null };
}

/** New to the team: not answered by Claude, and asked since the team last saved its notes. */
function isFresh(status: QuestionStatus, at: Date, k: AppKnowledge | null | undefined): boolean {
  return status !== 'answered' && (!k?.notes_at || at > k.notes_at);
}

export interface QuestionCount {
  /** Different questions asked about the app. */
  total: number;
  /** Not answered, and asked since the team last saved its notes. */
  fresh: number;
  /** Asked since Claude last wrote the TRIAGE.md. */
  sinceWritten: number;
}

/** Each different question per app, with the last time it was asked. */
async function latestQuestions(q: Queryable, workspaceId: string): Promise<{ app_id: string; question: string; at: Date }[]> {
  // SQLite takes the other columns from the row with the max().
  const { rows } = await q.query<{ app_id: string; question: string; at: Date }>(
    `SELECT x.app_id AS app_id, x.question AS question, max(x.at) AS at FROM (${questionsSql()}) x
      WHERE x.app_id IS NOT NULL GROUP BY x.app_id, lower(trim(x.question))`,
    [workspaceId],
  );
  return rows;
}

/** How many questions Claude asked about each app, by app id. */
export async function questionCounts(q: Queryable, workspaceId: string, knowledge?: Map<string, AppKnowledge>): Promise<Map<string, QuestionCount>> {
  const [rows, known] = await Promise.all([latestQuestions(q, workspaceId), knowledge ?? listKnowledge(q, workspaceId)]);
  const out = new Map<string, QuestionCount>();
  for (const r of rows) {
    const k = known.get(r.app_id);
    const c = out.get(r.app_id) ?? { total: 0, fresh: 0, sinceWritten: 0 };
    const { status } = statusOf(r.question, k);
    c.total++;
    if (isFresh(status, r.at, k)) c.fresh++;
    // Questions are looked at in full rewrites (an update with merged changes doesn't).
    const full = k?.auto_full_at ?? k?.auto_at;
    if (status === 'waiting' && (!full || r.at > full)) c.sinceWritten++;
    out.set(r.app_id, c);
  }
  return out;
}

/** Where a question came from: the ticket or issue, who opened it and how it starts. */
export interface QuestionSource {
  kind: 'ticket' | 'issue';
  submissionId: string | null;
  repoId: number;
  number: number | null;
  repoName: string;
  title: string | null;
  who: string | null;
  excerpt: string | null;
  at: Date;
}

/** One question, with every ticket or issue it came up for (the same wording counts once). */
export interface Question {
  text: string;
  /** The last time it was asked. */
  at: Date;
  status: QuestionStatus;
  answer: string | null;
  /** Who answered it, and the team's answer (who, when). */
  by: 'team' | 'claude' | null;
  team: TeamAnswer | null;
  /** Not answered, and asked since the team last saved its notes. */
  fresh: boolean;
  /** Newest first. */
  sources: QuestionSource[];
}

/** Every question about one app, last asked first. */
export async function listQuestions(q: Queryable, workspaceId: string, appId: string, k: AppKnowledge | null): Promise<Question[]> {
  const { rows } = await q.query<{ kind: 'ticket' | 'issue'; question: string; at: Date; submission_id: string | null; repo_id: number; number: number | null; repo_name: string; title: string | null; who: string | null; excerpt: string | null }>(
    `SELECT * FROM (${questionsSql(' AND s.app_id = $2')}) ORDER BY at DESC LIMIT 5000`,
    [workspaceId, appId],
  );
  const byText = new Map<string, Question>();
  for (const r of rows) {
    // A ticket's issue title starts with its [Type] [App]: the ticket's own title is what's after.
    const title = r.kind === 'ticket' && r.title ? r.title.replace(/^(\s*\[[^\]]*\])+\s*/, '') || r.title : r.title;
    const source: QuestionSource = { kind: r.kind, submissionId: r.submission_id, repoId: r.repo_id, number: r.number, repoName: r.repo_name, title, who: r.who, excerpt: r.excerpt || null, at: r.at };
    const seen = byText.get(keyOf(r.question));
    if (seen) seen.sources.push(source);
    else {
      const s = statusOf(r.question, k);
      byText.set(keyOf(r.question), { text: r.question.trim(), at: r.at, ...s, fresh: isFresh(s.status, r.at, k), sources: [source] });
    }
  }
  return [...byText.values()];
}

/** Questions about one app that Claude hasn't answered yet (for the next time it writes), newest first. */
export async function openQuestions(q: Queryable, workspaceId: string, appId: string, k: AppKnowledge | null, limit: number): Promise<string[]> {
  const rows = (await latestQuestions(q, workspaceId)).filter((r) => r.app_id === appId && statusOf(r.question, k).status !== 'answered');
  return rows.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit).map((r) => r.question.trim());
}

/** Questions asked about each app since Claude last wrote its TRIAGE.md (the worker updates sooner after a few). */
export async function questionsSinceWritten(q: Queryable, workspaceId: string, knowledge: Map<string, AppKnowledge>): Promise<Map<string, number>> {
  const counts = await questionCounts(q, workspaceId, knowledge);
  return new Map([...counts].map(([id, c]) => [id, c.sinceWritten]));
}
