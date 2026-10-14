import { existsSync, readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as m from '../src/discord/messages.js';
import {
  cleanFilename,
  cleanUpSpam,
  filePathFor,
  filesBlock,
  replaceFilesBlock,
  runFileCleanup,
  saveFileSettings,
  sniff,
  stripMetadata,
  type TicketFile,
} from '../src/domain/files.js';
import { defaultForm, formFor, validateForm, type FormSection } from '../src/domain/forms.js';
import { createTicketType, getTicketType, listTicketTypes, type TicketType } from '../src/domain/ticket-types.js';
import { createInvite, setModeratorPermissions } from '../src/domain/workspaces.js';
import { extractDescription } from '../src/triage/prompt.js';
import { eventually, form, get, makeAdmin, makeApp, makeWorkspace, member, nextInteractionId, resetDb, sendInteraction, testDb, type Admin, type ConfiguredWorkspace, type TestEnv } from './helpers.js';

let env: TestEnv;
let ws: ConfiguredWorkspace;
let bug: TicketType;
let feature: TicketType;
const w = () => `/w/${ws.workspace.id}`;

beforeEach(async () => {
  await resetDb();
  env = await makeApp();
  ws = await makeWorkspace(env);
  await createTicketType(env.db, ws.workspace.id, { name: 'Bug Report', description: null, label: 'bug', title_prefix: null, guidance: null, placeholder: null, enabled: true });
  await createTicketType(env.db, ws.workspace.id, { name: 'Feature Request', description: null, label: 'enhancement', title_prefix: null, guidance: null, placeholder: null, enabled: true });
  [bug, feature] = (await listTicketTypes(env.db, ws.workspace.id)) as [TicketType, TicketType];
});
afterAll(async () => {
  await testDb().end();
});

// ---- Test files ----------------------------------------------------------------------------------

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** A tiny PNG with a text chunk that must not survive. */
function png(secret = 'Author: Casey at home'): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from(`Comment\0${secret}`, 'latin1')),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0xf8, 0x0f, 0x00, 0x01, 0x01, 0x01, 0x00])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A JPEG whose EXIF has an orientation and GPS-looking data. */
function jpeg(): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 * 2 + 4 + 32);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(2, 8);
  tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(6, 18);
  tiff.writeUInt16BE(0x8825, 22); tiff.writeUInt16BE(4, 24); tiff.writeUInt32BE(1, 26); tiff.writeUInt32BE(38, 30);
  tiff.writeUInt32BE(0, 34);
  tiff.write('GPS 52.3702 N 4.8952 E HOME', 38, 'latin1');
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x0c]), Buffer.from('my comment', 'latin1')]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0x56, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, app1, com, sos]);
}

function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

/** An MP4 with the phone's location in moov/udta. */
function mp4(): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2', 'latin1')),
    box('moov', box('mvhd', Buffer.alloc(20)), box('udta', box('\xa9xyz', Buffer.from('+52.3702+004.8952/', 'latin1')))),
    box('mdat', Buffer.alloc(32, 7)),
  ]);
}

function orientationOf(b: Buffer): number | null {
  const at = b.indexOf(Buffer.from('Exif\0\0', 'latin1'));
  if (at < 0) return null;
  const t = b.subarray(at + 6);
  return t.readUInt16BE(t.readUInt32BE(4) + 2 + 8);
}

// ---- Helpers --------------------------------------------------------------------------------------

type Upload = { name: string; body: Buffer; type?: string; size?: number; status?: number };

/** Submits the Bug Report form from Discord with answers and attached files, and waits for filing. */
async function submitBug(o: { os?: string; files?: Upload[]; type?: TicketType; title?: string } = {}) {
  const t = o.type ?? bug;
  const app = ws.apps[0]!;
  const resolved: Record<string, unknown> = {};
  const ids: string[] = [];
  for (const [i, f] of (o.files ?? []).entries()) {
    const id = String(1_400_000_000_000_000_000n + BigInt(i) + BigInt(Math.floor(Math.random() * 1e9)));
    ids.push(id);
    resolved[id] = { id, filename: f.name, size: f.size ?? f.body.length, content_type: f.type ?? 'image/png', url: env.discord.addCdnFile(f.name, f.body, f.type ?? 'image/png', f.status ?? 200) };
  }
  const before = env.github.allIssues().length;
  const res = await sendInteraction(env, {
    id: nextInteractionId(),
    type: 5,
    token: `itoken-files-${Math.random()}`,
    guild_id: ws.guildId,
    channel_id: ws.channelId,
    member: member(),
    data: {
      custom_id: `tr:form:${app.public_id}:${app.repo_id}:${t.public_id}`,
      components: [
        { type: 10, id: 1 },
        { type: 18, id: 2, component: { type: 4, id: 3, custom_id: 'title', value: o.title ?? 'Export crashes on Windows' } },
        { type: 18, id: 4, component: { type: 4, id: 5, custom_id: 'description', value: 'I click export and the app closes right away.' } },
        { type: 18, id: 6, component: { type: 4, id: 7, custom_id: 'q:os', value: o.os ?? 'Windows 11 23H2' } },
        { type: 18, id: 8, component: { type: 19, id: 9, custom_id: 'f:shots', values: ids } },
      ],
      resolved: { attachments: resolved },
    },
  });
  expect(res.json().type).toBe(5);
  await eventually(async () => env.github.allIssues().length > before);
  const sub = await eventually(async () => (await env.db.query(`SELECT * FROM submissions WHERE status = 'created' ORDER BY created_at DESC LIMIT 1`)).rows[0]);
  const files = (await env.db.query<TicketFile>('SELECT * FROM ticket_files WHERE submission_id = $1 ORDER BY created_at, rowid', [sub.id])).rows;
  return { sub, files, issue: () => env.github.allIssues().find((i) => i.number === sub.issue_number)! };
}

function multipart(admin: Admin | null, parts: ({ name: string; value: string } | { name: string; filename: string; type: string; data: Buffer })[]) {
  const boundary = `----trtest${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in p) chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type}\r\n\r\n`), p.data, Buffer.from('\r\n'));
    else chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { headers: { ...(admin ? { cookie: admin.cookie } : {}), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) };
}

async function joinAs(role: 'admin' | 'moderator', name: string, perms?: { canActTickets: boolean; canViewContributors: boolean }): Promise<Admin> {
  const person = await makeAdmin(env, name);
  await env.server.inject({ method: 'POST', url: `/invite/${await createInvite(env.db, ws.workspace.id, ws.owner.user.id, role)}`, ...form(person) });
  if (perms) await setModeratorPermissions(env.db, ws.workspace.id, person.user.id, perms);
  return person;
}

// ---- Forms ----------------------------------------------------------------------------------------

describe('forms per ticket type', () => {
  it('asks bug reports for the OS and screenshots, and leaves other types as they were', () => {
    const modal = m.buildTicketModal({ publicId: 'ABCDEFGHJK', name: 'PhotoCraft', repoId: 1, repoPrivate: false }, { publicId: bug.public_id, name: bug.name, guidance: null, placeholder: null }, formFor(bug));
    expect(modal.components).toHaveLength(5);
    const [intro, title, desc, os, files] = modal.components as any[];
    expect(intro.type).toBe(10);
    expect(intro.content).toMatch(/publicly on GitHub/);
    expect([title.component.custom_id, desc.component.custom_id]).toEqual(['title', 'description']);
    expect(os).toMatchObject({ type: 18, label: 'Operating system and version', component: { type: 4, custom_id: 'q:os', style: 1, required: true } });
    expect(files).toMatchObject({ type: 18, label: 'Screenshots', description: 'Up to 5 PNG or JPG images, 10 MB in total. Hide anything private first.', component: { type: 19, custom_id: 'f:shots', min_values: 0, max_values: 5, required: false, file_types: ['.png', '.jpg', '.jpeg'] } });
    for (const c of modal.components.slice(1) as any[]) {
      expect(c.label.length).toBeLessThanOrEqual(45);
      if (c.description) expect(c.description.length).toBeLessThanOrEqual(100);
    }

    const plain = m.buildTicketModal({ publicId: 'ABCDEFGHJK', name: 'PhotoCraft', repoId: 1, repoPrivate: false }, { publicId: feature.public_id, name: feature.name, guidance: null, placeholder: null }, formFor(feature));
    expect(plain.components.map((c: any) => c.component?.custom_id ?? 'intro')).toEqual(['intro', 'title', 'description']);
  });

  it('rejects forms Discord would refuse or that break filing', () => {
    const base = defaultForm(bug);
    expect(validateForm(base)).toEqual([]);
    const extra: FormSection = { key: 'abcd12', kind: 'short', label: 'App version', hint: '', placeholder: '', text: '', required: false, maxFiles: 5 };
    expect(validateForm([...base, extra]).join(' ')).toMatch(/at most 5 sections/);
    expect(validateForm(base.filter((s) => s.kind !== 'title')).join(' ')).toMatch(/exactly one Title/);
    expect(validateForm([base[1]!, base[0]!, ...base.slice(2)]).join(' ')).toMatch(/intro text must be the first/);
    expect(validateForm([...base.slice(0, 3), { ...extra, label: 'x'.repeat(46) }]).join(' ')).toMatch(/up to 45 characters/);
    expect(validateForm([...base.slice(0, 3), { ...extra, key: '../etc' }]).join(' ')).toMatch(/invalid ID/);
  });

  it('lets admins write their own questions, with a live limit, and restore the default', async () => {
    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/types/${bug.id}/form`, ...get(ws.owner) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('5 of 5 used');
    expect(page.body).toContain('Operating system and version');
    expect(page.body).toContain('id="form-preview"');

    const sections = {
      sec: ['intro', 'title', 'description', 'ver123', 'os'],
      'intro.kind': 'intro', 'intro.text': 'Tell us what broke.',
      'title.kind': 'title', 'title.label': 'Title', 'title.hint': '', 'title.placeholder': '',
      'description.kind': 'description', 'description.label': 'What happened?', 'description.hint': '', 'description.placeholder': '',
      'ver123.kind': 'short', 'ver123.label': 'App version', 'ver123.hint': 'Settings › About', 'ver123.placeholder': 'e.g. 2.4.1', 'ver123.required': '1',
      'os.kind': 'short', 'os.label': 'Operating system', 'os.hint': '', 'os.placeholder': '',
    };
    const tooMany = await env.server.inject({ method: 'POST', url: `${w()}/tickets/types/${bug.id}/form`, ...form(ws.owner, { ...sections, sec: [...sections.sec, 'more12'], 'more12.kind': 'paragraph', 'more12.label': 'Anything else?' }) });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.body).toContain('at most 5 sections');

    const saved = await env.server.inject({ method: 'POST', url: `${w()}/tickets/types/${bug.id}/form`, ...form(ws.owner, sections) });
    expect(saved.statusCode).toBe(302);
    const form1 = formFor(await getTicketType(env.db, ws.workspace.id, bug.id));
    expect(form1.map((s) => s.label || s.kind)).toEqual(['intro', 'Title', 'What happened?', 'App version', 'Operating system']);
    expect(form1[3]).toMatchObject({ kind: 'short', required: true, placeholder: 'e.g. 2.4.1' });

    const list = await env.server.inject({ method: 'GET', url: `${w()}/tickets/types`, ...get(ws.owner) });
    expect(list.body).toContain('2 extra questions');

    await env.server.inject({ method: 'POST', url: `${w()}/tickets/types/${bug.id}/form/reset`, ...form(ws.owner) });
    expect(formFor(await getTicketType(env.db, ws.workspace.id, bug.id)).map((s) => s.key)).toEqual(['intro', 'title', 'description', 'os', 'shots']);

    const mod = await joinAs('moderator', 'mod-forms', { canActTickets: true, canViewContributors: true });
    expect((await env.server.inject({ method: 'GET', url: `${w()}/tickets/types/${bug.id}/form`, ...get(mod) })).statusCode).toBe(403);
    expect((await env.server.inject({ method: 'POST', url: `${w()}/tickets/types/${bug.id}/form`, ...form(mod, sections) })).statusCode).toBe(403);
  });
});

// ---- Files from Discord ------------------------------------------------------------------------------

describe('files members attach in Discord', () => {
  it('files the answers and images in the GitHub issue, served from this server without metadata', async () => {
    const { sub, files, issue } = await submitBug({ files: [{ name: 'shot.png', body: png() }, { name: 'photo.jpg', body: jpeg(), type: 'image/jpeg' }] });
    expect(files.map((f) => [f.status, f.kind, f.ext])).toEqual([['stored', 'image', 'png'], ['stored', 'image', 'jpg']]);
    const body = issue().body;
    expect(body).toMatch(/### Operating system and version\n\nWindows 11 23H2/);
    expect(body).toContain('### Attachments');
    expect(body).toContain(`![shot.png](https://relay.example.test/f/${files[0]!.id}/shot.png)`);
    expect(body.indexOf('### Attachments')).toBeLessThan(body.indexOf('### Ticket details'));

    const served = await env.server.inject({ method: 'GET', url: `/f/${files[0]!.id}/shot.png` });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.rawPayload.includes(Buffer.from('Casey at home'))).toBe(false);
    expect(served.rawPayload.subarray(0, 8).equals(png().subarray(0, 8))).toBe(true);

    const photo = readFileSync(filePathFor(env.deps, files[1]!));
    expect(photo.includes(Buffer.from('GPS 52.3702'))).toBe(false);
    expect(photo.includes(Buffer.from('my comment'))).toBe(false);
    expect(orientationOf(photo)).toBe(6);

    // The answers reach Claude too, and the files are summarized rather than linked.
    const text = extractDescription(body);
    expect(text).toContain('Windows 11 23H2');
    expect(text).toContain('The member attached 2 screenshots.');
    expect(text).not.toContain('/f/');

    const edit = env.discord.interactionEdits.at(-1)!;
    expect(JSON.stringify(edit.payload)).toContain('2 files were attached');
    expect(sub.status).toBe('created');
  });

  it('files the ticket anyway when a file is refused, too large, a video or gone, and says why', async () => {
    const { files, issue } = await submitBug({
      files: [
        { name: 'evil.png', body: Buffer.from('<html><script>alert(1)</script></html>'), type: 'image/png' },
        { name: 'huge.png', body: Buffer.alloc(10), type: 'image/png', size: 11 * 1024 * 1024 },
        { name: 'gone.png', body: png(), status: 404 },
        { name: 'clip.mp4', body: mp4(), type: 'video/mp4' },
        { name: 'sneaky.png', body: mp4(), type: 'image/png' },
      ],
    });
    // The form allows 5 files, so a second ticket brings the other odd formats.
    const more = await submitBug({
      title: 'Other formats',
      files: [
        { name: 'party.gif', body: Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), type: 'image/gif' },
        { name: 'logo.svg', body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), type: 'image/svg+xml' },
        { name: 'photo.webp.png', body: Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'), type: 'image/png' },
      ],
    });
    const all = [...files, ...more.files];
    expect(all.every((f) => f.status === 'failed')).toBe(true);
    expect(all.map((f) => [f.filename, f.error])).toEqual([
      ['evil.png', 'Only PNG or JPG images are accepted.'],
      ['huge.png', 'Larger than 10 MB.'],
      ['gone.png', 'Discord no longer has the file.'],
      ['clip.mp4', 'Videos aren’t accepted. Attach screenshots instead.'],
      ['sneaky.png', 'Videos aren’t accepted. Attach screenshots instead.'],
      ['party.gif', 'Only PNG or JPG images are accepted.'],
      ['logo.svg', 'Only PNG or JPG images are accepted.'],
      ['photo.webp.png', 'Only PNG or JPG images are accepted.'],
    ]);
    // Files refused up front are never downloaded.
    expect(env.discord.cdnRequests.some((p) => /huge\.png|clip\.mp4|party\.gif|logo\.svg/.test(p))).toBe(false);
    expect(issue().body).toContain('_evil.png couldn’t be attached: Only PNG or JPG images are accepted._');
    expect(JSON.stringify(env.discord.interactionEdits.at(-1)!.payload)).toContain('3 files couldn’t be attached. Only PNG or JPG images, 10 MB in total, are accepted.');
  });

  it('keeps a member’s files to 10 MB in total per ticket', async () => {
    // Sizes Discord reports are checked first; the real sizes are checked again when copying.
    const { files } = await submitBug({
      files: [
        { name: 'one.png', body: png(), size: 4 * 1024 * 1024 },
        { name: 'two.png', body: png(), size: 4 * 1024 * 1024 },
        { name: 'three.png', body: png(), size: 4 * 1024 * 1024 },
      ],
    });
    expect(files.map((f) => [f.filename, f.status, f.error])).toEqual([['one.png', 'stored', null], ['two.png', 'stored', null], ['three.png', 'failed', 'Over the 10 MB total for one ticket.']]);
    const big = () => Buffer.concat([png().subarray(0, -12), pngChunk('IDAT', Buffer.alloc(6 * 1024 * 1024)), pngChunk('IEND', Buffer.alloc(0))]);
    const second = await submitBug({ title: 'Lying about sizes', files: [{ name: 'a.png', body: big(), size: 100 }, { name: 'b.png', body: big(), size: 100 }] });
    expect(second.files.map((f) => [f.filename, f.status, f.error])).toEqual([['a.png', 'stored', null], ['b.png', 'failed', 'Over the 10 MB total for one ticket.']]);
  });

  it('copies the files from Discord right away, even while GitHub is down', async () => {
    env.github.tokenFailures.push({ status: 503, message: 'GitHub is down' });
    const app = ws.apps[0]!;
    const id = '1500000000000000001';
    await sendInteraction(env, {
      id: nextInteractionId(), type: 5, token: 'itoken-down', guild_id: ws.guildId, channel_id: ws.channelId, member: member(),
      data: {
        custom_id: `tr:form:${app.public_id}:${app.repo_id}:${bug.public_id}`,
        components: [
          { type: 18, component: { type: 4, custom_id: 'title', value: 'Crash while GitHub is down' } },
          { type: 18, component: { type: 4, custom_id: 'description', value: 'The app closes when I press save.' } },
          { type: 18, component: { type: 19, custom_id: 'f:shots', values: [id] } },
        ],
        resolved: { attachments: { [id]: { id, filename: 'shot.png', size: png().length, content_type: 'image/png', url: env.discord.addCdnFile('shot.png', png()) } } },
      },
    });
    const sub = await eventually(async () => (await env.db.query(`SELECT * FROM submissions WHERE status = 'pending' AND attempts = 0 AND error_code IS NOT NULL`)).rows[0]);
    const files = (await env.db.query<TicketFile>('SELECT * FROM ticket_files WHERE submission_id = $1', [sub.id])).rows;
    expect(files.map((f) => f.status)).toEqual(['stored']);
    expect(existsSync(filePathFor(env.deps, files[0]!))).toBe(true);
    expect(env.github.allIssues()).toHaveLength(0);
  });

  it('stops saving files at the storage limit, and keeps filing', async () => {
    await saveFileSettings(env.db, ws.workspace.id, { auto_cleanup: false, closed_enabled: true, closed_days: 30, spam_enabled: true, age_enabled: false, age_days: 180, storage_limit_mb: 100 });
    const first = await submitBug({ title: 'First' });
    await env.db.query(`INSERT INTO ticket_files (id, workspace_id, submission_id, source, filename, size, status, kind, ext, content_type) VALUES ('AAAAAAAAAAAAAAAAAAAAAA', $1, $2, 'member', 'big.png', $3, 'stored', 'image', 'png', 'image/png')`, [ws.workspace.id, first.sub.id, 100 * 1024 * 1024]);
    const { files, sub } = await submitBug({ title: 'Second', files: [{ name: 'shot.png', body: png() }] });
    expect(sub.status).toBe('created');
    expect(files[0]).toMatchObject({ status: 'failed', error: 'The storage limit for files is reached.' });
  });

  it('accepts uploads only on the ticket upload form, always behind the session token', async () => {
    // Any other form sent as multipart has no readable token and is refused.
    const res = await env.server.inject({ method: 'POST', url: `${w()}/tickets/settings`, ...multipart(ws.owner, [{ name: '_csrf', value: ws.owner.csrf }, { name: 'rate_limit_count', value: '99' }]) });
    expect(res.statusCode).toBe(403);
    const toggle = await env.server.inject({ method: 'POST', url: `${w()}/tickets/types/${bug.id}/toggle`, ...multipart(ws.owner, [{ name: '_csrf', value: ws.owner.csrf }]) });
    expect(toggle.statusCode).toBe(403);
    expect((await getTicketType(env.db, ws.workspace.id, bug.id))!.enabled).toBe(true);
  });

  it('never serves anything but stored files', async () => {
    for (const url of ['/f/..%2F..%2Fetc%2Fpasswd', '/f/AAAAAAAAAAAAAAAAAAAAAA', '/f/short', '/f/AAAAAAAAAAAAAAAAAAAAAA/x.png']) {
      expect((await env.server.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });
});

// ---- Live description ---------------------------------------------------------------------------------

describe('ticket page description', () => {
  it('shows the description and answers live from GitHub, with edits made there', async () => {
    const { sub } = await submitBug({ files: [{ name: 'shot.png', body: png() }] });
    const url = `${w()}/tickets/${sub.id}`;
    // Nothing but the title is stored once the issue exists.
    expect(JSON.stringify(await env.db.query('SELECT payload_enc FROM submissions WHERE id = $1', [sub.id]))).not.toContain('Windows');

    let page = await env.server.inject({ method: 'GET', url, ...get(ws.owner) });
    expect(page.body).toContain('I click export and the app closes right away.');
    expect(page.body).toMatch(/<h3 class="answer-q">Operating system and version<\/h3><p class="ticket-text">Windows 11 23H2<\/p>/);
    expect(page.body).toContain('Shown live from the GitHub issue');
    expect(page.body).not.toContain('### Attachments');
    expect(page.body).toContain('>Open</span>');

    // A maintainer edits the issue and closes it: the page follows.
    const i = env.github.repos.get(ws.repoIds[0]!)!.issues.find((x) => x.number === sub.issue_number)!;
    i.body = i.body.replace('Windows 11 23H2', 'Windows 10 22H2 (corrected by a maintainer)');
    i.state = 'closed';
    i.state_reason = 'not_planned';
    page = await env.server.inject({ method: 'GET', url, ...get(ws.owner) });
    expect(page.body).toContain('Windows 10 22H2 (corrected by a maintainer)');
    expect(page.body).toContain('Closed · not planned');
    expect((await env.db.query('SELECT issue_state FROM submissions WHERE id = $1', [sub.id])).rows[0].issue_state).toBe('closed');

    // Moderators who can only view tickets see it too.
    const viewer = await joinAs('moderator', 'mod-reader');
    expect((await env.server.inject({ method: 'GET', url, ...get(viewer) })).body).toContain('Windows 10 22H2');

    // GitHub unavailable: the page still loads and says so.
    const real = env.deps.github!.getIssueDetail.bind(env.deps.github!);
    env.deps.github!.getIssueDetail = async () => { throw new Error('GitHub is down'); };
    page = await env.server.inject({ method: 'GET', url, ...get(ws.owner) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Couldn’t load the description from GitHub right now.');
    env.deps.github!.getIssueDetail = real;

    // Issue deleted on GitHub.
    const repo = env.github.repos.get(ws.repoIds[0]!)!;
    repo.issues = repo.issues.filter((x) => x.number !== sub.issue_number);
    page = await env.server.inject({ method: 'GET', url, ...get(ws.owner) });
    expect(page.body).toContain('The GitHub issue was deleted');
    expect(page.body).toContain('Deleted on GitHub');
  });
});

// ---- Files from the team -------------------------------------------------------------------------------

describe('files on the ticket page', () => {
  it('lets people who act on tickets add and delete files, which updates the issue', async () => {
    const { sub, issue } = await submitBug({ files: [] });
    const url = `${w()}/tickets/${sub.id}/files`;
    const shot = { name: 'files', filename: 'repro step 1.png', type: 'image/png', data: png() };
    const big = { name: 'files', filename: 'big.png', type: 'image/png', data: Buffer.concat([png(), Buffer.alloc(11 * 1024 * 1024)]) };

    // The token must come first and match.
    const noToken = await env.server.inject({ method: 'POST', url, ...multipart(ws.owner, [shot]) });
    expect(noToken.statusCode).toBe(403);
    const wrong = await env.server.inject({ method: 'POST', url, ...multipart(ws.owner, [{ name: '_csrf', value: 'nope' }, shot]) });
    expect(wrong.statusCode).toBe(403);
    expect((await env.db.query('SELECT count(*) AS n FROM ticket_files WHERE submission_id = $1', [sub.id])).rows[0].n).toBe(0);

    const viewer = await joinAs('moderator', 'mod-view');
    expect((await env.server.inject({ method: 'POST', url, ...multipart(viewer, [{ name: '_csrf', value: viewer.csrf }, shot]) })).statusCode).toBe(403);

    const actor = await joinAs('moderator', 'mod-act', { canActTickets: true, canViewContributors: false });
    const added = await env.server.inject({ method: 'POST', url, ...multipart(actor, [{ name: '_csrf', value: actor.csrf }, shot, { name: 'files', filename: 'notes.txt', type: 'text/plain', data: Buffer.from('hello') }, big, { name: 'files', filename: 'clip.mp4', type: 'video/mp4', data: mp4() }]) });
    expect(added.statusCode).toBe(302);
    const cookie = /tr_flash=([^;]+)/.exec(String(added.headers['set-cookie'] ?? ''))![1]!;
    const flash = Buffer.from(decodeURIComponent(cookie), 'base64url').toString('utf8');
    expect(flash).toContain('big.png: larger than 10 MB.');
    expect(flash).toContain('clip.mp4: Videos aren’t accepted');
    const files = (await env.db.query<TicketFile>('SELECT * FROM ticket_files WHERE submission_id = $1', [sub.id])).rows;
    expect(files.map((f) => [f.filename, f.source, f.status])).toEqual([['repro step 1.png', 'team', 'stored']]);
    expect(issue().body).toContain(`![repro step 1.png](https://relay.example.test/f/${files[0]!.id}/repro%20step%201.png)`);
    expect(issue().bodyEdits).toBe(1);

    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/${sub.id}`, ...get(actor) });
    expect(page.body).toContain('Added by mod-act');
    expect(page.body).toContain(`/f/${files[0]!.id}/`);

    const del = await env.server.inject({ method: 'POST', url: `${w()}/tickets/${sub.id}/files/${files[0]!.id}/delete`, ...form(actor) });
    expect(del.statusCode).toBe(302);
    expect(existsSync(filePathFor(env.deps, files[0]!))).toBe(false);
    expect((await env.server.inject({ method: 'GET', url: `/f/${files[0]!.id}` })).statusCode).toBe(404);
    expect(issue().body).toContain('_repro step 1.png was removed by a moderator._');
    const after = await env.server.inject({ method: 'GET', url: `${w()}/tickets/${sub.id}`, ...get(actor) });
    expect(after.body).toContain('Deleted by mod-act');
    expect(after.body).toContain('mod-act</span> deleted 1 file');
  });
});

// ---- Cleanup ----------------------------------------------------------------------------------------------

describe('cleanup', () => {
  async function closeIssue(num: number, daysAgo: number, reason = 'completed') {
    const i = env.github.allIssues().find((x) => x.number === num)!;
    const real = env.github.repos.get(ws.repoIds[0]!)!.issues.find((x) => x.number === i.number)!;
    real.state = 'closed';
    real.state_reason = reason;
    real.closed_at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  }

  it('scans GitHub, suggests what the rules would delete, and deletes it only when asked', async () => {
    const open = await submitBug({ title: 'Still open', files: [{ name: 'a.png', body: png() }] });
    const closed = await submitBug({ title: 'Closed long ago', files: [{ name: 'b.png', body: png() }, { name: 'c.png', body: png() }] });
    const recent = await submitBug({ title: 'Closed yesterday', files: [{ name: 'd.png', body: png() }] });
    await closeIssue(closed.sub.issue_number, 45);
    await closeIssue(recent.sub.issue_number, 1, 'not_planned');

    const viewer = await joinAs('moderator', 'mod-files', { canActTickets: true, canViewContributors: true });
    expect((await env.server.inject({ method: 'GET', url: `${w()}/tickets/files`, ...get(viewer) })).statusCode).toBe(403);
    expect((await env.server.inject({ method: 'POST', url: `${w()}/tickets/files/delete`, ...form(viewer, { all: 'suggested' }) })).statusCode).toBe(403);

    const before = await env.server.inject({ method: 'GET', url: `${w()}/tickets/files`, ...get(ws.owner) });
    expect(before.body).toContain('Not checked yet');

    const scan = await env.server.inject({ method: 'POST', url: `${w()}/tickets/files/scan`, ...form(ws.owner) });
    expect(scan.statusCode).toBe(302);
    const page = await env.server.inject({ method: 'GET', url: `${w()}/tickets/files?view=suggested`, ...get(ws.owner) });
    expect(page.body).toContain('Closed long ago');
    expect(page.body).toContain('Issue closed 45 days ago');
    expect(page.body).not.toContain('Still open');
    expect(page.body).not.toContain('Closed yesterday');
    const all = await env.server.inject({ method: 'GET', url: `${w()}/tickets/files?view=all`, ...get(ws.owner) });
    expect(all.body).toContain('Closed · not planned');
    expect(all.body).toContain('Still open');

    // Nothing is deleted by the scan.
    expect((await env.db.query(`SELECT count(*) AS n FROM ticket_files WHERE status = 'stored'`)).rows[0].n).toBe(4);

    const del = await env.server.inject({ method: 'POST', url: `${w()}/tickets/files/delete`, ...form(ws.owner, { all: 'suggested' }) });
    expect(del.statusCode).toBe(302);
    const status = async (id: string) => (await env.db.query<TicketFile>('SELECT status, delete_reason FROM ticket_files WHERE submission_id = $1', [id])).rows;
    expect(await status(closed.sub.id)).toEqual([{ status: 'deleted', delete_reason: 'cleanup' }, { status: 'deleted', delete_reason: 'cleanup' }]);
    expect(await status(open.sub.id)).toEqual([{ status: 'stored', delete_reason: null }]);
    expect(closed.issue().body).toContain('_b.png was removed during cleanup._');

    // Selected tickets can be cleaned up by hand too.
    await env.server.inject({ method: 'POST', url: `${w()}/tickets/files/delete`, ...form(ws.owner, { ticket: [recent.sub.id] }) });
    expect(await status(recent.sub.id)).toEqual([{ status: 'deleted', delete_reason: 'cleanup' }]);
  });

  it('runs automatically once a day only when an admin turned it on', async () => {
    const closed = await submitBug({ title: 'Closed', files: [{ name: 'b.png', body: png() }] });
    await closeIssue(closed.sub.issue_number, 40);
    await runFileCleanup(env.deps);
    expect((await env.db.query(`SELECT status FROM ticket_files WHERE submission_id = $1`, [closed.sub.id])).rows[0].status).toBe('stored');

    const saved = await env.server.inject({ method: 'POST', url: `${w()}/tickets/files/settings`, ...form(ws.owner, { auto_cleanup: '1', closed_enabled: '1', closed_days: '30', spam_enabled: '1', age_days: '180', storage_limit_gb: '2' }) });
    expect(saved.statusCode).toBe(302);
    await runFileCleanup(env.deps);
    expect((await env.db.query(`SELECT status FROM ticket_files WHERE submission_id = $1`, [closed.sub.id])).rows[0].status).toBe('deleted');
    const settings = (await env.db.query('SELECT last_run_summary FROM file_settings WHERE workspace_id = $1', [ws.workspace.id])).rows[0];
    expect(settings.last_run_summary).toMatchObject({ files: 1, tickets: 1 });

    // Already ran today: a new match waits for tomorrow's run.
    const later = await submitBug({ title: 'Closed too', files: [{ name: 'c.png', body: png() }] });
    await closeIssue(later.sub.issue_number, 40);
    await runFileCleanup(env.deps);
    expect((await env.db.query(`SELECT status FROM ticket_files WHERE submission_id = $1`, [later.sub.id])).rows[0].status).toBe('stored');
  });

  it('deletes spam files right away when the rules say so', async () => {
    const spam = await submitBug({ title: 'Buy now', files: [{ name: 'ad.png', body: png() }] });
    await cleanUpSpam(env.deps, spam.sub);
    expect((await env.db.query(`SELECT status FROM ticket_files WHERE submission_id = $1`, [spam.sub.id])).rows[0].status).toBe('stored');
    await saveFileSettings(env.db, ws.workspace.id, { auto_cleanup: true, closed_enabled: true, closed_days: 30, spam_enabled: true, age_enabled: false, age_days: 180, storage_limit_mb: 2048 });
    await cleanUpSpam(env.deps, spam.sub);
    expect((await env.db.query(`SELECT status, delete_reason FROM ticket_files WHERE submission_id = $1`, [spam.sub.id])).rows[0]).toEqual({ status: 'deleted', delete_reason: 'spam' });
  });
});

// ---- Small pieces ---------------------------------------------------------------------------------------------

describe('file helpers', () => {
  it('recognizes files by content and cleans names', () => {
    expect(sniff(png())?.contentType).toBe('image/png');
    expect(sniff(jpeg())?.ext).toBe('jpg');
    expect(sniff(mp4())).toBeNull();
    expect(sniff(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))).toBeNull();
    expect(sniff(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1'))).toBeNull();
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniff(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(cleanFilename('../../etc/passwd')).toBe('passwd');
    expect(cleanFilename('C:\\Users\\me\\shot<1>.png')).toBe('shot_1_.png');
    expect(cleanFilename('...')).toBe('file');
    expect(stripMetadata(png(), 'png').includes(Buffer.from('tEXt'))).toBe(false);
  });

  it('only rewrites the Attachments section of an issue', () => {
    const body = 'Edited by a maintainer\n\n### Ticket details\n\nrow';
    const block = filesBlock([{ id: 'AAAAAAAAAAAAAAAAAAAAAA', filename: 'a [x].png', kind: 'image', status: 'stored', size: 10 } as TicketFile], 'https://r.test')!;
    const once = replaceFilesBlock(body, block);
    expect(once).toBe(`Edited by a maintainer\n\n${block}\n\n### Ticket details\n\nrow`);
    expect(block).toContain('![a \\[x\\].png](https://r.test/f/AAAAAAAAAAAAAAAAAAAAAA/a%20%5Bx%5D.png)');
    const removed = filesBlock([{ id: 'AAAAAAAAAAAAAAAAAAAAAA', filename: 'a.png', kind: 'image', status: 'deleted', delete_reason: 'manual', size: 10 } as TicketFile], 'https://r.test')!;
    expect(replaceFilesBlock(once, removed)).toBe(`Edited by a maintainer\n\n${removed}\n\n### Ticket details\n\nrow`);
  });
});
