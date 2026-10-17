/**
 * Per-workspace triage settings and the encrypted Claude API key.
 *
 * The key is stored encrypted (AES-256-GCM via SecretBox) and only a short hint
 * (`sk-ant-…a1b2`) is ever shown again. Settings live in one validated JSON document so
 * new options don't need a migration; every field falls back to its default when missing.
 */
import { z } from 'zod';
import type { Queryable } from '../db/database.js';
import type { SecretBox } from '../lib/crypto.js';
import type { Deps } from '../domain/types.js';
import { getClaudeKey, removeClaudeKey, resolveClaudeKey, setClaudeKey } from '../domain/claude-key.js';

export { keyHint, looksLikeApiKey } from '../domain/claude-key.js';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const MODES = ['off', 'suggest', 'auto'] as const;
export type Mode = (typeof MODES)[number];
export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
/** Display order on the Triage tab. */
export const FLAGS = ['support', 'duplicate', 'regression', 'needsInfo', 'multiple', 'related', 'shared', 'wrongRepo', 'spam', 'noAction'] as const;
export type Flag = (typeof FLAGS)[number];
/** A label group's action: "group:<id>". */
export type GroupKind = `group:${string}`;
export type ActionKind = 'priority' | Flag;
/** Every built-in action, in the column order of the "Rules by ticket type" table (label groups follow). */
export const ACTION_KINDS = ['priority', 'support', 'duplicate', 'regression', 'needsInfo', 'multiple', 'related', 'shared', 'wrongRepo', 'spam', 'noAction'] as const satisfies readonly ActionKind[];
export const ACTION_NAMES: Record<ActionKind, string> = {
  priority: 'Priority',
  support: 'Not a dev issue',
  duplicate: 'Duplicates',
  regression: 'Regression',
  needsInfo: 'Needs info',
  multiple: 'Several problems',
  related: 'Related',
  shared: 'Shared',
  wrongRepo: 'Wrong repo',
  spam: 'Spam',
  noAction: 'No action',
};
/** These never close the issue, so the option isn't offered. */
export const NO_CLOSE: ReadonlySet<Flag> = new Set(['regression', 'related', 'shared', 'wrongRepo']);

export const DEFAULT_PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'priority: critical',
  high: 'priority: high',
  medium: 'priority: medium',
  low: 'priority: low',
};
/** These only comment when they close the issue; the others comment whenever they're applied. */
export const CLOSE_ONLY_COMMENT: ReadonlySet<Flag> = new Set(['spam', 'noAction']);
/** Actions that can also update the member's private confirmation in Discord. */
export const NOTIFIABLE: ReadonlySet<Flag> = new Set(['support', 'duplicate', 'needsInfo', 'multiple']);

export const FLAG_DEFAULTS: Record<Flag, { label: string; close: boolean; comment: string; notifyMember: boolean }> = {
  support: {
    label: 'support',
    close: true,
    comment: 'Thanks for reaching out! This looks like a question about using {app} rather than a bug, so the quickest way to get help is to ask in {help_channel}. If it is a bug after all, open a new ticket with the steps to reproduce it.',
    notifyMember: true,
  },
  duplicate: { label: 'duplicate', close: false, comment: 'Possible duplicate of {duplicate}.', notifyMember: false },
  regression: {
    label: 'regression',
    close: false,
    comment: 'This looks like {regression} coming back: that issue was closed as fixed, but this report says it still happens.',
    notifyMember: false,
  },
  multiple: {
    label: 'multiple issues',
    close: false,
    comment: 'Thanks! This ticket describes several separate problems:\n\n{parts}\n\nIt helps a lot if each one has its own ticket, so they can be tracked and fixed separately.',
    notifyMember: false,
  },
  related: { label: '', close: false, comment: 'Possibly related: {related}.', notifyMember: false },
  shared: { label: 'shared', close: false, comment: 'This looks like a problem shared by several apps: {shared_apps}.', notifyMember: false },
  wrongRepo: {
    label: '',
    close: false,
    comment: 'Thanks! This looks like it belongs to {right_app}, so it should be tracked in {right_repo}. A maintainer will move it there.',
    notifyMember: false,
  },
  needsInfo: {
    label: 'needs info',
    close: false,
    comment: 'Thanks for the report! To look into this, we need {missing}. Please add them in a comment here, or open a new ticket with the details.',
    notifyMember: false,
  },
  spam: { label: 'spam', close: false, comment: 'Closed automatically by Ticket Relay triage as spam. If that’s wrong, reopen this issue.', notifyMember: false },
  noAction: { label: 'no action needed', close: true, comment: 'Closed automatically by Ticket Relay triage as not needing any action. If that’s wrong, reopen this issue.', notifyMember: false },
};

/** What "needs more info" can ask for. Claude picks from this list; it never writes the text. */
export const MISSING_ITEMS = ['steps', 'expected', 'version', 'platform', 'screenshots', 'file', 'use_case'] as const;
export type MissingItem = (typeof MISSING_ITEMS)[number];
/** Short names for the console. */
export const MISSING_SHORT: Record<MissingItem, string> = {
  steps: 'steps to reproduce',
  expected: 'expected vs. actual',
  version: 'app version',
  platform: 'OS or device',
  screenshots: 'screenshot or error',
  file: 'sample file',
  use_case: 'use case',
};
export const MISSING_TEXT: Record<MissingItem, string> = {
  steps: 'the steps to reproduce it',
  expected: 'what you expected to happen and what happened instead',
  version: 'the app version',
  platform: 'your operating system or device',
  screenshots: 'a screenshot or the exact error message',
  file: 'a sample file that shows the problem',
  use_case: 'what problem this would solve for you and how you’d use it',
};

const mode = z.enum(MODES).catch('off');
const labelName = (fallback: string) => z.string().trim().min(1).max(50).catch(fallback);
/** Flag labels may be empty: the action then only comments. */
const optionalLabel = (fallback: string) => z.string().trim().max(50).catch(fallback);
const flag = (f: Flag) =>
  z.object({
    mode,
    label: optionalLabel(FLAG_DEFAULTS[f].label),
    close: z.boolean().catch(FLAG_DEFAULTS[f].close),
    /** Comment template posted on the issue; empty = no comment. */
    comment: z.string().max(1500).catch(FLAG_DEFAULTS[f].comment),
    notifyMember: z.boolean().catch(FLAG_DEFAULTS[f].notifyMember),
  }).catch({ mode: 'off', ...FLAG_DEFAULTS[f] });

// ---- Label groups -------------------------------------------------------------------------

/** A set of labels Claude picks from (for example Type, Area or Platform). It can never invent one. */
export interface LabelGroup {
  id: string;
  name: string;
  instruction: string;
  pick: 'one' | 'two' | 'any';
  mode: Mode;
  options: { label: string; description: string }[];
}

export const MAX_LABEL_GROUPS = 6;
export const MAX_GROUP_OPTIONS = 20;

const LabelGroupSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{4,12}$/),
  name: z.string().trim().min(1).max(40),
  instruction: z.string().max(600).catch(''),
  pick: z.enum(['one', 'two', 'any']).catch('one'),
  mode,
  options: z.array(z.object({ label: z.string().trim().min(1).max(50), description: z.string().max(200).catch('') })).min(1).max(MAX_GROUP_OPTIONS),
});

export const groupKind = (id: string): GroupKind => `group:${id}`;

/** Ready-made groups to start from; every option is editable. */
export const LABEL_GROUP_PRESETS: Record<'type' | 'area' | 'platform', Omit<LabelGroup, 'id' | 'mode'>> = {
  type: {
    name: 'Type',
    instruction: 'What kind of problem or request this is, judged by the text (not the ticket type the member picked).',
    pick: 'one',
    options: [
      { label: 'crash', description: 'The app crashes, freezes or hangs, loses work, or corrupts a file.' },
      { label: 'bug', description: 'Wrong behaviour.' },
      { label: 'perf', description: 'Too slow, or uses too much memory.' },
      { label: 'feature', description: 'A new feature, or behaviour the member expects from a comparable product.' },
      { label: 'question', description: 'A how-to question, or a feature that already exists.' },
      { label: 'i18n', description: 'Translations, language support, right-to-left or non-Latin text in the interface.' },
      { label: 'docs', description: 'Documentation.' },
    ],
  },
  area: {
    name: 'Area',
    instruction: 'The part of the app the ticket is about.',
    pick: 'two',
    options: [
      { label: 'document', description: 'Pages, layers, objects, undo, saving and recovery.' },
      { label: 'tools', description: 'Canvas tools and direct manipulation.' },
      { label: 'text', description: 'Type, fonts, text layout, tables, input methods.' },
      { label: 'color', description: 'Colour management, swatches, CMYK, profiles.' },
      { label: 'render', description: 'Display, GPU, drawing on screen, zoom and scrolling.' },
      { label: 'file', description: 'Import, export, file formats, PDF output and printing.' },
      { label: 'ui', description: 'Panels, dialogs, menus, shortcuts, preferences, themes.' },
      { label: 'a11y', description: 'Accessibility.' },
      { label: 'automation', description: 'Scripting, command line, plug-ins, control interfaces.' },
      { label: 'install', description: 'Installing, updating, launching, packaging.' },
    ],
  },
  platform: {
    name: 'Platform',
    instruction: 'The platforms the problem is limited to. Pick none when it isn’t limited to one or the ticket doesn’t say. An operating system named only in a form answer doesn’t limit the problem unless the text says other systems are fine, or the symptom is clearly specific to it (a macOS menu bar, a Windows installer).',
    pick: 'any',
    options: [
      { label: 'macos', description: 'macOS only.' },
      { label: 'windows', description: 'Windows only.' },
      { label: 'linux', description: 'Linux only.' },
      { label: 'web', description: 'The web version only.' },
    ],
  },
};

/**
 * AI triage › Knowledge, Keep them up to date: how often Claude rewrites each app's TRIAGE.md
 * (days), and after how many new questions about an app it does so sooner (0: never).
 */
export const KNOWLEDGE_EVERY_DAYS = [1, 3, 7, 14, 30] as const;
export const KNOWLEDGE_SOONER = [1, 3, 5, 10, 0] as const;

export const TriageConfigSchema = z.object({
  model: z.string().trim().min(1).max(100).catch(DEFAULT_MODEL),
  /** null = every app, including apps added later. */
  appIds: z.array(z.string()).nullable().catch(null),
  /** Before per-type rules: the ticket types triaged at all (null = every type). Still honoured for old settings. */
  typeNames: z.array(z.string()).nullable().catch(null),
  /** Per ticket type (by id): actions that never run for that type. Types without an entry use the defaults. */
  typeRules: z.record(z.string(), z.object({ off: z.array(z.string()) })).catch({}),
  /** Automatic actions only happen at or above this confidence (percent). */
  threshold: z.number().int().min(50).max(100).catch(90),
  instructions: z.string().max(2000).catch(''),
  monthlyLimit: z.number().int().min(1).max(100_000).catch(500),
  priority: z.object({
    mode,
    labels: z.object({
      critical: labelName(DEFAULT_PRIORITY_LABELS.critical),
      high: labelName(DEFAULT_PRIORITY_LABELS.high),
      medium: labelName(DEFAULT_PRIORITY_LABELS.medium),
      low: labelName(DEFAULT_PRIORITY_LABELS.low),
    }).catch(DEFAULT_PRIORITY_LABELS),
    guide: z.string().max(1500).catch(''),
  }).catch({ mode: 'off', labels: DEFAULT_PRIORITY_LABELS, guide: '' }),
  support: flag('support'),
  duplicate: flag('duplicate'),
  needsInfo: flag('needsInfo'),
  spam: flag('spam'),
  noAction: flag('noAction'),
  regression: flag('regression'),
  multiple: flag('multiple'),
  related: flag('related'),
  shared: flag('shared'),
  wrongRepo: flag('wrongRepo'),
  /** Discord channel for {help_channel} in comments and member notes. */
  helpChannel: z.object({ id: z.string().regex(/^\d{5,25}$/), name: z.string().max(100) }).nullable().catch(null),
  labelGroups: z.array(LabelGroupSchema.nullable().catch(null)).max(MAX_LABEL_GROUPS).catch([]).transform((a) => a.filter((g): g is LabelGroup => g !== null)),
  /** About the products, added to the prompt after the list of apps. */
  products: z.string().max(6000).catch(''),
  /** Admins' wording for a check's definition, replacing the built-in one (by check key). */
  checkRules: z.record(z.string(), z.string().max(2000)).catch({}),
  /** Worked examples for the prompt; null uses the built-in ones, '' none. */
  examples: z.string().max(6000).nullable().catch(null),
  /** Claude also sees the screenshots attached to Discord tickets (more tokens per ticket, so it starts off). */
  screenshots: z.boolean().catch(false),
  /** AI triage › Knowledge: Claude rewrites each app's TRIAGE.md on a schedule. */
  knowledgeAuto: z.boolean().catch(false),
  /** How often, in days (one of KNOWLEDGE_EVERY_DAYS). */
  knowledgeEveryDays: z.number().int().refine((d) => (KNOWLEDGE_EVERY_DAYS as readonly number[]).includes(d)).catch(7),
  /** Sooner once Claude has asked this many new questions about the app (0: never; at most once a day). */
  knowledgeSooner: z.number().int().refine((q) => (KNOWLEDGE_SOONER as readonly number[]).includes(q)).catch(3),
  /**
   * For issues opened directly on GitHub: each action's own mode, by key ('priority', a check,
   * or 'group:<id>'). Separate from the modes for Discord tickets; anything missing is Off.
   */
  githubModes: z.record(z.string(), mode).catch({}),
});
export type TriageConfig = z.infer<typeof TriageConfigSchema>;

export function parseTriageConfig(raw: unknown): TriageConfig {
  return TriageConfigSchema.parse(raw && typeof raw === 'object' ? raw : {});
}

/** Feature requests and ideas aren't support questions, so "Not a development issue" starts off for them. */
export function isFeatureLike(t: { name: string; label?: string | null }): boolean {
  return /feature|enhancement|idea|improvement|suggestion/i.test(`${t.name} ${t.label ?? ''}`);
}

/** Every action key, built-in then label groups (the "Rules by ticket type" columns). */
export function allActionKeys(c: TriageConfig): string[] {
  return [...ACTION_KINDS, ...c.labelGroups.map((g) => groupKind(g.id))];
}

/** Actions that never run for tickets of this type (explicit rule, legacy scope, or the default). */
export function actionsOffFor(c: TriageConfig, type: { id: string; name: string; label?: string | null } | null): Set<string> {
  if (!type) return new Set();
  const rule = c.typeRules[type.id];
  if (rule) return new Set(rule.off);
  if (c.typeNames && !c.typeNames.includes(type.name)) return new Set(allActionKeys(c));
  return new Set<string>(isFeatureLike(type) ? ['support'] : []);
}

/** The settings with the type's switched-off actions forced to Off. */
export function withActionsOff(c: TriageConfig, off: Set<string>): TriageConfig {
  const out = structuredClone(c);
  for (const k of off) {
    if (k === 'priority') out.priority.mode = 'off';
    else if (k.startsWith('group:')) {
      const g = out.labelGroups.find((x) => groupKind(x.id) === k);
      if (g) g.mode = 'off';
    } else if ((FLAGS as readonly string[]).includes(k)) out[k as Flag].mode = 'off';
  }
  return out;
}

export function anyActionOn(c: TriageConfig): boolean {
  return c.priority.mode !== 'off' || FLAGS.some((f) => c[f].mode !== 'off') || c.labelGroups.some((g) => g.mode !== 'off');
}

/** The mode of any action, built-in or label group. */
export function actionMode(c: TriageConfig, key: string): Mode {
  if (key === 'priority') return c.priority.mode;
  if (key.startsWith('group:')) return c.labelGroups.find((g) => groupKind(g.id) === key)?.mode ?? 'off';
  return (FLAGS as readonly string[]).includes(key) ? c[key as Flag].mode : 'off';
}

/** An action's mode for issues opened on GitHub (Off unless set). */
export function githubMode(c: TriageConfig, key: string): Mode {
  return c.githubModes[key] ?? 'off';
}

/** The settings as they apply to issues opened on GitHub: every action takes its GitHub mode. */
export function forGitHub(c: TriageConfig): TriageConfig {
  const out = structuredClone(c);
  out.priority.mode = githubMode(c, 'priority');
  for (const f of FLAGS) {
    out[f].mode = githubMode(c, f);
    // There's no Discord member to tell.
    out[f].notifyMember = false;
  }
  for (const g of out.labelGroups) g.mode = githubMode(c, groupKind(g.id));
  return out;
}

/** Approximate list prices (USD per million tokens, input and output) for cost estimates. */
export const MODEL_PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-fable-5-1': [10, 50],
};

/** What tokens cost with a model, in USD; null for models without a known price. */
export function tokenCost(model: string, input: number, output: number): number | null {
  const p = MODEL_PRICES[model];
  return p ? (input * p[0] + output * p[1]) / 1_000_000 : null;
}

/** "about $0.12", or "under $0.01". */
export function formatCost(usd: number): string {
  return usd < 0.01 ? 'under $0.01' : `about $${usd.toFixed(2)}`;
}

/** The name of any action, built-in or label group. */
export function actionName(c: TriageConfig, key: string): string {
  if (key.startsWith('group:')) return c.labelGroups.find((g) => groupKind(g.id) === key)?.name ?? 'Label group';
  return ACTION_NAMES[key as ActionKind] ?? key;
}

/** Why triage stopped until an admin acts. Filing is never affected. */
export type PauseReason = 'no_key' | 'key_invalid' | 'credits' | 'model_unavailable' | 'rejected';

export function pauseMessage(reason: PauseReason, detail: string | null, model: string): string {
  switch (reason) {
    case 'no_key':
      return 'There’s no Claude API key. Add one in Settings › Claude API to resume.';
    case 'key_invalid':
      return 'Claude rejected the API key. Replace it in Settings › Claude API to resume.';
    case 'credits':
      return 'The Anthropic account behind this key is out of credits. Add credits in the Anthropic Console: triage checks again every 5 minutes and carries on by itself.';
    case 'model_unavailable':
      return `The model ${model} isn’t available to this API key. Choose another model, then resume.`;
    case 'rejected':
      return `Claude rejected the triage request${detail ? `: ${detail}` : '.'} Check the settings, then resume.`;
  }
}

export interface TriageSettings {
  workspaceId: string;
  enabled: boolean;
  enabledAt: Date | null;
  /** Triage of issues opened directly on GitHub (separate switch). */
  githubEnabled: boolean;
  githubEnabledAt: Date | null;
  config: TriageConfig;
  /** checkedAt: when Claude was last tried while paused (see AUTO_CHECK_REASONS). */
  paused: { reason: PauseReason; detail: string | null; at: Date; checkedAt: Date | null } | null;
  key: { hint: string; addedBy: string | null; addedAt: Date | null } | null;
}

interface Row {
  workspace_id: string;
  enabled: boolean;
  enabled_at: Date | null;
  github_enabled: boolean;
  github_enabled_at: Date | null;
  triage_config: unknown;
  paused_reason: PauseReason | null;
  paused_detail: string | null;
  paused_at: Date | null;
  paused_checked_at: Date | null;
}

async function row(q: Queryable, workspaceId: string): Promise<Row | null> {
  const { rows } = await q.query<Row>('SELECT * FROM triage_settings WHERE workspace_id = $1', [workspaceId]);
  return rows[0] ?? null;
}

export async function getTriageSettings(q: Queryable, workspaceId: string): Promise<TriageSettings> {
  const [r, key] = await Promise.all([row(q, workspaceId), getClaudeKey(q, workspaceId)]);
  return {
    workspaceId,
    enabled: Boolean(r?.enabled),
    enabledAt: r?.enabled_at ?? null,
    githubEnabled: Boolean(r?.github_enabled),
    githubEnabledAt: r?.github_enabled_at ?? null,
    config: parseTriageConfig(r?.triage_config),
    paused: r?.paused_reason ? { reason: r.paused_reason, detail: r.paused_detail, at: r.paused_at ?? new Date(), checkedAt: r.paused_checked_at } : null,
    key: key ? { hint: key.hint, addedBy: key.addedBy, addedAt: key.addedAt } : null,
  };
}

async function ensureRow(q: Queryable, workspaceId: string): Promise<void> {
  await q.query('INSERT OR IGNORE INTO triage_settings (workspace_id) VALUES ($1)', [workspaceId]);
}

export async function saveTriageConfig(q: Queryable, workspaceId: string, config: TriageConfig): Promise<void> {
  await ensureRow(q, workspaceId);
  await q.query('UPDATE triage_settings SET triage_config = $2, updated_at = now_ms() WHERE workspace_id = $1', [workspaceId, config]);
}

/** Turning triage on starts from now: tickets filed earlier are never triaged. Turning it on also clears a pause. */
export async function setTriageEnabled(q: Queryable, workspaceId: string, enabled: boolean): Promise<void> {
  await ensureRow(q, workspaceId);
  await q.query(
    `UPDATE triage_settings SET enabled = $2,
       enabled_at = CASE WHEN $2 = 1 AND enabled = 0 THEN now_ms() ELSE enabled_at END,
       paused_reason = CASE WHEN $2 = 1 THEN NULL ELSE paused_reason END,
       paused_detail = CASE WHEN $2 = 1 THEN NULL ELSE paused_detail END,
       updated_at = now_ms()
     WHERE workspace_id = $1`,
    [workspaceId, enabled],
  );
}

/** Triage of issues opened on GitHub starts from now: issues opened earlier are only triaged by a re-run. */
export async function setGitHubTriageEnabled(q: Queryable, workspaceId: string, enabled: boolean): Promise<void> {
  await ensureRow(q, workspaceId);
  await q.query(
    `UPDATE triage_settings SET github_enabled = $2,
       github_enabled_at = CASE WHEN $2 = 1 AND github_enabled = 0 THEN now_ms() ELSE github_enabled_at END,
       updated_at = now_ms()
     WHERE workspace_id = $1`,
    [workspaceId, enabled],
  );
}

/** The workspace's Claude key now lives in Settings (domain/claude-key.ts); these keep older callers working. */
export async function setApiKey(q: Queryable, box: SecretBox, workspaceId: string, key: string, userId: string): Promise<void> {
  await setClaudeKey(q, box, workspaceId, key, userId, null);
}

export async function removeApiKey(q: Queryable, workspaceId: string): Promise<void> {
  await removeClaudeKey(q, workspaceId);
}

/** Pauses triage (keeping the first reason if it's already paused). True if this paused it. */
export async function pauseTriage(q: Queryable, workspaceId: string, reason: PauseReason, detail: string | null): Promise<boolean> {
  const res = await q.query(
    `UPDATE triage_settings SET paused_reason = $2, paused_detail = $3, paused_at = now_ms(), updated_at = now_ms()
     WHERE workspace_id = $1 AND paused_reason IS NULL`,
    [workspaceId, reason, detail ? detail.slice(0, 300) : null],
  );
  return res.rowCount > 0;
}

export async function resumeTriage(q: Queryable, workspaceId: string): Promise<void> {
  await q.query(`UPDATE triage_settings SET paused_reason = NULL, paused_detail = NULL, paused_at = NULL, paused_checked_at = NULL, updated_at = now_ms() WHERE workspace_id = $1`, [workspaceId]);
}

/**
 * Pauses that can end without anyone changing a setting, so triage tries Claude again every
 * few minutes and carries on by itself: an account out of credits works again once credits are
 * added. (A rejected or missing key, or a model the key can't use, needs someone to fix it.)
 */
export const AUTO_CHECK_REASONS: ReadonlySet<PauseReason> = new Set(['credits']);
export const AUTO_CHECK_MS = 5 * 60_000;

/** Whether a pause is checked again by itself. Older pauses saved a credit error as "rejected". */
export function autoChecked(p: Pick<NonNullable<TriageSettings['paused']>, 'reason' | 'detail'>): boolean {
  return AUTO_CHECK_REASONS.has(p.reason) || (p.reason === 'rejected' && /credit balance/i.test(p.detail ?? ''));
}

/** Records a check that found Claude still not working, keeping when the pause started. */
export async function recordPauseCheck(q: Queryable, workspaceId: string, reason: PauseReason, detail: string | null): Promise<void> {
  await q.query(
    `UPDATE triage_settings SET paused_checked_at = now_ms(), paused_reason = $2, paused_detail = $3, updated_at = now_ms()
     WHERE workspace_id = $1 AND paused_reason IS NOT NULL`,
    [workspaceId, reason, detail ? detail.slice(0, 300) : null],
  );
}

/** The workspace's own key, or the deployment's fallback key from ANTHROPIC_API_KEY. */
export async function resolveApiKey(deps: Pick<Deps, 'db' | 'box' | 'config'>, workspaceId: string): Promise<{ key: string; source: 'workspace' | 'server' } | null> {
  return resolveClaudeKey(deps, workspaceId);
}

/** Tickets triaged this calendar month (UTC) and the tokens used, for the limit and the usage line. */
export async function monthlyUsage(q: Queryable, workspaceId: string, now = new Date()): Promise<{ triaged: number; inputTokens: number; outputTokens: number; since: Date }> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // Re-runs (previews included) call Claude too, so they count toward the limit.
  const { rows } = await q.query<{ n: number; input: number | null; output: number | null }>(
    `SELECT count(*) AS n, sum(input_tokens) AS input, sum(output_tokens) AS output FROM (
       SELECT input_tokens, output_tokens FROM triage_results WHERE workspace_id = $1 AND input_tokens IS NOT NULL AND completed_at >= $2
       UNION ALL
       SELECT input_tokens, output_tokens FROM issue_triage WHERE workspace_id = $1 AND input_tokens IS NOT NULL AND completed_at >= $2
       UNION ALL
       SELECT i.input_tokens, i.output_tokens FROM triage_run_items i JOIN triage_runs r ON r.id = i.run_id
       WHERE r.workspace_id = $1 AND i.input_tokens IS NOT NULL AND i.completed_at >= $2
     )`,
    [workspaceId, since],
  );
  return { triaged: rows[0]?.n ?? 0, inputTokens: rows[0]?.input ?? 0, outputTokens: rows[0]?.output ?? 0, since };
}
