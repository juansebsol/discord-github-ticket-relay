/**
 * Dev mode, for the whole server: while someone deploys (pull, build, restart), process
 * restarts aren't counted on Server health, so a deploy doesn't look like a crash. Turning it
 * off starts counting again from zero.
 */
import type { Queryable } from '../db/database.js';

export interface DevMode {
  on: boolean;
  /** When it was turned on (null while it's off). */
  since: Date | null;
  by: string | null;
  /** When it was last turned off: restarts before this aren't counted. */
  offAt: Date | null;
}

export async function getDevMode(q: Queryable): Promise<DevMode> {
  const { rows } = await q.query<{ dev_mode_on_at: Date | null; dev_mode_by: string | null; dev_mode_off_at: Date | null }>(
    'SELECT dev_mode_on_at, dev_mode_by, dev_mode_off_at FROM server_settings WHERE id = 1',
  );
  const r = rows[0];
  return { on: Boolean(r?.dev_mode_on_at), since: r?.dev_mode_on_at ?? null, by: r?.dev_mode_by ?? null, offAt: r?.dev_mode_off_at ?? null };
}

/** Turns dev mode on (keeping when it started, if it's already on) or off. */
export async function setDevMode(q: Queryable, on: boolean, userId: string): Promise<DevMode> {
  // SQLite evaluates every SET expression against the row as it was, so the CASEs see the old values.
  if (on) {
    await q.query(
      `UPDATE server_settings SET dev_mode_by = CASE WHEN dev_mode_on_at IS NULL THEN $1 ELSE dev_mode_by END,
         dev_mode_on_at = coalesce(dev_mode_on_at, now_ms()), updated_at = now_ms() WHERE id = 1`,
      [userId],
    );
  } else {
    await q.query(
      `UPDATE server_settings SET dev_mode_off_at = CASE WHEN dev_mode_on_at IS NULL THEN dev_mode_off_at ELSE now_ms() END,
         dev_mode_on_at = NULL, updated_at = now_ms() WHERE id = 1`,
    );
  }
  return getDevMode(q);
}
