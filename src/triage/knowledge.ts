/**
 * AI triage › Knowledge: each app's TRIAGE.md. Claude writes it from the app's repository and its
 * issues, open and closed (see knowledge-writer.ts), and reads it with every ticket for that app.
 * The team can add notes that Claude never changes. Also the questions Claude asks while
 * triaging, when a fact about the product would have made it surer (its missing_context answer),
 * and the answers it later finds. All of it stays in the console: members never see it, and
 * nothing is written to the repositories.
 */
import type { Queryable } from '../db/database.js';
import type { AppRow } from '../domain/types.js';
import type { AppKnowledgeText } from './prompt.js';

/** Characters of team notes per app (about 2,500 tokens). */
export const KNOWLEDGE_MAX = 10_000;
/** Characters Claude's part may have. */
export const WRITTEN_MAX = 12_000;

/** Questions shown per app on its page. */
const QUESTIONS_SHOWN = 30;

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
  /** What Claude wrote, and when. */
  auto_body: string;
  auto_status: WriteStatus | null;
  auto_at: Date | null;
  auto_requested_at: Date | null;
  auto_error: string | null;
  auto_model: string | null;
  auto_sources: KnowledgeSources | null;
  auto_answers: KnowledgeAnswer[] | null;
  auto_input_tokens: number | null;
  auto_output_tokens: number | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT = `SELECT k.app_id, k.body, k.updated_by, COALESCE(u.display_name, u.username) AS updated_by_name, k.notes_at,
    k.auto_body, k.auto_status, k.auto_at, k.auto_requested_at, k.auto_error, k.auto_model, k.auto_sources, k.auto_answers,
    k.auto_input_tokens, k.auto_output_tokens, k.created_at, k.updated_at
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

/** The app's TRIAGE.md as the triage prompt takes it (Claude's part and the team's notes). */
export function knowledgeTexts(apps: AppRow[], knowledge: Map<string, AppKnowledge>, appIds: (string | null)[]): AppKnowledgeText[] {
  return apps
    .filter((a) => appIds.includes(a.id))
    .map((a) => {
      const k = knowledge.get(a.id);
      return { name: a.name, written: k?.auto_body ?? '', notes: notesOf(k) };
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
        t.submission_id AS submission_id, s.repo_id AS repo_id, s.issue_number AS number, s.repo_name AS repo_name, x.title AS title
      FROM triage_results t JOIN submissions s ON s.id = t.submission_id
      LEFT JOIN issue_index x ON x.repo_id = s.repo_id AND x.number = s.issue_number
      WHERE t.workspace_id = $1 AND t.question IS NOT NULL AND t.status = 'done'${where}
    UNION ALL
    SELECT 'issue', a.id, t.question, t.completed_at, NULL, t.repo_id, t.number, a.repo_name, x.title
      FROM issue_triage t JOIN apps a ON a.workspace_id = t.workspace_id AND a.repo_id = t.repo_id
      LEFT JOIN issue_index x ON x.repo_id = t.repo_id AND x.number = t.number
      WHERE t.workspace_id = $1 AND t.question IS NOT NULL AND t.status = 'done'${where.replace('s.app_id', 'a.id')}`;
}

const keyOf = (question: string) => question.trim().toLowerCase();

/**
 * Where a question stands:
 * - answered: Claude found the answer when it last wrote the TRIAGE.md;
 * - team: Claude looked in the repository and the issues and didn't find it;
 * - waiting: asked since Claude last wrote it, so it hasn't looked yet.
 */
export type QuestionStatus = 'answered' | 'team' | 'waiting';

function statusOf(question: string, k: AppKnowledge | null | undefined): { status: QuestionStatus; answer: string | null } {
  const found = (k?.auto_answers ?? []).find((a) => keyOf(a.question) === keyOf(question));
  if (found?.answer) return { status: 'answered', answer: found.answer };
  return { status: found ? 'team' : 'waiting', answer: null };
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
    if (status === 'waiting' && (!k?.auto_at || r.at > k.auto_at)) c.sinceWritten++;
    out.set(r.app_id, c);
  }
  return out;
}

/** Where a question came from. */
export interface QuestionSource {
  kind: 'ticket' | 'issue';
  submissionId: string | null;
  repoId: number;
  number: number | null;
  repoName: string;
  title: string | null;
  at: Date;
}

/** One question, with every ticket or issue it came up for (the same wording counts once). */
export interface Question {
  text: string;
  /** The last time it was asked. */
  at: Date;
  status: QuestionStatus;
  answer: string | null;
  /** Not answered, and asked since the team last saved its notes. */
  fresh: boolean;
  sources: QuestionSource[];
}

/** The questions about one app: new ones first, then newest first. */
export async function listQuestions(q: Queryable, workspaceId: string, appId: string, k: AppKnowledge | null): Promise<{ questions: Question[]; more: number }> {
  const { rows } = await q.query<{ kind: 'ticket' | 'issue'; question: string; at: Date; submission_id: string | null; repo_id: number; number: number | null; repo_name: string; title: string | null }>(
    `SELECT * FROM (${questionsSql(' AND s.app_id = $2')}) ORDER BY at DESC LIMIT 500`,
    [workspaceId, appId],
  );
  const byText = new Map<string, Question>();
  for (const r of rows) {
    const source: QuestionSource = { kind: r.kind, submissionId: r.submission_id, repoId: r.repo_id, number: r.number, repoName: r.repo_name, title: r.title, at: r.at };
    const seen = byText.get(keyOf(r.question));
    if (seen) seen.sources.push(source);
    else {
      const { status, answer } = statusOf(r.question, k);
      byText.set(keyOf(r.question), { text: r.question.trim(), at: r.at, status, answer, fresh: isFresh(status, r.at, k), sources: [source] });
    }
  }
  const all = [...byText.values()].sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.at.getTime() - a.at.getTime());
  return { questions: all.slice(0, QUESTIONS_SHOWN), more: Math.max(0, all.length - QUESTIONS_SHOWN) };
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
