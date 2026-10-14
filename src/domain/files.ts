/**
 * Files attached to tickets (screenshots).
 *
 * GitHub has no upload API for apps and Discord's file links expire, so files are kept on
 * this server under a long random ID and the GitHub issue shows them from that link.
 * Safety rules:
 * - Only PNG and JPG images are kept, recognised by their content, never by the name: no
 *   videos, GIFs or anything a browser could run (HTML, SVG, PDF…). A member's files are
 *   limited to 10 MB in total per ticket.
 * - Location and camera data is removed from photos before they are saved.
 * - Member files are copied from Discord as soon as the ticket arrives, before GitHub is
 *   contacted, because Discord's links expire.
 * - Files are stored by ID with our own extension, so names can't reach the file system.
 * - Each workspace has a storage limit, and a minimum of free disk is always kept.
 * - Attaching files never blocks filing: anything that can't be saved is noted instead.
 */
import { mkdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Queryable } from '../db/database.js';
import { AttachmentError } from '../discord/client.js';
import { GitHubApiError } from '../github/client.js';
import { neutralizeGitHubMentions } from '../github/issue-content.js';
import { randomToken, type SecretBox } from '../lib/crypto.js';
import { NetworkError } from '../lib/http.js';
import { getGitHubConnection } from './store.js';
import { addEvent } from './submissions.js';
import type { IncomingFile } from './submissions.js';
import type { Deps, SubmissionRow } from './types.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Everything a member attaches to one ticket. */
export const MAX_TICKET_BYTES = 10 * 1024 * 1024;
const MB = 1024 * 1024;
/** Always leave this much disk free for the database and logs. */
const MIN_FREE_DISK = 1024 * MB;

export type FileStatus = 'pending' | 'stored' | 'failed' | 'deleted';
export type DeleteReason = 'manual' | 'cleanup' | 'spam';

export interface TicketFile {
  id: string;
  workspace_id: string;
  submission_id: string;
  source: 'member' | 'team';
  added_by: string | null;
  filename: string;
  kind: 'image' | null;
  content_type: string | null;
  ext: string | null;
  size: number;
  status: FileStatus;
  source_url_enc: string | null;
  error: string | null;
  delete_reason: DeleteReason | null;
  deleted_by: string | null;
  deleted_at: Date | null;
  stored_at: Date | null;
  created_at: Date;
}

export const FILE_ID = /^[A-Za-z0-9_-]{22}$/;
export const ACCEPTED = 'PNG or JPG';
export const ACCEPT_ATTR = 'image/png,image/jpeg';
/** Extensions Discord's file picker is limited to (it only looks at the name; contents are checked here). */
export const DISCORD_FILE_TYPES = ['.png', '.jpg', '.jpeg'];
export const TOO_LARGE = 'Larger than 10 MB.';
export const OVER_TOTAL = 'Over the 10 MB total for one ticket.';
export const NOT_IMAGE = 'Only PNG or JPG images are accepted.';
export const NO_VIDEOS = 'Videos aren’t accepted. Attach screenshots instead.';

// ---- Recognising files -------------------------------------------------------------------

export interface FileType {
  kind: 'image';
  contentType: string;
  ext: string;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** ISO media brands that are still images (HEIC, AVIF); any other brand is a video. */
const IMAGE_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis']);

/** Recognises a file by its first bytes. Anything else is refused. */
export function sniff(b: Buffer): FileType | null {
  const ascii = (start: number, end: number) => b.toString('latin1', start, end);
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return { kind: 'image', contentType: 'image/png', ext: 'png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', contentType: 'image/jpeg', ext: 'jpg' };
  return null;
}

function isHeic(b: Buffer): boolean {
  return b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && IMAGE_BRANDS.has(b.toString('latin1', 8, 12).trim());
}

/** MP4/MOV (ISO media that isn't a still image) or WebM/MKV, to explain why it was refused. */
function isVideo(b: Buffer): boolean {
  return (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && !isHeic(b)) || (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3);
}

// ---- Removing metadata -------------------------------------------------------------------

/** Removes location, camera and text metadata. Returns the input unchanged if it can't be parsed safely. */
export function stripMetadata(b: Buffer, ext: string): Buffer {
  try {
    if (ext === 'jpg') return stripJpeg(b);
    if (ext === 'png') return stripPng(b);
  } catch {
    return b;
  }
  return b;
}

/** JPEG: drops EXIF/XMP (APP1), IPTC (APP13), other app segments and comments; keeps the orientation. */
function stripJpeg(b: Buffer): Buffer {
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  let orientation = 1;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return b;
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xda || marker === 0xd9) { out.push(b.subarray(i)); i = b.length; break; }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return b;
    const seg = b.subarray(i, i + 2 + len);
    // Keep JFIF (APP0), ICC colour profiles (APP2) and Adobe colour info (APP14).
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep = !isApp ? marker !== 0xfe : marker === 0xe0 || marker === 0xe2 || marker === 0xee;
    if (marker === 0xe1) orientation = exifOrientation(seg) ?? orientation;
    if (keep) out.push(seg);
    i += 2 + len;
  }
  if (i < b.length) return b;
  if (orientation !== 1) {
    const afterJfif = out[1] && out[1][1] === 0xe0 ? 2 : 1;
    out.splice(afterJfif, 0, orientationSegment(orientation));
  }
  return Buffer.concat(out);
}

function exifOrientation(seg: Buffer): number | null {
  const d = seg.subarray(4);
  if (d.toString('latin1', 0, 6) !== 'Exif\0\0') return null;
  const t = d.subarray(6);
  if (t.length < 8) return null;
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return null;
  for (let k = 0, n = u16(ifd); k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** A minimal EXIF segment holding only the orientation, so phone photos still display upright. */
function orientationSegment(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18);
  tiff.writeUInt32BE(0, 22);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** PNG: drops text, EXIF and timestamp chunks. */
function stripPng(b: Buffer): Buffer {
  const drop = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) return b;
    if (!drop.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

// ---- Names, links and sizes --------------------------------------------------------------

/** A display name that is safe everywhere (no paths, control characters or odd symbols). */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.normalize('NFC').replace(/[^\p{L}\p{N} ._()-]+/gu, '_').replace(/\s+/g, ' ').replace(/^[ .]+/, '').trim().slice(0, 100);
  return cleaned || 'file';
}

export function fileUrl(publicUrl: string, f: Pick<TicketFile, 'id' | 'filename'>): string {
  return `${publicUrl}/f/${f.id}/${encodeURIComponent(f.filename).replace(/\(/g, '%28').replace(/\)/g, '%29')}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
  return `${(n / (1024 * MB)).toFixed(1)} GB`;
}

function storedPath(dir: string, f: Pick<TicketFile, 'id' | 'ext'>): string {
  return path.join(dir, `${f.id}.${f.ext}`);
}

export function filePathFor(deps: Pick<Deps, 'config'>, f: Pick<TicketFile, 'id' | 'ext'>): string {
  return storedPath(deps.config.filesDir, f);
}

// ---- Settings ----------------------------------------------------------------------------

export interface FileSettings {
  auto_cleanup: boolean;
  closed_enabled: boolean;
  closed_days: number;
  spam_enabled: boolean;
  age_enabled: boolean;
  age_days: number;
  storage_limit_mb: number;
  last_run_at: Date | null;
  last_run_summary: { files: number; bytes: number; tickets: number } | null;
  last_scan_at: Date | null;
}

const DEFAULT_SETTINGS: FileSettings = {
  auto_cleanup: false,
  closed_enabled: true,
  closed_days: 30,
  spam_enabled: true,
  age_enabled: false,
  age_days: 180,
  storage_limit_mb: 2048,
  last_run_at: null,
  last_run_summary: null,
  last_scan_at: null,
};

export async function getFileSettings(q: Queryable, workspaceId: string): Promise<FileSettings> {
  const { rows } = await q.query<FileSettings>('SELECT * FROM file_settings WHERE workspace_id = $1', [workspaceId]);
  return rows[0] ? { ...DEFAULT_SETTINGS, ...rows[0] } : { ...DEFAULT_SETTINGS };
}

export type FileRules = Pick<FileSettings, 'auto_cleanup' | 'closed_enabled' | 'closed_days' | 'spam_enabled' | 'age_enabled' | 'age_days' | 'storage_limit_mb'>;

export async function saveFileSettings(q: Queryable, workspaceId: string, s: FileRules): Promise<void> {
  await q.query(
    `INSERT INTO file_settings (workspace_id, auto_cleanup, closed_enabled, closed_days, spam_enabled, age_enabled, age_days, storage_limit_mb)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id) DO UPDATE SET auto_cleanup = $2, closed_enabled = $3, closed_days = $4, spam_enabled = $5,
       age_enabled = $6, age_days = $7, storage_limit_mb = $8, updated_at = now_ms()`,
    [workspaceId, s.auto_cleanup, s.closed_enabled, s.closed_days, s.spam_enabled, s.age_enabled, s.age_days, s.storage_limit_mb],
  );
}

export async function storageUsage(q: Queryable, workspaceId: string): Promise<{ files: number; bytes: number; tickets: number }> {
  const { rows } = await q.query<{ files: number; bytes: number; tickets: number }>(
    `SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes, count(DISTINCT submission_id) AS tickets
     FROM ticket_files WHERE workspace_id = $1 AND status = 'stored'`,
    [workspaceId],
  );
  return rows[0]!;
}

// ---- Storing -----------------------------------------------------------------------------

export async function listTicketFiles(q: Queryable, submissionId: string): Promise<TicketFile[]> {
  const { rows } = await q.query<TicketFile>('SELECT * FROM ticket_files WHERE submission_id = $1 ORDER BY created_at, rowid', [submissionId]);
  return rows;
}

/** For the member's confirmation in Discord: how many files were attached, and how many weren't. */
export async function fileCounts(q: Queryable, submissionId: string): Promise<{ stored: number; failed: number } | undefined> {
  const files = await listTicketFiles(q, submissionId);
  if (!files.length) return undefined;
  return { stored: files.filter((f) => f.status !== 'failed').length, failed: files.filter((f) => f.status === 'failed').length };
}

/** Records the files a member attached when the ticket is accepted (downloaded when it's filed). */
export async function recordIncomingFiles(q: Queryable, box: SecretBox, sub: SubmissionRow, files: IncomingFile[]): Promise<void> {
  let total = 0;
  for (const f of files) {
    const type = (f.contentType ?? '').toLowerCase();
    const video = type.startsWith('video/');
    const wrongType = Boolean(type) && !['image/png', 'image/jpeg', 'image/jpg'].includes(type);
    const error = video ? NO_VIDEOS : wrongType ? NOT_IMAGE : f.size > MAX_FILE_BYTES ? TOO_LARGE : total + f.size > MAX_TICKET_BYTES ? OVER_TOTAL : null;
    if (!error) total += Math.max(0, f.size);
    await q.query(
      `INSERT INTO ticket_files (id, workspace_id, submission_id, source, filename, size, status, source_url_enc, error)
       VALUES ($1, $2, $3, 'member', $4, $5, $6, $7, $8)`,
      [randomToken(16), sub.workspace_id, sub.id, cleanFilename(f.filename), Math.max(0, Math.round(f.size)), error ? 'failed' : 'pending', error ? null : box.encrypt(f.url), error],
    );
  }
}

type StoreResult = { ok: true; type: FileType; size: number } | { ok: false; error: string };

async function freeDisk(dir: string): Promise<number> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Checks, cleans and writes one file. */
async function storeBuffer(deps: Pick<Deps, 'db' | 'config'>, f: Pick<TicketFile, 'id' | 'workspace_id'>, data: Buffer): Promise<StoreResult> {
  const type = sniff(data);
  if (!type) return { ok: false, error: isHeic(data) ? 'HEIC photos aren’t supported. Send a screenshot or a JPG instead.' : isVideo(data) ? NO_VIDEOS : NOT_IMAGE };
  if (data.length > MAX_FILE_BYTES) return { ok: false, error: TOO_LARGE };
  const clean = stripMetadata(data, type.ext);
  const [settings, usage] = await Promise.all([getFileSettings(deps.db, f.workspace_id), storageUsage(deps.db, f.workspace_id)]);
  if (usage.bytes + clean.length > settings.storage_limit_mb * MB) return { ok: false, error: 'The storage limit for files is reached.' };
  const dir = deps.config.filesDir;
  await mkdir(dir, { recursive: true, mode: 0o750 });
  if ((await freeDisk(dir)) < MIN_FREE_DISK + clean.length) return { ok: false, error: 'The server is almost out of disk space.' };
  const target = storedPath(dir, { id: f.id, ext: type.ext });
  const tmp = `${target}.${randomToken(6)}.tmp`;
  await writeFile(tmp, clean, { mode: 0o640 });
  await rename(tmp, target);
  return { ok: true, type, size: clean.length };
}

async function saveResult(q: Queryable, id: string, r: StoreResult): Promise<void> {
  if (r.ok) {
    await q.query(
      `UPDATE ticket_files SET status = 'stored', kind = $2, content_type = $3, ext = $4, size = $5, stored_at = now_ms(), source_url_enc = NULL, error = NULL WHERE id = $1`,
      [id, r.type.kind, r.type.contentType, r.type.ext, r.size],
    );
  } else {
    await q.query(`UPDATE ticket_files SET status = 'failed', source_url_enc = NULL, error = $2 WHERE id = $1`, [id, r.error]);
  }
}

/**
 * Copies a ticket's member files from Discord to this server, one at a time (so memory stays
 * small). Runs first when a ticket is filed, before anything involving GitHub. Never throws:
 * failures are recorded per file.
 */
export async function storePendingFiles(deps: Deps, sub: SubmissionRow): Promise<void> {
  const { rows } = await deps.db.query<TicketFile>(`SELECT * FROM ticket_files WHERE submission_id = $1 AND status = 'pending' ORDER BY created_at, rowid`, [sub.id]);
  if (!rows.length) return;
  let stored = 0;
  // The 10 MB total is checked again on the real sizes, which Discord only reported before.
  let used = (await deps.db.query<{ n: number }>(`SELECT coalesce(sum(size), 0) AS n FROM ticket_files WHERE submission_id = $1 AND source = 'member' AND status = 'stored'`, [sub.id])).rows[0]!.n;
  // Stay well inside the filing lease (90s) even if Discord is very slow.
  const deadline = Date.now() + 60_000;
  for (const f of rows) {
    let result: StoreResult;
    try {
      if (!deps.discord || !f.source_url_enc) result = { ok: false, error: 'The file link is no longer available.' };
      else if (Date.now() > deadline) result = { ok: false, error: 'Discord was too slow to download it.' };
      else {
        const data = await deps.discord.downloadAttachment(deps.box.decrypt(f.source_url_enc), MAX_FILE_BYTES);
        result = used + data.length > MAX_TICKET_BYTES ? { ok: false, error: OVER_TOTAL } : await storeBuffer(deps, f, data);
        if (result.ok) used += result.size;
      }
    } catch (err) {
      if (err instanceof AttachmentError) result = { ok: false, error: err.code === 'too_large' ? TOO_LARGE : err.message };
      else if (err instanceof NetworkError) result = { ok: false, error: 'Discord couldn’t be reached to download it.' };
      else {
        deps.log.warn({ submission: sub.ref, err: (err as Error).message }, 'could not store an attached file');
        result = { ok: false, error: 'It couldn’t be saved.' };
      }
    }
    await saveResult(deps.db, f.id, result);
    if (result.ok) stored++;
  }
  await addEvent(deps.db, sub.id, 'files_stored', { stored, failed: rows.length - stored });
}

/** Adds a file from the console (people who can act on tickets). */
export async function addTeamFile(deps: Deps, sub: SubmissionRow, userId: string, filename: string, data: Buffer): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = randomToken(16);
  const name = cleanFilename(filename);
  await deps.db.query(
    `INSERT INTO ticket_files (id, workspace_id, submission_id, source, added_by, filename, size, status) VALUES ($1, $2, $3, 'team', $4, $5, $6, 'pending')`,
    [id, sub.workspace_id, sub.id, userId, name, data.length],
  );
  let result: StoreResult;
  try {
    result = await storeBuffer(deps, { id, workspace_id: sub.workspace_id }, data);
  } catch (err) {
    deps.log.warn({ submission: sub.ref, err: (err as Error).message }, 'could not store an uploaded file');
    result = { ok: false, error: 'It couldn’t be saved.' };
  }
  if (result.ok) {
    await saveResult(deps.db, id, result);
    return { ok: true };
  }
  // A file the team tried to add but couldn't isn't worth keeping a record of.
  await deps.db.query('DELETE FROM ticket_files WHERE id = $1', [id]);
  return { ok: false, error: result.error };
}

// ---- The issue's Attachments section -----------------------------------------------------

export const FILES_START = '<!-- ticket-relay:files -->';
export const FILES_END = '<!-- /ticket-relay:files -->';

function mdText(s: string): string {
  return neutralizeGitHubMentions(s.replace(/([\\`*_{}[\]()#+!|<>~])/g, '\\$1'));
}

/** The Attachments section for the issue body, or null when the ticket has no files to show. */
export function filesBlock(files: TicketFile[], publicUrl: string): string | null {
  const shown = files.filter((f) => f.status !== 'pending');
  if (!shown.length) return null;
  const lines = shown.map((f) => {
    const name = mdText(f.filename);
    if (f.status === 'stored') {
      const url = fileUrl(publicUrl, f);
      return f.kind === 'image' ? `![${name}](${url})` : `[${name}](${url}) (${formatBytes(f.size)})`;
    }
    if (f.status === 'deleted') return `_${name} was removed${f.delete_reason === 'manual' ? ' by a moderator' : ' during cleanup'}._`;
    return `_${name} couldn’t be attached: ${f.error ?? 'it couldn’t be saved.'}_`;
  });
  return [FILES_START, '### Attachments', '', lines.join('\n\n'), FILES_END].join('\n');
}

/** Puts the section in place of the old one, or before the ticket details. */
export function replaceFilesBlock(body: string, block: string): string {
  const start = body.indexOf(FILES_START);
  const end = body.indexOf(FILES_END);
  if (start >= 0 && end > start) return body.slice(0, start) + block + body.slice(end + FILES_END.length);
  const at = body.indexOf('### Ticket details');
  if (at >= 0) return `${body.slice(0, at)}${block}\n\n${body.slice(at)}`;
  return `${body}\n\n${block}`;
}

/** Rewrites the Attachments section of a filed ticket's issue. Only that section changes. */
export async function syncIssueFiles(deps: Deps, sub: SubmissionRow): Promise<void> {
  if (sub.status !== 'created' || !sub.issue_number || !deps.github) return;
  const block = filesBlock(await listTicketFiles(deps.db, sub.id), deps.config.publicUrl);
  if (!block) return;
  const conn = await getGitHubConnection(deps.db, sub.workspace_id);
  const inst = conn?.installation_id ?? sub.installation_id;
  const issue = await deps.github.getIssueDetail(inst, sub.repo_owner, sub.repo_name, sub.issue_number);
  const next = replaceFilesBlock(issue.body, block);
  if (next !== issue.body) await deps.github.updateIssueBody(inst, sub.repo_owner, sub.repo_name, sub.issue_number, next);
}

// ---- Deleting ----------------------------------------------------------------------------

export interface DeleteSummary {
  files: number;
  bytes: number;
  tickets: number;
  /** Tickets whose GitHub issue couldn't be updated (the files are still deleted). */
  issueErrors: number;
}

/** Deletes stored files from disk and records it; then updates each issue's Attachments section. */
export async function deleteFiles(
  deps: Deps,
  workspaceId: string,
  target: { fileIds?: string[]; submissionIds?: string[] },
  userId: string | null,
  reason: DeleteReason,
): Promise<DeleteSummary> {
  const ids = (target.fileIds ?? []).filter((id) => FILE_ID.test(id));
  const subs = (target.submissionIds ?? []).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!ids.length && !subs.length) return { files: 0, bytes: 0, tickets: 0, issueErrors: 0 };
  const { rows } = await deps.db.query<TicketFile>(
    `SELECT * FROM ticket_files WHERE workspace_id = $1 AND status = 'stored'
       AND (id IN (SELECT value FROM json_each($2)) OR submission_id IN (SELECT value FROM json_each($3)))`,
    [workspaceId, JSON.stringify(ids), JSON.stringify(subs)],
  );
  const bySub = new Map<string, TicketFile[]>();
  for (const f of rows) {
    await rm(filePathFor(deps, f), { force: true });
    await deps.db.query(
      `UPDATE ticket_files SET status = 'deleted', deleted_at = now_ms(), deleted_by = $2, delete_reason = $3 WHERE id = $1`,
      [f.id, userId, reason],
    );
    bySub.set(f.submission_id, [...(bySub.get(f.submission_id) ?? []), f]);
  }
  let issueErrors = 0;
  for (const [subId, files] of bySub) {
    await addEvent(deps.db, subId, 'files_deleted', { by: userId, count: files.length, reason });
    const { rows: s } = await deps.db.query<SubmissionRow>('SELECT * FROM submissions WHERE id = $1', [subId]);
    try {
      if (s[0]) await syncIssueFiles(deps, s[0]);
    } catch (err) {
      issueErrors++;
      deps.log.warn({ submission: s[0]?.ref, err: (err as Error).message }, 'could not update the issue after deleting files');
    }
  }
  return { files: rows.length, bytes: rows.reduce((n, f) => n + f.size, 0), tickets: bySub.size, issueErrors };
}

// ---- Cleanup -----------------------------------------------------------------------------

export interface FileTicketRow extends SubmissionRow {
  file_count: number;
  file_bytes: number;
  newest_file_at: Date;
  closed_as_spam: number;
}

export interface CleanupRow {
  sub: FileTicketRow;
  /** Why the cleanup rules would delete this ticket's files, or null. */
  reason: string | null;
}

const DAY = 86_400_000;

function daysAgo(d: Date, now: number): number {
  return Math.max(0, Math.floor((now - d.getTime()) / DAY));
}

/** Why a ticket's files match the cleanup rules, or null. */
export function cleanupReason(s: FileTicketRow, rules: FileRules, now = Date.now()): string | null {
  if (rules.spam_enabled && s.closed_as_spam) return 'Closed as spam';
  if (rules.closed_enabled) {
    if (s.status === 'dismissed' && s.completed_at && now - s.completed_at.getTime() >= rules.closed_days * DAY) return `Closed without filing ${plural(daysAgo(s.completed_at, now), 'day')} ago`;
    if (s.issue_state === 'missing') return 'The issue no longer exists on GitHub';
    if (s.issue_state === 'closed' && s.issue_closed_at && now - s.issue_closed_at.getTime() >= rules.closed_days * DAY) return `Issue closed ${plural(daysAgo(s.issue_closed_at, now), 'day')} ago`;
  }
  if (rules.age_enabled && now - s.newest_file_at.getTime() >= rules.age_days * DAY) return `Files older than ${plural(rules.age_days, 'day')}`;
  return null;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/** Every ticket that has stored files, with whether the rules would clean it up. */
export async function ticketsWithFiles(q: Queryable, workspaceId: string, rules: FileRules): Promise<CleanupRow[]> {
  const { rows } = await q.query<FileTicketRow>(
    `SELECT s.*, count(f.id) AS file_count, sum(f.size) AS file_bytes, max(f.created_at) AS newest_file_at,
       (CASE WHEN (s.status = 'dismissed' AND s.resolution_note LIKE 'Spam%')
          OR EXISTS (SELECT 1 FROM triage_results t, json_each(t.applied_actions) a
                     WHERE t.submission_id = s.id AND json_extract(a.value, '$.kind') = 'spam') THEN 1 ELSE 0 END) AS closed_as_spam
     FROM submissions s JOIN ticket_files f ON f.submission_id = s.id AND f.status = 'stored'
     WHERE s.workspace_id = $1
     GROUP BY s.id
     ORDER BY newest_file_at DESC`,
    [workspaceId],
  );
  const now = Date.now();
  return rows.map((sub) => ({ sub, reason: cleanupReason(sub, rules, now) }));
}

/**
 * Checks on GitHub whether the issues of tickets with files are still open. Tickets checked
 * longest ago go first, so repeated scans cover everything.
 */
export async function refreshIssueStates(deps: Deps, workspaceId: string, limit = 500): Promise<{ checked: number; total: number; errors: number }> {
  const where = `s.workspace_id = $1 AND s.status = 'created' AND s.issue_number IS NOT NULL
    AND EXISTS (SELECT 1 FROM ticket_files f WHERE f.submission_id = s.id AND f.status = 'stored')`;
  const total = (await deps.db.query<{ n: number }>(`SELECT count(*) AS n FROM submissions s WHERE ${where}`, [workspaceId])).rows[0]!.n;
  if (!deps.github || !total) return { checked: 0, total, errors: 0 };
  const { rows } = await deps.db.query<SubmissionRow>(`SELECT s.* FROM submissions s WHERE ${where} ORDER BY s.issue_checked_at NULLS FIRST LIMIT $2`, [workspaceId, limit]);
  const conn = await getGitHubConnection(deps.db, workspaceId);
  let errors = 0;
  let next = 0;
  const work = async () => {
    while (next < rows.length) {
      const s = rows[next++]!;
      let state: { state: 'open' | 'closed' | 'missing'; reason: string | null; closedAt: Date | null };
      try {
        const d = await deps.github!.getIssueDetail(conn?.installation_id ?? s.installation_id, s.repo_owner, s.repo_name, s.issue_number!);
        state = { state: d.state, reason: d.stateReason, closedAt: d.closedAt };
      } catch (err) {
        if (err instanceof GitHubApiError && (err.status === 404 || err.status === 410)) state = { state: 'missing', reason: null, closedAt: null };
        else {
          errors++;
          continue;
        }
      }
      await deps.db.query(
        'UPDATE submissions SET issue_state = $2, issue_state_reason = $3, issue_closed_at = $4, issue_checked_at = now_ms() WHERE id = $1',
        [s.id, state.state, state.reason, state.closedAt],
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, rows.length) }, work));
  return { checked: rows.length - errors, total, errors };
}

export async function markScanned(q: Queryable, workspaceId: string): Promise<void> {
  await q.query(
    `INSERT INTO file_settings (workspace_id, last_scan_at) VALUES ($1, now_ms())
     ON CONFLICT (workspace_id) DO UPDATE SET last_scan_at = now_ms()`,
    [workspaceId],
  );
}

/** Deletes the files of every ticket that matches the rules. */
export async function cleanUpNow(deps: Deps, workspaceId: string, userId: string | null): Promise<DeleteSummary> {
  const rules = await getFileSettings(deps.db, workspaceId);
  const matches = (await ticketsWithFiles(deps.db, workspaceId, rules)).filter((r) => r.reason);
  return deleteFiles(deps, workspaceId, { submissionIds: matches.map((r) => r.sub.id) }, userId, 'cleanup');
}

/**
 * Automatic cleanup, once a day per workspace that turned it on. The daily slot is claimed
 * with one UPDATE, so only one worker process runs it.
 */
export async function runFileCleanup(deps: Deps): Promise<void> {
  const { rows } = await deps.db.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM file_settings WHERE auto_cleanup = 1 AND (last_run_at IS NULL OR last_run_at < now_ms() - 86400000)`,
  );
  for (const { workspace_id: wid } of rows) {
    const claimed = await deps.db.query(
      `UPDATE file_settings SET last_run_at = now_ms() WHERE workspace_id = $1 AND auto_cleanup = 1 AND (last_run_at IS NULL OR last_run_at < now_ms() - 86400000)`,
      [wid],
    );
    if (!claimed.rowCount) continue;
    try {
      await refreshIssueStates(deps, wid);
      const result = await cleanUpNow(deps, wid, null);
      await deps.db.query('UPDATE file_settings SET last_run_summary = $2, last_scan_at = now_ms() WHERE workspace_id = $1', [wid, { files: result.files, bytes: result.bytes, tickets: result.tickets }]);
      if (result.files) deps.log.info({ workspace: wid, files: result.files, bytes: result.bytes }, 'cleaned up ticket files');
    } catch (err) {
      deps.log.error({ workspace: wid, err: (err as Error).message }, 'file cleanup failed');
    }
  }
}

/** Right after a ticket is closed as spam: delete its files if automatic cleanup covers spam. */
export async function cleanUpSpam(deps: Deps, sub: SubmissionRow): Promise<void> {
  const s = await getFileSettings(deps.db, sub.workspace_id);
  if (!s.auto_cleanup || !s.spam_enabled) return;
  await deleteFiles(deps, sub.workspace_id, { submissionIds: [sub.id] }, null, 'spam');
}
