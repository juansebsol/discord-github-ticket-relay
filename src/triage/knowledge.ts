/**
 * AI triage › Knowledge: a TRIAGE.md per app that the team writes and Claude reads with every
 * ticket, and the questions Claude asks when a fact about the product would have made it surer
 * (its missing_context answer). Both stay in the console: members never see them, and nothing
 * is written to the repositories.
 */
import type { Queryable } from '../db/database.js';

/** Characters per app (about 2,500 tokens). Every app's TRIAGE.md is in the cached system prompt. */
export const KNOWLEDGE_MAX = 10_000;

/** Questions shown per app on its TRIAGE.md page. */
const QUESTIONS_SHOWN = 30;

/** A starting point: the sections that help Claude most, with nothing in them yet. */
export const KNOWLEDGE_TEMPLATE = [
  '## Known issues',
  '- ',
  '',
  '## Works as intended',
  '- ',
  '',
  '## Versions and platforms',
  '- ',
  '',
  '## Names members use',
  '- ',
].join('\n');

/** The sections, with what goes in each (the editor's guide). */
export const KNOWLEDGE_SECTIONS: { title: string; text: string; example: string }[] = [
  { title: 'Known issues', text: 'Problems you already track, with their issue number and status.', example: 'PNG export of a spread leaves the right page blank on Windows: #412, fixed in 0.9.' },
  { title: 'Works as intended', text: 'Behaviour members report as bugs that isn’t one.', example: 'Fonts installed while the app is open only appear after a restart.' },
  { title: 'Versions and platforms', text: 'The current version and what’s supported.', example: 'Current: 0.9.2. Windows 10+ and macOS 13+. No Linux build.' },
  { title: 'Names members use', text: 'Nicknames and old names for the app and its features.', example: '“PC” is PhotoCraft. “Smart fill” is the old name of Content Fill.' },
  { title: 'Not ours', text: 'What belongs to someone else, and where to send it.', example: 'Licence and refund questions go to the store, not GitHub.' },
];

export interface AppKnowledge {
  app_id: string;
  body: string;
  updated_by: string | null;
  /** Who saved it last, as shown in the console. */
  updated_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT = `SELECT k.app_id, k.body, k.updated_by, COALESCE(u.display_name, u.username) AS updated_by_name, k.created_at, k.updated_at
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
export function cleanKnowledge(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim().slice(0, KNOWLEDGE_MAX);
}

/** A TRIAGE.md that says nothing yet: empty, or the template with nothing filled in. */
export function isBlank(body: string): boolean {
  return !body.split('\n').some((l) => l.trim() && !/^#+\s/.test(l.trim()) && l.trim() !== '-');
}

/**
 * Saves an app's TRIAGE.md. Returns false when nothing changed, so a save without changes
 * doesn't mark Claude's questions as seen.
 */
export async function saveKnowledge(q: Queryable, workspaceId: string, appId: string, body: string, userId: string): Promise<boolean> {
  const text = cleanKnowledge(body);
  const current = await getKnowledge(q, workspaceId, appId);
  if (current ? current.body === text : !text) return false;
  await q.query(
    `INSERT INTO app_knowledge (app_id, workspace_id, body, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (app_id) DO UPDATE SET body = excluded.body, updated_by = excluded.updated_by, updated_at = now_ms()`,
    [appId, workspaceId, text, userId],
  );
  return true;
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

export interface QuestionCount {
  /** Different questions asked about the app. */
  total: number;
  /** Of those, asked since its TRIAGE.md was last saved (all of them when it has none). */
  fresh: number;
}

/** How many questions Claude asked about each app, by app id. */
export async function questionCounts(q: Queryable, workspaceId: string): Promise<Map<string, QuestionCount>> {
  const { rows } = await q.query<{ app_id: string; total: number; fresh: number }>(
    `SELECT x.app_id AS app_id, count(DISTINCT lower(x.question)) AS total,
            count(DISTINCT CASE WHEN k.updated_at IS NULL OR x.at > k.updated_at THEN lower(x.question) END) AS fresh
       FROM (${questionsSql()}) x LEFT JOIN app_knowledge k ON k.app_id = x.app_id
      WHERE x.app_id IS NOT NULL GROUP BY x.app_id`,
    [workspaceId],
  );
  return new Map(rows.map((r) => [r.app_id, { total: Number(r.total), fresh: Number(r.fresh) }]));
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
  /** Asked since the app's TRIAGE.md was last saved. */
  fresh: boolean;
  sources: QuestionSource[];
}

/** The questions about one app, new ones first, then newest first. */
export async function listQuestions(q: Queryable, workspaceId: string, appId: string, since: Date | null): Promise<{ questions: Question[]; more: number }> {
  const { rows } = await q.query<{ kind: 'ticket' | 'issue'; question: string; at: Date; submission_id: string | null; repo_id: number; number: number | null; repo_name: string; title: string | null }>(
    `SELECT * FROM (${questionsSql(' AND s.app_id = $2')}) ORDER BY at DESC LIMIT 500`,
    [workspaceId, appId],
  );
  const byText = new Map<string, Question>();
  for (const r of rows) {
    const key = r.question.trim().toLowerCase();
    const source: QuestionSource = { kind: r.kind, submissionId: r.submission_id, repoId: r.repo_id, number: r.number, repoName: r.repo_name, title: r.title, at: r.at };
    const seen = byText.get(key);
    if (seen) seen.sources.push(source);
    else byText.set(key, { text: r.question.trim(), at: r.at, fresh: !since || r.at > since, sources: [source] });
  }
  const all = [...byText.values()].sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.at.getTime() - a.at.getTime());
  return { questions: all.slice(0, QUESTIONS_SHOWN), more: Math.max(0, all.length - QUESTIONS_SHOWN) };
}
