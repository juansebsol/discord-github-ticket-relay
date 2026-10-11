import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '../db/pool.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import type { UserRow } from '../domain/types.js';

export const SESSION_COOKIE = 'tr_session';
const SESSION_DAYS = 7;

export interface SessionRow {
  id: string;
  user_id: string;
  csrf_token: string;
  discord_access_token_enc: string | null;
  discord_token_expires_at: Date | null;
  expires_at: Date;
}

export interface AuthContext {
  session: SessionRow;
  user: UserRow;
}

export async function createSession(
  q: Queryable,
  userId: string,
  discordToken: { enc: string; expiresAt: Date } | null,
): Promise<{ token: string; session: SessionRow }> {
  const token = randomToken(32);
  const { rows } = await q.query<SessionRow>(
    `INSERT INTO sessions (id, user_id, csrf_token, discord_access_token_enc, discord_token_expires_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING *`,
    [sha256(token), userId, randomToken(24), discordToken?.enc ?? null, discordToken?.expiresAt ?? null, SESSION_DAYS],
  );
  return { token, session: rows[0]! };
}

export async function loadSession(q: Queryable, token: string | undefined): Promise<AuthContext | null> {
  if (!token || token.length > 100) return null;
  const { rows } = await q.query(
    `SELECT s.id AS s_id, s.user_id, s.csrf_token, s.discord_access_token_enc, s.discord_token_expires_at, s.expires_at,
            u.id, u.discord_user_id, u.username, u.display_name, u.avatar
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    session: {
      id: r.s_id,
      user_id: r.user_id,
      csrf_token: r.csrf_token,
      discord_access_token_enc: r.discord_access_token_enc,
      discord_token_expires_at: r.discord_token_expires_at,
      expires_at: r.expires_at,
    },
    user: { id: r.id, discord_user_id: r.discord_user_id, username: r.username, display_name: r.display_name, avatar: r.avatar },
  };
}

export async function destroySession(q: Queryable, sessionId: string): Promise<void> {
  await q.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_DAYS * 86400 });
}

export function setFlash(reply: FastifyReply, type: 'success' | 'error' | 'info', message: string): void {
  reply.setCookie('tr_flash', Buffer.from(JSON.stringify({ type, message })).toString('base64url'), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60,
  });
}

export function takeFlash(req: FastifyRequest, reply: FastifyReply): { type: string; message: string } | null {
  const raw = req.cookies.tr_flash;
  if (!raw) return null;
  reply.clearCookie('tr_flash', { path: '/' });
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed.message === 'string' && typeof parsed.type === 'string') return { type: parsed.type, message: parsed.message.slice(0, 500) };
  } catch {
    /* ignore malformed flash */
  }
  return null;
}
