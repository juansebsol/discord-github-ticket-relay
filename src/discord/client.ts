import type { DiscordAppConfig } from '../config.js';
import { fetchWithTimeout, sleep, type FetchLike } from '../lib/http.js';

export const DISCORD_API = 'https://discord.com/api/v10';

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    readonly discordMessage: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`Discord API ${status}${code !== null ? ` (code ${code})` : ''}: ${discordMessage}`);
    this.name = 'DiscordApiError';
  }
}

/** JSON error codes we react to. */
export const DiscordErrorCode = {
  UnknownChannel: 10003,
  UnknownGuild: 10004,
  UnknownMessage: 10008,
  UnknownWebhook: 10015,
  UnknownInteraction: 10062,
  UnknownMember: 10007,
  MissingAccess: 50001,
  MissingPermissions: 50013,
} as const;

export interface DiscordGuildSummary {
  id: string;
  name: string;
  icon: string | null;
  owner?: boolean;
  permissions?: string;
}

export interface DiscordChannel {
  id: string;
  type: number;
  name: string;
  position: number;
  parent_id?: string | null;
  permission_overwrites?: { id: string; type: number; allow: string; deny: string }[];
}

export interface DiscordRole {
  id: string;
  name: string;
  permissions: string;
  position: number;
  managed?: boolean;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export interface OAuthTokenResult {
  accessToken: string;
  expiresIn: number;
  scope: string;
  guild: DiscordGuildSummary | null;
}

export class DiscordClient {
  private botUser: DiscordUser | null = null;

  constructor(
    readonly config: DiscordAppConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  private async request<T = any>(
    method: string,
    path: string,
    opts: { auth?: 'bot' | 'none' | string; body?: unknown; form?: URLSearchParams; retryOn429?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { 'User-Agent': 'DiscordBot (discord-github-ticket-relay, 0.1)', ...opts.headers };
    const auth = opts.auth ?? 'bot';
    if (auth === 'bot') headers.Authorization = `Bot ${this.config.botToken}`;
    else if (auth !== 'none') headers.Authorization = `Bearer ${auth}`;
    let body: string | undefined;
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = opts.form.toString();
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    for (let attempt = 0; ; attempt++) {
      const res = await fetchWithTimeout(this.fetchImpl, `${DISCORD_API}${path}`, { method, headers, body }, this.timeoutMs);
      const text = await res.text();
      let data: any = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      if (res.ok) return data as T;
      const retryAfter =
        res.status === 429 ? Number(data?.retry_after ?? res.headers.get('retry-after') ?? 1) : null;
      if (res.status === 429 && retryAfter !== null && retryAfter <= 5 && attempt < 2 && opts.retryOn429 !== false) {
        await sleep(Math.ceil(retryAfter * 1000));
        continue;
      }
      throw new DiscordApiError(
        res.status,
        typeof data?.code === 'number' ? data.code : null,
        typeof data?.message === 'string' ? data.message : data?.error_description ?? res.statusText,
        retryAfter,
      );
    }
  }

  // ---- OAuth2 -------------------------------------------------------------------------

  loginUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.config.applicationId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'identify guilds',
      state,
      prompt: 'none',
    });
    return `https://discord.com/oauth2/authorize?${params}`;
  }

  botInstallUrl(state: string, redirectUri: string, permissions: bigint, guildId?: string): string {
    const params = new URLSearchParams({
      client_id: this.config.applicationId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'bot identify',
      permissions: permissions.toString(),
      integration_type: '0',
      state,
    });
    if (guildId) {
      params.set('guild_id', guildId);
      params.set('disable_guild_select', 'true');
    }
    return `https://discord.com/oauth2/authorize?${params}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<OAuthTokenResult> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.config.applicationId,
      client_secret: this.config.clientSecret,
    });
    const data = await this.request('POST', '/oauth2/token', { auth: 'none', form });
    return {
      accessToken: data.access_token,
      expiresIn: Number(data.expires_in ?? 0),
      scope: data.scope ?? '',
      guild: data.guild ? { id: data.guild.id, name: data.guild.name, icon: data.guild.icon ?? null } : null,
    };
  }

  getCurrentUser(userToken: string): Promise<DiscordUser> {
    return this.request('GET', '/users/@me', { auth: userToken });
  }

  listUserGuilds(userToken: string): Promise<DiscordGuildSummary[]> {
    return this.request('GET', '/users/@me/guilds?limit=200', { auth: userToken });
  }

  // ---- Bot ----------------------------------------------------------------------------

  async getBotUser(): Promise<DiscordUser> {
    if (!this.botUser) this.botUser = await this.request<DiscordUser>('GET', '/users/@me');
    return this.botUser;
  }

  async listBotGuilds(): Promise<DiscordGuildSummary[]> {
    const out: DiscordGuildSummary[] = [];
    let after = '0';
    for (let page = 0; page < 50; page++) {
      const batch = await this.request<DiscordGuildSummary[]>('GET', `/users/@me/guilds?limit=200&after=${after}`);
      out.push(...batch);
      if (batch.length < 200) break;
      after = batch[batch.length - 1]!.id;
    }
    return out;
  }

  getGuild(guildId: string): Promise<{ id: string; name: string; icon: string | null; owner_id: string }> {
    return this.request('GET', `/guilds/${guildId}`);
  }

  listChannels(guildId: string): Promise<DiscordChannel[]> {
    return this.request('GET', `/guilds/${guildId}/channels`);
  }

  listRoles(guildId: string): Promise<DiscordRole[]> {
    return this.request('GET', `/guilds/${guildId}/roles`);
  }

  getMember(guildId: string, userId: string): Promise<{ roles: string[]; user?: DiscordUser }> {
    return this.request('GET', `/guilds/${guildId}/members/${userId}`);
  }

  createMessage(channelId: string, payload: unknown): Promise<{ id: string }> {
    return this.request('POST', `/channels/${channelId}/messages`, { body: payload });
  }

  editMessage(channelId: string, messageId: string, payload: unknown): Promise<{ id: string }> {
    return this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, { body: payload });
  }

  getMessage(channelId: string, messageId: string): Promise<{ id: string }> {
    return this.request('GET', `/channels/${channelId}/messages/${messageId}`);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.request('DELETE', `/channels/${channelId}/messages/${messageId}`);
  }

  async addMemberRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    await this.request('PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      headers: { 'X-Audit-Log-Reason': encodeURIComponent(reason.slice(0, 400)) },
    });
  }

  async removeMemberRole(guildId: string, userId: string, roleId: string, reason: string): Promise<void> {
    await this.request('DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
      headers: { 'X-Audit-Log-Reason': encodeURIComponent(reason.slice(0, 400)) },
    });
  }

  // ---- Interaction follow-ups (authorized by the interaction token, not the bot token) --

  async editOriginalResponse(interactionToken: string, payload: unknown): Promise<void> {
    await this.request(
      'PATCH',
      `/webhooks/${this.config.applicationId}/${interactionToken}/messages/@original`,
      { auth: 'none', body: payload },
    );
  }
}
