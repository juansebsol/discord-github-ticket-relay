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

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const MODES = ['off', 'suggest', 'auto'] as const;
export type Mode = (typeof MODES)[number];
export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const FLAGS = ['duplicate', 'spam', 'needsInfo', 'noAction'] as const;
export type Flag = (typeof FLAGS)[number];
export type ActionKind = 'priority' | Flag;

export const DEFAULT_PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'priority: critical',
  high: 'priority: high',
  medium: 'priority: medium',
  low: 'priority: low',
};
const FLAG_DEFAULTS: Record<Flag, { label: string; close: boolean }> = {
  duplicate: { label: 'duplicate', close: false },
  spam: { label: 'spam', close: false },
  needsInfo: { label: 'needs info', close: false },
  noAction: { label: 'no action needed', close: true },
};

const mode = z.enum(MODES).catch('off');
const labelName = (fallback: string) => z.string().trim().min(1).max(50).catch(fallback);
const flag = (f: Flag) =>
  z.object({ mode, label: labelName(FLAG_DEFAULTS[f].label), close: z.boolean().catch(FLAG_DEFAULTS[f].close) })
    .catch({ mode: 'off', ...FLAG_DEFAULTS[f] });

export const TriageConfigSchema = z.object({
  model: z.string().trim().min(1).max(100).catch(DEFAULT_MODEL),
  /** null = every app, including apps added later. */
  appIds: z.array(z.string()).nullable().catch(null),
  /** null = every ticket type. */
  typeNames: z.array(z.string()).nullable().catch(null),
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
  duplicate: flag('duplicate'),
  spam: flag('spam'),
  needsInfo: flag('needsInfo'),
  noAction: flag('noAction'),
});
export type TriageConfig = z.infer<typeof TriageConfigSchema>;

export function parseTriageConfig(raw: unknown): TriageConfig {
  return TriageConfigSchema.parse(raw && typeof raw === 'object' ? raw : {});
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
  api_key_enc: string | null;
  api_key_hint: string | null;
  added_by_name: string | null;
  api_key_added_at: Date | null;
}

async function row(q: Queryable, workspaceId: string): Promise<Row | null> {
  const { rows } = await q.query<Row>(
    `SELECT t.*, COALESCE(u.display_name, u.username) AS added_by_name FROM triage_settings t
     LEFT JOIN users u ON u.id = t.api_key_added_by WHERE t.workspace_id = $1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

export async function getTriageSettings(q: Queryable, workspaceId: string): Promise<TriageSettings> {
  const r = await row(q, workspaceId);
  return {
    workspaceId,
    enabled: Boolean(r?.enabled),
    enabledAt: r?.enabled_at ?? null,
    config: parseTriageConfig(r?.triage_config),
    paused: r?.paused_reason ? { reason: r.paused_reason, detail: r.paused_detail, at: r.paused_at ?? new Date() } : null,
    key: r?.api_key_enc ? { hint: r.api_key_hint ?? 'sk-ant-…', addedBy: r.added_by_name, addedAt: r.api_key_added_at } : null,
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

/** A short, non-secret reminder of which key is stored. */
export function keyHint(key: string): string {
  return key.startsWith('sk-ant-') ? `sk-ant-…${key.slice(-4)}` : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function looksLikeApiKey(key: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key);
}

/** Stores a new key (encrypted) and resumes triage if it was paused. */
export async function setApiKey(q: Queryable, box: SecretBox, workspaceId: string, key: string, userId: string): Promise<void> {
  await ensureRow(q, workspaceId);
  await q.query(
    `UPDATE triage_settings SET api_key_enc = $2, api_key_hint = $3, api_key_added_by = $4, api_key_added_at = now_ms(),
       paused_reason = NULL, paused_detail = NULL, paused_at = NULL, updated_at = now_ms()
     WHERE workspace_id = $1`,
    [workspaceId, box.encrypt(key), keyHint(key), userId],
  );
}

export async function removeApiKey(q: Queryable, workspaceId: string): Promise<void> {
  await q.query(
    `UPDATE triage_settings SET api_key_enc = NULL, api_key_hint = NULL, api_key_added_by = NULL, api_key_added_at = NULL, updated_at = now_ms()
     WHERE workspace_id = $1`,
    [workspaceId],
  );
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
  const { rows } = await deps.db.query<{ api_key_enc: string | null }>('SELECT api_key_enc FROM triage_settings WHERE workspace_id = $1', [workspaceId]);
  const enc = rows[0]?.api_key_enc;
  if (enc) {
    try {
      return { key: deps.box.decrypt(enc), source: 'workspace' };
    } catch {
      return null;
    }
  }
  return deps.config.anthropicApiKey ? { key: deps.config.anthropicApiKey, source: 'server' } : null;
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
