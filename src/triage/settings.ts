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
export const FLAGS = ['support', 'duplicate', 'needsInfo', 'spam', 'noAction'] as const;
export type Flag = (typeof FLAGS)[number];
export type ActionKind = 'priority' | Flag;
/** Every action, in the column order of the "Rules by ticket type" table. */
export const ACTION_KINDS = ['priority', 'support', 'duplicate', 'needsInfo', 'spam', 'noAction'] as const satisfies readonly ActionKind[];
export const ACTION_NAMES: Record<ActionKind, string> = {
  priority: 'Priority',
  support: 'Not a dev issue',
  duplicate: 'Duplicates',
  needsInfo: 'Needs info',
  spam: 'Spam',
  noAction: 'No action',
};

export const DEFAULT_PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'priority: critical',
  high: 'priority: high',
  medium: 'priority: medium',
  low: 'priority: low',
};
/** These only comment when they close the issue; the others comment whenever they're applied. */
export const CLOSE_ONLY_COMMENT: ReadonlySet<Flag> = new Set(['spam', 'noAction']);
/** Actions that can also update the member's private confirmation in Discord. */
export const NOTIFIABLE: ReadonlySet<Flag> = new Set(['support', 'duplicate', 'needsInfo']);

export const FLAG_DEFAULTS: Record<Flag, { label: string; close: boolean; comment: string; notifyMember: boolean }> = {
  support: {
    label: 'support',
    close: true,
    comment: 'Thanks for reaching out! This looks like a question about using {app} rather than a bug, so the quickest way to get help is to ask in {help_channel}. If it is a bug after all, open a new ticket with the steps to reproduce it.',
    notifyMember: true,
  },
  duplicate: { label: 'duplicate', close: false, comment: 'Possible duplicate of {duplicate}.', notifyMember: false },
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
export const MISSING_ITEMS = ['steps', 'expected', 'version', 'platform', 'screenshots', 'use_case'] as const;
export type MissingItem = (typeof MISSING_ITEMS)[number];
/** Short names for the console. */
export const MISSING_SHORT: Record<MissingItem, string> = {
  steps: 'steps to reproduce',
  expected: 'expected vs. actual',
  version: 'app version',
  platform: 'OS or device',
  screenshots: 'screenshot or error',
  use_case: 'use case',
};
export const MISSING_TEXT: Record<MissingItem, string> = {
  steps: 'the steps to reproduce it',
  expected: 'what you expected to happen and what happened instead',
  version: 'the app version',
  platform: 'your operating system or device',
  screenshots: 'a screenshot or the exact error message',
  use_case: 'what problem this would solve for you and how you’d use it',
};

const mode = z.enum(MODES).catch('off');
const labelName = (fallback: string) => z.string().trim().min(1).max(50).catch(fallback);
const flag = (f: Flag) =>
  z.object({
    mode,
    label: labelName(FLAG_DEFAULTS[f].label),
    close: z.boolean().catch(FLAG_DEFAULTS[f].close),
    /** Comment template posted on the issue; empty = no comment. */
    comment: z.string().max(1500).catch(FLAG_DEFAULTS[f].comment),
    notifyMember: z.boolean().catch(FLAG_DEFAULTS[f].notifyMember),
  }).catch({ mode: 'off', ...FLAG_DEFAULTS[f] });

export const TriageConfigSchema = z.object({
  model: z.string().trim().min(1).max(100).catch(DEFAULT_MODEL),
  /** null = every app, including apps added later. */
  appIds: z.array(z.string()).nullable().catch(null),
  /** Before per-type rules: the ticket types triaged at all (null = every type). Still honoured for old settings. */
  typeNames: z.array(z.string()).nullable().catch(null),
  /** Per ticket type (by id): actions that never run for that type. Types without an entry use the defaults. */
  typeRules: z.record(z.string(), z.object({ off: z.array(z.enum(ACTION_KINDS)) })).catch({}),
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
  /** Discord channel for {help_channel} in comments and member notes. */
  helpChannel: z.object({ id: z.string().regex(/^\d{5,25}$/), name: z.string().max(100) }).nullable().catch(null),
});
export type TriageConfig = z.infer<typeof TriageConfigSchema>;

export function parseTriageConfig(raw: unknown): TriageConfig {
  return TriageConfigSchema.parse(raw && typeof raw === 'object' ? raw : {});
}

/** Feature requests and ideas aren't support questions, so "Not a development issue" starts off for them. */
export function isFeatureLike(t: { name: string; label?: string | null }): boolean {
  return /feature|enhancement|idea|improvement|suggestion/i.test(`${t.name} ${t.label ?? ''}`);
}

/** Actions that never run for tickets of this type (explicit rule, legacy scope, or the default). */
export function actionsOffFor(c: TriageConfig, type: { id: string; name: string; label?: string | null } | null): Set<ActionKind> {
  if (!type) return new Set();
  const rule = c.typeRules[type.id];
  if (rule) return new Set(rule.off);
  if (c.typeNames && !c.typeNames.includes(type.name)) return new Set(ACTION_KINDS);
  return new Set<ActionKind>(isFeatureLike(type) ? ['support'] : []);
}

/** The settings with the type's switched-off actions forced to Off. */
export function withActionsOff(c: TriageConfig, off: Set<ActionKind>): TriageConfig {
  const out = structuredClone(c);
  for (const k of off) {
    if (k === 'priority') out.priority.mode = 'off';
    else out[k].mode = 'off';
  }
  return out;
}

export function anyActionOn(c: TriageConfig): boolean {
  return c.priority.mode !== 'off' || FLAGS.some((f) => c[f].mode !== 'off');
}

/** Why triage stopped until an admin acts. Filing is never affected. */
export type PauseReason = 'no_key' | 'key_invalid' | 'credits' | 'model_unavailable' | 'rejected';

export function pauseMessage(reason: PauseReason, detail: string | null, model: string): string {
  switch (reason) {
    case 'no_key':
      return 'There’s no Claude API key. Add one below to resume.';
    case 'key_invalid':
      return 'Claude rejected the API key. Replace it below to resume.';
    case 'credits':
      return 'The Anthropic account behind this key is out of credits. Add credits in the Anthropic Console, then resume.';
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
  config: TriageConfig;
  paused: { reason: PauseReason; detail: string | null; at: Date } | null;
  key: { hint: string; addedBy: string | null; addedAt: Date | null } | null;
}

interface Row {
  workspace_id: string;
  enabled: boolean;
  enabled_at: Date | null;
  triage_config: unknown;
  paused_reason: PauseReason | null;
  paused_detail: string | null;
  paused_at: Date | null;
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
    config: parseTriageConfig(r?.triage_config),
    paused: r?.paused_reason ? { reason: r.paused_reason, detail: r.paused_detail, at: r.paused_at ?? new Date() } : null,
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

/** The workspace's Claude key now lives in Settings (domain/claude-key.ts); these keep older callers working. */
export async function setApiKey(q: Queryable, box: SecretBox, workspaceId: string, key: string, userId: string): Promise<void> {
  await setClaudeKey(q, box, workspaceId, key, userId, null);
}

export async function removeApiKey(q: Queryable, workspaceId: string): Promise<void> {
  await removeClaudeKey(q, workspaceId);
}

export async function pauseTriage(q: Queryable, workspaceId: string, reason: PauseReason, detail: string | null): Promise<void> {
  await q.query(
    `UPDATE triage_settings SET paused_reason = $2, paused_detail = $3, paused_at = now_ms(), updated_at = now_ms()
     WHERE workspace_id = $1 AND paused_reason IS NULL`,
    [workspaceId, reason, detail ? detail.slice(0, 300) : null],
  );
}

export async function resumeTriage(q: Queryable, workspaceId: string): Promise<void> {
  await q.query(`UPDATE triage_settings SET paused_reason = NULL, paused_detail = NULL, paused_at = NULL, updated_at = now_ms() WHERE workspace_id = $1`, [workspaceId]);
}

/** The workspace's own key, or the deployment's fallback key from ANTHROPIC_API_KEY. */
export async function resolveApiKey(deps: Pick<Deps, 'db' | 'box' | 'config'>, workspaceId: string): Promise<{ key: string; source: 'workspace' | 'server' } | null> {
  return resolveClaudeKey(deps, workspaceId);
}

/** Tickets triaged this calendar month (UTC) and the tokens used, for the limit and the usage line. */
export async function monthlyUsage(q: Queryable, workspaceId: string, now = new Date()): Promise<{ triaged: number; inputTokens: number; outputTokens: number; since: Date }> {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const { rows } = await q.query<{ n: number; input: number | null; output: number | null }>(
    `SELECT count(*) AS n, sum(input_tokens) AS input, sum(output_tokens) AS output FROM triage_results
     WHERE workspace_id = $1 AND input_tokens IS NOT NULL AND completed_at >= $2`,
    [workspaceId, since],
  );
  return { triaged: rows[0]?.n ?? 0, inputTokens: rows[0]?.input ?? 0, outputTokens: rows[0]?.output ?? 0, since };
}
