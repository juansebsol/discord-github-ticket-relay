/**
 * Moderation's settings: whether it's on, the close reasons (each with the label it adds and the
 * comment it posts on GitHub) and the saved replies. Only admins change them, so everything the
 * app posts on GitHub for a moderator comes from text an admin wrote.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../db/database.js';
import type { CloseReason } from '../github/client.js';

export const REASONS = ['fixed', 'duplicate', 'notPlanned', 'cantReproduce', 'noReply', 'spam'] as const;
export type ReasonKey = (typeof REASONS)[number];

export interface ReasonDef {
  name: string;
  desc: string;
  /** How the issue is closed on GitHub. */
  github: CloseReason;
  label: string;
  comment: string;
}

export const REASON_DEFAULTS: Record<ReasonKey, ReasonDef> = {
  fixed: {
    name: 'Fixed', desc: 'It works now.', github: 'completed', label: '',
    comment: 'This is fixed. Thanks for the report! If it still happens in the latest version, reply here and we’ll reopen it.',
  },
  duplicate: {
    name: 'Duplicate', desc: 'Already reported in another issue.', github: 'duplicate', label: 'duplicate',
    comment: 'Duplicate of {duplicate}. Follow that issue for updates. If this is something different, reply here and we’ll reopen it.',
  },
  notPlanned: {
    name: 'Not planned', desc: 'It won’t be worked on.', github: 'not_planned', label: '',
    comment: 'Thanks for the suggestion. It isn’t something we plan to work on, so we’re closing it.',
  },
  cantReproduce: {
    name: 'Can’t reproduce', desc: 'Nobody could make it happen.', github: 'not_planned', label: '',
    comment: 'We couldn’t reproduce this. If it still happens, reply with the steps and your app version and we’ll take another look.',
  },
  noReply: {
    name: 'No reply', desc: 'More details were asked for and never came.', github: 'not_planned', label: '',
    comment: 'We asked for more details but didn’t hear back, so we’re closing this for now. Reply with them and we’ll reopen it.',
  },
  spam: {
    name: 'Spam', desc: 'Not a real ticket. Its files are removed if your cleanup rules say so.', github: 'not_planned', label: 'spam',
    comment: '',
  },
};

/** What GitHub shows for each way of closing. */
export const GITHUB_CLOSE_NAMES: Record<CloseReason, string> = { completed: 'completed', not_planned: 'not planned', duplicate: 'duplicate' };

export const LIMITS = { label: 50, comment: 2000, replyName: 80, replyText: 2000, replies: 30, note: 300 } as const;

export interface Reason {
  key: ReasonKey;
  on: boolean;
  name: string;
  desc: string;
  github: CloseReason;
  label: string;
  comment: string;
}

export interface SavedReply {
  id: string;
  name: string;
  text: string;
}

export interface ModerationSettings {
  enabled: boolean;
  enabledAt: Date | null;
  reasons: Reason[];
  replies: SavedReply[];
}

const DEFAULT_REPLIES: Omit<SavedReply, 'id'>[] = [
  { name: 'Ask for steps', text: 'Thanks for the report! Could you share the exact steps to make this happen, and which version you’re on? That helps us reproduce it.' },
  { name: 'Ask for a file', text: 'Thanks! Could you attach a file that shows the problem? You can drag it into a reply here.' },
  { name: 'Looking into it', text: 'Thanks for the report, we’re looking into it.' },
];

const ReasonSchema = z.object({
  on: z.boolean().catch(true),
  label: z.string().trim().max(LIMITS.label).catch(''),
  comment: z.string().max(LIMITS.comment).catch(''),
});
const ReplySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(LIMITS.replyName),
  text: z.string().trim().min(1).max(LIMITS.replyText),
});

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readReasons(raw: unknown): Reason[] {
  const stored = (parseJson(raw) ?? {}) as Record<string, unknown>;
  return REASONS.map((key) => {
    const d = REASON_DEFAULTS[key];
    const r = stored && typeof stored === 'object' && stored[key] ? ReasonSchema.safeParse(stored[key]) : null;
    const v = r?.success ? r.data : { on: true, label: d.label, comment: d.comment };
    return { key, name: d.name, desc: d.desc, github: d.github, on: v.on, label: v.label, comment: v.comment };
  });
}

function readReplies(raw: unknown): SavedReply[] {
  const stored = parseJson(raw);
  if (!Array.isArray(stored)) return DEFAULT_REPLIES.map((r, i) => ({ id: `default-${i + 1}`, ...r }));
  return stored.map((r) => ReplySchema.safeParse(r)).filter((r) => r.success).map((r) => r.data).slice(0, LIMITS.replies);
}

export async function getModerationSettings(q: Queryable, workspaceId: string): Promise<ModerationSettings> {
  const { rows } = await q.query<{ enabled: boolean; enabled_at: Date | null; reasons: string; replies: string | null }>(
    'SELECT enabled, enabled_at, reasons, replies FROM moderation_settings WHERE workspace_id = $1',
    [workspaceId],
  );
  const r = rows[0];
  return { enabled: Boolean(r?.enabled), enabledAt: r?.enabled_at ?? null, reasons: readReasons(r?.reasons), replies: readReplies(r?.replies ?? null) };
}

async function ensureRow(q: Queryable, workspaceId: string): Promise<void> {
  await q.query('INSERT INTO moderation_settings (workspace_id) VALUES ($1) ON CONFLICT (workspace_id) DO NOTHING', [workspaceId]);
}

export async function setModerationEnabled(q: Queryable, workspaceId: string, on: boolean, userId: string): Promise<void> {
  await ensureRow(q, workspaceId);
  await q.query(
    'UPDATE moderation_settings SET enabled = $2, enabled_at = CASE WHEN $2 = 1 AND enabled = 0 THEN now_ms() ELSE enabled_at END, updated_by = $3, updated_at = now_ms() WHERE workspace_id = $1',
    [workspaceId, on, userId],
  );
}

/** Saves one reason: on or off, its label and its comment. */
export async function saveReason(q: Queryable, workspaceId: string, key: ReasonKey, v: { on: boolean; label: string; comment: string }, userId: string): Promise<void> {
  const s = await getModerationSettings(q, workspaceId);
  const all = Object.fromEntries(s.reasons.map((r) => [r.key, { on: r.on, label: r.label, comment: r.comment }]));
  all[key] = ReasonSchema.parse(v);
  await ensureRow(q, workspaceId);
  await q.query('UPDATE moderation_settings SET reasons = $2, updated_by = $3, updated_at = now_ms() WHERE workspace_id = $1', [workspaceId, JSON.stringify(all), userId]);
}

export async function saveReplies(q: Queryable, workspaceId: string, replies: SavedReply[], userId: string): Promise<void> {
  await ensureRow(q, workspaceId);
  await q.query('UPDATE moderation_settings SET replies = $2, updated_by = $3, updated_at = now_ms() WHERE workspace_id = $1', [workspaceId, JSON.stringify(replies.slice(0, LIMITS.replies)), userId]);
}

export function newReplyId(): string {
  return randomUUID().slice(0, 12);
}

/** The reasons moderators can pick (the ones turned on). */
export function reasonsOn(s: ModerationSettings): Reason[] {
  return s.reasons.filter((r) => r.on);
}

export function isReason(v: unknown): v is ReasonKey {
  return typeof v === 'string' && (REASONS as readonly string[]).includes(v);
}

/** A comment or reply with its placeholders filled in: {duplicate} is the original ("#1204"), {app} the app's name. */
export function fillTemplate(text: string, v: { duplicate?: number | null; app?: string | null }): string {
  return text
    .replace(/\{duplicate\}/g, v.duplicate ? `#${v.duplicate}` : 'the original issue')
    .replace(/\{app\}/g, v.app ?? 'the app')
    .trim();
}
