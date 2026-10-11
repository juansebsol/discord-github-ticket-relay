import { DiscordApiError, DiscordErrorCode, type DiscordClient } from '../discord/client.js';
import { computeBasePermissions, computeChannelPermissions, isPanelChannel, missingPermissions } from '../discord/permissions.js';

export interface ChannelOption {
  id: string;
  name: string;
  category: string | null;
  missing: string[];
}

export type GuildAccess =
  | { ok: true; guild: { id: string; name: string; icon: string | null }; channels: ChannelOption[] }
  | { ok: false; reason: 'bot_not_in_guild' | 'error'; message: string };

/**
 * Lists channels that can hold the panel, with the permissions the bot is missing in
 * each (computed from roles and channel overwrites the way Discord does).
 */
export async function inspectGuild(discord: DiscordClient, guildId: string): Promise<GuildAccess> {
  try {
    const [guild, bot] = await Promise.all([discord.getGuild(guildId), discord.getBotUser()]);
    const [channels, roles, member] = await Promise.all([
      discord.listChannels(guildId),
      discord.listRoles(guildId),
      discord.getMember(guildId, bot.id),
    ]);
    const base = computeBasePermissions(guildId, guild.owner_id, bot.id, member.roles, roles);
    const categories = new Map(channels.filter((c) => c.type === 4).map((c) => [c.id, c]));
    const options = channels
      .filter(isPanelChannel)
      .sort((a, b) => {
        const pa = a.parent_id ? (categories.get(a.parent_id)?.position ?? 0) : -1;
        const pb = b.parent_id ? (categories.get(b.parent_id)?.position ?? 0) : -1;
        return pa - pb || a.position - b.position;
      })
      .map((c) => ({
        id: c.id,
        name: c.name,
        category: c.parent_id ? (categories.get(c.parent_id)?.name ?? null) : null,
        missing: missingPermissions(computeChannelPermissions(base, guildId, bot.id, member.roles, c)),
      }));
    return { ok: true, guild: { id: guild.id, name: guild.name, icon: guild.icon }, channels: options };
  } catch (err) {
    if (
      err instanceof DiscordApiError &&
      (err.status === 403 || err.status === 404 || err.code === DiscordErrorCode.UnknownGuild || err.code === DiscordErrorCode.MissingAccess)
    ) {
      return { ok: false, reason: 'bot_not_in_guild', message: 'The bot is not in this Discord server (it may have been removed).' };
    }
    return { ok: false, reason: 'error', message: 'Could not reach Discord to check the server. Try again in a moment.' };
  }
}
