import { generateKeyPairSync, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { InjectOptions } from 'fastify';
import { createApp, type AppInstance } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { createApp as createAppRow, saveDiscordGuild, saveGitHubConnection, setTicketsChannel } from '../src/domain/store.js';
import type { AppRow, UserRow, WorkspaceRow } from '../src/domain/types.js';
import { AREA_KEYS, type MemberAccess } from '../src/domain/permissions.js';
import { createWorkspace, setModeratorAccess, upsertUser } from '../src/domain/workspaces.js';
import { createSession } from '../src/web/session.js';
import { FakeAnthropic, FakeDiscord, FakeGitHub, fakeFetch } from './fakes.js';
import { TEST_DATABASE_PATH } from './global-setup.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const GITHUB_PRIVATE_KEY = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const ed = generateKeyPairSync('ed25519');
export const DISCORD_PUBLIC_KEY_HEX = Buffer.from(ed.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('hex');

export const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/** Each test worker keeps attached files in its own temporary folder. */
export const TEST_FILES_DIR = path.join(tmpdir(), `ticket-relay-test-files-${process.pid}`);

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: TEST_DATABASE_PATH,
    PUBLIC_URL: 'https://relay.example.test',
    ENCRYPTION_KEY,
    DISCORD_APPLICATION_ID: '900000000000000001',
    DISCORD_PUBLIC_KEY: DISCORD_PUBLIC_KEY_HEX,
    DISCORD_BOT_TOKEN: 'bot-token',
    DISCORD_CLIENT_SECRET: 'discord-secret',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_SLUG: 'ticket-relay',
    GITHUB_APP_PRIVATE_KEY: GITHUB_PRIVATE_KEY,
    GITHUB_CLIENT_ID: 'Iv1.test',
    GITHUB_CLIENT_SECRET: 'gh-secret',
    GITHUB_WEBHOOK_SECRET: 'webhook-secret',
    FILES_DIR: TEST_FILES_DIR,
    ...env,
  });
}

let sharedDb: Db | null = null;
export function testDb(): Db {
  sharedDb ??= openDatabase(TEST_DATABASE_PATH);
  return sharedDb;
}

export async function resetDb(db: Db = testDb()): Promise<void> {
  db.exec('DELETE FROM sessions; DELETE FROM oauth_states; DELETE FROM workspaces; DELETE FROM users; DELETE FROM issue_index; DELETE FROM issue_live; DELETE FROM issue_index_repos; DELETE FROM process_status;');
  db.exec('DELETE FROM pull_index; DELETE FROM repo_status; DELETE FROM download_counts; DELETE FROM download_days; DELETE FROM download_assets; DELETE FROM download_sync; DELETE FROM repo_star_changes; DELETE FROM announcement_checks; DELETE FROM known_issue_overrides;');
  db.exec('UPDATE server_settings SET dev_mode_on_at = NULL, dev_mode_by = NULL, dev_mode_off_at = NULL;');
}

export interface TestEnv extends AppInstance {
  db: Db;
  github: FakeGitHub;
  discord: FakeDiscord;
  anthropic: FakeAnthropic;
}

export async function makeApp(opts: { config?: Config; github?: FakeGitHub; discord?: FakeDiscord; anthropic?: FakeAnthropic; db?: Db; instanceId?: string } = {}): Promise<TestEnv> {
  const github = opts.github ?? new FakeGitHub();
  const discord = opts.discord ?? new FakeDiscord();
  const anthropic = opts.anthropic ?? new FakeAnthropic();
  const db = opts.db ?? testDb();
  const app = await createApp({
    config: opts.config ?? testConfig(),
    db,
    fetch: fakeFetch(github, discord, anthropic),
    instanceId: opts.instanceId,
    githubTimeouts: { request: 500, createIssue: 150 },
  });
  return { ...app, db, github, discord, anthropic };
}

export interface Admin {
  user: UserRow;
  cookie: string;
  csrf: string;
}

let userCounter = 0;
export async function makeAdmin(env: TestEnv, name = `admin${++userCounter}`): Promise<Admin> {
  const user = await upsertUser(env.db, { discordUserId: String(10_000 + ++userCounter), username: name, displayName: name, avatar: null });
  const { token, session } = await createSession(env.db, user.id, null);
  return { user, cookie: `tr_session=${token}`, csrf: session.csrf_token };
}

export interface ConfiguredWorkspace {
  workspace: WorkspaceRow;
  owner: Admin;
  guildId: string;
  channelId: string;
  installationId: number;
  repoIds: number[];
  apps: AppRow[];
}

let wsCounter = 0;
/** A workspace with GitHub + Discord connected, a tickets channel and the given apps. */
export async function makeWorkspace(
  env: TestEnv,
  opts: { apps?: { name: string; repoIndex?: number; labels?: string[]; enabled?: boolean }[]; repos?: Parameters<FakeGitHub['addInstallation']>[2]; owner?: Admin } = {},
): Promise<ConfiguredWorkspace> {
  const n = ++wsCounter;
  const owner = opts.owner ?? (await makeAdmin(env));
  const workspace = await createWorkspace(env.db, { ...env.deps.config, openWorkspaceCreation: true }, owner.user, `Workspace ${n}`);
  const installationId = 7000 + n;
  const repoIds = env.github.addInstallation(installationId, `org${n}`, opts.repos ?? [
    { id: n * 100 + 1, name: 'mobile', private: true },
    { id: n * 100 + 2, name: 'web', private: false },
  ]);
  await saveGitHubConnection(env.db, workspace.id, { installationId, accountLogin: `org${n}`, accountType: 'Organization', accountAvatarUrl: null, repositorySelection: 'selected', suspended: false }, owner.user.id);
  const guildId = String(800000000000000000n + BigInt(n) * 10n);
  const channelId = String(BigInt(guildId) + 1n);
  env.discord.addGuild(guildId, `Guild ${n}`, [{ id: channelId, type: 0, name: 'tickets', position: 0 }]);
  await saveDiscordGuild(env.db, workspace.id, { id: guildId, name: `Guild ${n}`, icon: null }, owner.user.id);
  await setTicketsChannel(env.db, workspace.id, { id: channelId, name: 'tickets' });
  const apps: AppRow[] = [];
  for (const a of opts.apps ?? [{ name: 'Mobile App' }]) {
    const repo = env.github.repos.get(repoIds[a.repoIndex ?? 0]!)!;
    apps.push(await createAppRow(env.db, workspace.id, {
      name: a.name,
      description: null,
      repo: { id: repo.id, owner: repo.owner, name: repo.name, private: repo.private },
      labels: a.labels ?? [],
      enabled: a.enabled ?? true,
    }));
  }
  return { workspace, owner, guildId, channelId, installationId, repoIds, apps };
}

/** Sets exactly what a moderator can open; pages left out get no access (the Inbox stays View). */
export async function grant(env: TestEnv, workspaceId: string, userId: string, access: MemberAccess['access']): Promise<void> {
  await setModeratorAccess(env.db, workspaceId, userId, Object.fromEntries(AREA_KEYS.map((a) => [a, access[a] ?? 'none'])));
}

let interactionCounter = 0;
export function nextInteractionId(): string {
  return String(1_300_000_000_000_000_000n + BigInt(++interactionCounter));
}

export function member(id = '555000000000000001', name = 'Casey'): { nick: string | null; user: { id: string; username: string; global_name: string } } {
  return { nick: null, user: { id, username: name.toLowerCase(), global_name: name } };
}

export function modalSubmit(ws: ConfiguredWorkspace, app: AppRow, fields: { title: string; description: string }, extra: Partial<{ id: string; member: ReturnType<typeof member>; repoId: number }> = {}) {
  return {
    id: extra.id ?? nextInteractionId(),
    type: 5,
    token: `itoken-${interactionCounter}`,
    guild_id: ws.guildId,
    channel_id: ws.channelId,
    member: extra.member ?? member(),
    data: {
      custom_id: `tr:form:${app.public_id}:${extra.repoId ?? app.repo_id}`,
      components: [
        { type: 10, id: 1 },
        { type: 18, id: 2, component: { type: 4, id: 3, custom_id: 'title', value: fields.title } },
        { type: 18, id: 4, component: { type: 4, id: 5, custom_id: 'description', value: fields.description } },
      ],
    },
  };
}

/** Sends a correctly signed Discord interaction to the app. */
export async function sendInteraction(env: TestEnv, body: unknown, opts: { badSignature?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + raw), ed.privateKey).toString('hex');
  return env.server.inject({
    method: 'POST',
    url: '/discord/interactions',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': opts.badSignature ? signature.replace(/^./, signature[0] === 'a' ? 'b' : 'a') : signature,
      'x-signature-timestamp': timestamp,
    },
    payload: raw,
  });
}

export function form(admin: Admin, fields: Record<string, string | string[]> = {}): Pick<InjectOptions, 'headers' | 'payload'> {
  const params = new URLSearchParams();
  params.set('_csrf', admin.csrf);
  for (const [k, v] of Object.entries(fields)) for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
  return { headers: { cookie: admin.cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: params.toString() };
}

export function get(admin: Admin): Pick<InjectOptions, 'headers'> {
  return { headers: { cookie: admin.cookie } };
}

/** Waits until a condition holds (for work started after an HTTP response). */
export async function eventually<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}
