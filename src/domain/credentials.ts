import { DiscordApiError } from '../discord/client.js';
import { GitHubApiError } from '../github/client.js';
import { NetworkError } from '../lib/http.js';
import type { Deps } from './types.js';

export type CredentialCheck = { ok: true; detail: string } | { ok: false; detail: string };

/** Admin-facing explanation of a failed GitHub App (JWT) call. */
export function explainGitHubAppError(err: unknown): string {
  if (err instanceof GitHubApiError) {
    if (err.status === 401) {
      return `GitHub rejected this server's GitHub App credentials (“${err.githubMessage}”). Check that GITHUB_APP_ID and GITHUB_CLIENT_ID belong to this app, that secrets/sec.pem is the app's current private key (an old or deleted key fails), and that the server clock is correct.`;
    }
    if (err.status === 404) {
      return 'GitHub could not find that installation for this app. Check that GITHUB_APP_ID and GITHUB_CLIENT_ID belong to the app you installed.';
    }
    return `GitHub returned ${err.status}: ${err.githubMessage}`;
  }
  if (err instanceof NetworkError) return 'Could not reach GitHub from the server. Try again in a moment.';
  return 'Unexpected error while talking to GitHub.';
}

/** Verifies the GitHub App credentials with a real API call, and that the slug matches. */
export async function checkGitHubCredentials(deps: Pick<Deps, 'github' | 'config'>): Promise<CredentialCheck> {
  if (!deps.github || !deps.config.github) return { ok: false, detail: 'Not configured.' };
  try {
    const app = await deps.github.getApp();
    if (app.slug !== deps.config.github.slug) {
      return {
        ok: false,
        detail: `GITHUB_APP_SLUG is “${deps.config.github.slug}” but these credentials belong to the app “${app.slug}”. Set GITHUB_APP_SLUG=${app.slug}, otherwise the install button opens the wrong app.`,
      };
    }
    return { ok: true, detail: `Credentials work for the GitHub App “${app.name}” (${app.slug}, owned by ${app.owner}).` };
  } catch (err) {
    return { ok: false, detail: explainGitHubAppError(err) };
  }
}

/** Verifies the Discord bot token with a real API call. */
export async function checkDiscordCredentials(deps: Pick<Deps, 'discord'>): Promise<CredentialCheck> {
  if (!deps.discord) return { ok: false, detail: 'Not configured.' };
  try {
    const bot = await deps.discord.getBotUser();
    return { ok: true, detail: `Bot token works for “${bot.username}”.` };
  } catch (err) {
    if (err instanceof DiscordApiError && err.status === 401) return { ok: false, detail: 'Discord rejected DISCORD_BOT_TOKEN. Reset the token in the Developer Portal (Bot page) and update .env.' };
    return { ok: false, detail: 'Could not reach Discord from the server.' };
  }
}
