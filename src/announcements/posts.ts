/**
 * Announcements: messages the team writes in the console and the bot posts in Discord channels.
 * Text, an optional card under it (an embed with a colour), link buttons and a role ping. A draft
 * until it's posted; it keeps each channel's message, so it's changed or deleted everywhere at once.
 */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import { DiscordApiError, DiscordErrorCode } from '../discord/client.js';
import { ComponentType } from '../discord/messages.js';
import { UserFacingError, type Deps } from '../domain/types.js';

export const POST_LIMITS = { content: 2000, title: 256, text: 4000, buttonLabel: 80, buttonUrl: 512 } as const;
export const POST_BUTTONS_MAX = 5;
/** Channels one announcement can go to. */
export const POST_CHANNELS_MAX = 10;

export const CARD_COLORS = {
  blurple: { name: 'Blurple', value: 0x5865f2 },
  green: { name: 'Green', value: 0x57f287 },
  yellow: { name: 'Yellow', value: 0xfee75c },
  red: { name: 'Red', value: 0xed4245 },
  grey: { name: 'Grey', value: 0x99aab5 },
} as const;
export type CardColor = keyof typeof CARD_COLORS;
export const CARD_COLOR_IDS = Object.keys(CARD_COLORS) as CardColor[];

export interface PostButton { label: string; url: string }
/** A channel it's posted in (messageId) or will be (null). */
export interface PostTarget { channelId: string; channelName: string; messageId: string | null }

export interface PostRow {
  id: string;
  workspace_id: string;
  /** Posting: being sent right now. */
  status: 'draft' | 'posting' | 'posted';
  content: string;
  card_title: string | null;
  card_text: string | null;
  card_color: CardColor;
  role_id: string | null;
  role_name: string | null;
  buttons: PostButton[];
  targets: PostTarget[];
  created_by: string | null;
  posted_by: string | null;
  posted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_by_name?: string | null;
  posted_by_name?: string | null;
}

/** What someone wrote, before it's saved. */
export interface PostInput {
  content: string;
  cardTitle: string | null;
  cardText: string | null;
  cardColor: CardColor;
  role: { id: string; name: string } | null;
  buttons: PostButton[];
  /** Ignored once it's posted: it stays in its channels. */
  channels: { id: string; name: string }[];
}

const SELECT = `SELECT p.*, COALESCE(cu.display_name, cu.username) AS created_by_name, COALESCE(pu.display_name, pu.username) AS posted_by_name
  FROM posts p LEFT JOIN users cu ON cu.id = p.created_by LEFT JOIN users pu ON pu.id = p.posted_by`;

export async function listPosts(q: Queryable, workspaceId: string, limit = 200): Promise<PostRow[]> {
  return (await q.query<PostRow>(`${SELECT} WHERE p.workspace_id = $1 ORDER BY COALESCE(p.posted_at, p.updated_at) DESC LIMIT $2`, [workspaceId, limit])).rows;
}

export async function getPost(q: Queryable, workspaceId: string, id: string): Promise<PostRow | null> {
  return (await q.query<PostRow>(`${SELECT} WHERE p.workspace_id = $1 AND p.id = $2`, [workspaceId, id])).rows[0] ?? null;
}

export async function postCounts(q: Queryable, workspaceId: string): Promise<{ drafts: number; posted: number; posted30: number }> {
  const { rows } = await q.query<{ drafts: number; posted: number; posted30: number }>(
    `SELECT sum(status = 'draft') AS drafts, sum(status = 'posted') AS posted, sum(status = 'posted' AND posted_at >= now_ms() - 30 * 86400000) AS posted30
       FROM posts WHERE workspace_id = $1`,
    [workspaceId],
  );
  return { drafts: Number(rows[0]?.drafts ?? 0), posted: Number(rows[0]?.posted ?? 0), posted30: Number(rows[0]?.posted30 ?? 0) };
}

/** Saves what was written (a new draft when `id` is null) and returns its id. */
export async function savePost(q: Queryable, workspaceId: string, userId: string, id: string | null, input: PostInput): Promise<string> {
  const targets = (current: PostTarget[]) => JSON.stringify(input.channels.map((c) => ({ channelId: c.id, channelName: c.name, messageId: current.find((t) => t.channelId === c.id)?.messageId ?? null })));
  const fields = [input.content, input.cardTitle, input.cardText, input.cardColor, input.role?.id ?? null, input.role?.name ?? null, JSON.stringify(input.buttons)];
  if (!id) {
    const newId = randomUUID().replace(/-/g, '');
    await q.query(
      `INSERT INTO posts (id, workspace_id, content, card_title, card_text, card_color, role_id, role_name, buttons, targets, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [newId, workspaceId, ...fields, targets([]), userId],
    );
    return newId;
  }
  const row = await getPost(q, workspaceId, id);
  if (!row) throw new UserFacingError('That announcement no longer exists.');
  await q.query(
    `UPDATE posts SET content = $3, card_title = $4, card_text = $5, card_color = $6, role_id = $7, role_name = $8, buttons = $9, targets = $10, updated_at = now_ms()
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id, ...fields, row.status === 'posted' ? JSON.stringify(row.targets) : targets(row.targets)],
  );
  return id;
}

export async function deleteDraft(q: Queryable, workspaceId: string, id: string): Promise<void> {
  await q.query(`DELETE FROM posts WHERE workspace_id = $1 AND id = $2 AND status = 'draft'`, [workspaceId, id]);
}

/** Whether there's anything to post: text, or a card with a title or text. */
export function hasBody(p: Pick<PostRow, 'content' | 'card_title' | 'card_text'>): boolean {
  return Boolean(p.content.trim() || p.card_title?.trim() || p.card_text?.trim());
}

/** The message as Discord takes it. Only the chosen role can be pinged, never @everyone. */
export function postPayload(p: Pick<PostRow, 'content' | 'card_title' | 'card_text' | 'card_color' | 'role_id' | 'buttons'>): Record<string, unknown> {
  const text = p.content.trim();
  const content = p.role_id ? `<@&${p.role_id}>${text ? `\n${text}` : ''}` : text;
  const card = p.card_title?.trim() || p.card_text?.trim();
  return {
    content,
    embeds: card ? [{ ...(p.card_title?.trim() ? { title: p.card_title.trim() } : {}), ...(p.card_text?.trim() ? { description: p.card_text.trim() } : {}), color: CARD_COLORS[p.card_color]?.value ?? CARD_COLORS.blurple.value }] : [],
    components: p.buttons.length ? [{ type: ComponentType.ActionRow, components: p.buttons.map((b) => ({ type: ComponentType.Button, style: 5, label: b.label, url: b.url })) }] : [],
    allowed_mentions: { parse: [], roles: p.role_id ? [p.role_id] : [] },
  };
}

const gone = (err: unknown) => err instanceof DiscordApiError && (err.code === DiscordErrorCode.UnknownMessage || err.code === DiscordErrorCode.UnknownChannel);
const why = (err: unknown) => (err instanceof DiscordApiError && err.code === DiscordErrorCode.MissingPermissions ? 'the bot is missing permissions there' : err instanceof DiscordApiError && gone(err) ? 'the channel no longer exists' : 'Discord didn’t take it');

/**
 * Posts a draft in its channels (in an announcement channel, also to the servers following it).
 * The ones Discord refuses are named; with none posted it stays a draft.
 */
export async function publishPost(deps: Deps, workspaceId: string, id: string, userId: string): Promise<{ posted: string[]; failed: string[] }> {
  if (!deps.discord) throw new UserFacingError('Discord is not configured on this deployment.');
  // Only one press posts it: the draft is claimed first.
  const claim = await deps.db.query(`UPDATE posts SET status = 'posting', updated_at = now_ms() WHERE workspace_id = $1 AND id = $2 AND status = 'draft'`, [workspaceId, id]);
  if (!claim.rowCount) throw new UserFacingError('It was posted already.');
  const row = (await getPost(deps.db, workspaceId, id))!;
  try {
    if (!hasBody(row)) throw new UserFacingError('Write a message, or a card with a title or text, first.');
    if (!row.targets.length) throw new UserFacingError('Choose at least one channel.');
    const payload = postPayload(row);
    const posted: string[] = [];
    const failed: string[] = [];
    const targets: PostTarget[] = [];
    for (const t of row.targets) {
      try {
        const msg = await deps.discord.createMessage(t.channelId, payload);
        await deps.discord.crosspostMessage(t.channelId, msg.id).catch(() => {});
        targets.push({ ...t, messageId: msg.id });
        posted.push(t.channelName);
      } catch (err) {
        deps.log.warn({ post: id, channel: t.channelId, err: (err as Error).message }, 'announcement post failed');
        failed.push(`#${t.channelName} (${why(err)})`);
      }
    }
    if (!posted.length) throw new UserFacingError(`Not posted: ${failed.join(', ')}.`);
    await deps.db.query(`UPDATE posts SET status = 'posted', targets = $3, posted_by = $4, posted_at = now_ms(), updated_at = now_ms() WHERE workspace_id = $1 AND id = $2`, [workspaceId, id, JSON.stringify(targets), userId]);
    deps.log.info({ post: id, channels: posted.length }, 'announcement posted');
    return { posted, failed };
  } catch (err) {
    await deps.db.query(`UPDATE posts SET status = 'draft' WHERE workspace_id = $1 AND id = $2 AND status = 'posting'`, [workspaceId, id]);
    throw err;
  }
}

/** Edits the posted messages to what it says now (no one is pinged again). Messages deleted in Discord are dropped. */
export async function updatePosted(deps: Deps, row: PostRow): Promise<{ missing: string[] }> {
  if (!deps.discord) throw new UserFacingError('Discord is not configured on this deployment.');
  if (!hasBody(row)) throw new UserFacingError('Write a message, or a card with a title or text, first.');
  const payload = postPayload(row);
  const missing: string[] = [];
  const kept: PostTarget[] = [];
  for (const t of row.targets) {
    if (!t.messageId) continue;
    try {
      await deps.discord.editMessage(t.channelId, t.messageId, payload);
      kept.push(t);
    } catch (err) {
      if (!gone(err)) throw new UserFacingError(`Couldn’t update it in #${t.channelName}: ${why(err)}. Try again in a moment.`);
      missing.push(t.channelName);
    }
  }
  await deps.db.query(`UPDATE posts SET targets = $3, status = $4, updated_at = now_ms() WHERE workspace_id = $1 AND id = $2`,
    [row.workspace_id, row.id, JSON.stringify(kept.length ? kept : row.targets.map((t) => ({ ...t, messageId: null }))), kept.length ? 'posted' : 'draft']);
  return { missing };
}

/** Deletes the posted messages from Discord; it becomes a draft again, with the same channels. */
export async function unpublishPost(deps: Deps, row: PostRow): Promise<void> {
  if (!deps.discord) throw new UserFacingError('Discord is not configured on this deployment.');
  for (const t of row.targets) {
    if (!t.messageId) continue;
    try {
      await deps.discord.deleteMessage(t.channelId, t.messageId);
    } catch (err) {
      if (!gone(err)) throw new UserFacingError(`Couldn’t delete it in #${t.channelName}: ${why(err)}. Try again in a moment.`);
    }
  }
  await deps.db.query(`UPDATE posts SET status = 'draft', targets = $3, posted_by = NULL, posted_at = NULL, updated_at = now_ms() WHERE workspace_id = $1 AND id = $2`,
    [row.workspace_id, row.id, JSON.stringify(row.targets.map((t) => ({ ...t, messageId: null })))]);
}
