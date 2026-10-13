import { createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root (parent of src/ or dist/). Relative paths in config resolve against it, not the cwd. */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Loads `<APP_ROOT>/.env` if present. Variables already set in the environment win. */
export function loadDotEnv(): void {
  const file = path.join(APP_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

function fromRoot(p: string): string {
  return p === ':memory:' ? p : path.resolve(APP_ROOT, p);
}

/**
 * One-time deployment configuration. Everything here is infrastructure: provider
 * application credentials and secrets that an operator sets once. All routine setup
 * (which GitHub account, which Discord server/channel, apps, labels, limits) happens in
 * the admin interface and is stored in the database.
 */
export interface DiscordAppConfig {
  applicationId: string;
  publicKey: string;
  botToken: string;
  clientSecret: string;
}

export interface GitHubAppConfig {
  appId: string;
  slug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string | null;
}

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  publicUrl: string;
  /** SQLite database file. */
  databasePath: string;
  encryptionKey: Buffer;
  discord: DiscordAppConfig | null;
  github: GitHubAppConfig | null;
  /** Names of provider variables that are missing; shown to admins as a deployment checklist. */
  missing: { discord: string[]; github: string[] };
  platformAdminDiscordIds: string[];
  openWorkspaceCreation: boolean;
  devLogin: boolean;
  runWorker: boolean;
  trustProxy: boolean;
  /** Who runs this deployment, shown on the public Terms of Service and Privacy Policy pages. */
  legal: { operatorName: string | null; contactEmail: string | null };
}

export class ConfigError extends Error {}

type KeyResult = { key: string } | { error: string } | null;

function readKeyFile(p: string, variable: string): KeyResult {
  const file = fromRoot(p);
  if (!existsSync(file)) return { error: `${variable}: file not found (${file})` };
  try {
    return { key: readFileSync(file, 'utf8') };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { error: `${variable}: cannot read ${file}${code === 'EACCES' ? ' (permission denied: make it owned by the user running the app)' : ''}` };
  }
}

/**
 * Loads the GitHub App private key from GITHUB_APP_PRIVATE_KEY_FILE, or from
 * GITHUB_APP_PRIVATE_KEY (PEM, \\n-escaped PEM, base64 PEM, or a file path), and checks it parses.
 */
function readPrivateKey(env: NodeJS.ProcessEnv): KeyResult {
  let result: KeyResult = null;
  const raw = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (env.GITHUB_APP_PRIVATE_KEY_FILE) result = readKeyFile(env.GITHUB_APP_PRIVATE_KEY_FILE, 'GITHUB_APP_PRIVATE_KEY_FILE');
  else if (!raw) return null;
  else if (raw.includes('BEGIN')) result = { key: raw.replace(/\\n/g, '\n') };
  else if (/\.pem$/i.test(raw) || raw.startsWith('/') || raw.startsWith('./')) result = readKeyFile(raw, 'GITHUB_APP_PRIVATE_KEY');
  else {
    // A base64-encoded PEM fits in single-line secret stores.
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    result = { key: decoded };
  }
  if ('key' in result!) {
    try {
      createPrivateKey(result.key);
    } catch {
      return { error: 'GITHUB_APP_PRIVATE_KEY: not a valid private key (expected the .pem file downloaded from the GitHub App page)' };
    }
  }
  return result;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = (env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? env.NODE_ENV : 'development') as Config['nodeEnv'];

  const databasePath = fromRoot(env.DATABASE_PATH || './data/ticket-relay.db');

  const port = Number(env.PORT ?? 3000);
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(publicUrl)) throw new ConfigError('PUBLIC_URL must start with http:// or https://');

  const keyB64 = env.ENCRYPTION_KEY;
  if (!keyB64) throw new ConfigError('ENCRYPTION_KEY is required. Generate one with: openssl rand -base64 32');
  const encryptionKey = Buffer.from(keyB64, 'base64');
  if (encryptionKey.length !== 32) throw new ConfigError('ENCRYPTION_KEY must be 32 bytes, base64-encoded.');

  const discordVars = {
    DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID,
    DISCORD_PUBLIC_KEY: env.DISCORD_PUBLIC_KEY,
    DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN,
    DISCORD_CLIENT_SECRET: env.DISCORD_CLIENT_SECRET,
  };
  const missingDiscord = Object.entries(discordVars).filter(([, v]) => !v).map(([k]) => k);
  const discord: DiscordAppConfig | null = missingDiscord.length
    ? null
    : {
        applicationId: discordVars.DISCORD_APPLICATION_ID!,
        publicKey: discordVars.DISCORD_PUBLIC_KEY!,
        botToken: discordVars.DISCORD_BOT_TOKEN!,
        clientSecret: discordVars.DISCORD_CLIENT_SECRET!,
      };

  const keyResult = readPrivateKey(env);
  const privateKey = keyResult && 'key' in keyResult ? keyResult.key : undefined;
  const githubVars = {
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_SLUG: env.GITHUB_APP_SLUG,
    GITHUB_APP_PRIVATE_KEY_FILE: privateKey,
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
  };
  const missingGithub = Object.entries(githubVars)
    .filter(([, v]) => !v)
    .map(([k]) => (k === 'GITHUB_APP_PRIVATE_KEY_FILE' && keyResult && 'error' in keyResult ? keyResult.error : k));
  const github: GitHubAppConfig | null = missingGithub.length
    ? null
    : {
        appId: githubVars.GITHUB_APP_ID!,
        slug: githubVars.GITHUB_APP_SLUG!,
        privateKey: privateKey!,
        clientId: githubVars.GITHUB_CLIENT_ID!,
        clientSecret: githubVars.GITHUB_CLIENT_SECRET!,
        webhookSecret: env.GITHUB_WEBHOOK_SECRET || null,
      };

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicUrl);
  const devLogin = env.DEV_LOGIN === 'true' && nodeEnv !== 'production' && isLocal;

  return {
    nodeEnv,
    host: env.HOST ?? '0.0.0.0',
    port,
    publicUrl,
    databasePath,
    encryptionKey,
    discord,
    github,
    missing: { discord: missingDiscord, github: missingGithub },
    platformAdminDiscordIds: (env.PLATFORM_ADMIN_DISCORD_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    openWorkspaceCreation: env.OPEN_WORKSPACE_CREATION === 'true',
    devLogin,
    runWorker: env.RUN_WORKER !== 'false',
    trustProxy: env.TRUST_PROXY === 'true',
    legal: {
      operatorName: env.LEGAL_OPERATOR_NAME?.trim() || null,
      contactEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.LEGAL_CONTACT_EMAIL?.trim() ?? '') ? env.LEGAL_CONTACT_EMAIL!.trim() : null,
    },
  };
}
