import { readFileSync } from 'node:fs';

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
}

export class ConfigError extends Error {}

function readPrivateKey(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GITHUB_APP_PRIVATE_KEY_FILE) return readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8');
  const raw = env.GITHUB_APP_PRIVATE_KEY;
  if (!raw) return undefined;
  if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n');
  // Allow a base64-encoded PEM so the key fits in single-line secret stores.
  const decoded = Buffer.from(raw, 'base64').toString('utf8');
  return decoded.includes('BEGIN') ? decoded : raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = (env.NODE_ENV === 'production' || env.NODE_ENV === 'test' ? env.NODE_ENV : 'development') as Config['nodeEnv'];

  const databasePath = env.DATABASE_PATH || './data/ticket-relay.db';

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

  const privateKey = readPrivateKey(env);
  const githubVars = {
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_SLUG: env.GITHUB_APP_SLUG,
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
  };
  const missingGithub = Object.entries(githubVars).filter(([, v]) => !v).map(([k]) => k);
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
  };
}
