import type { DiscordChannel, DiscordRole } from './client.js';

export const Permission = {
  ADMINISTRATOR: 1n << 3n,
  MANAGE_GUILD: 1n << 5n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  MANAGE_ROLES: 1n << 28n,
} as const;

/** What the bot needs in the tickets channel: post and later edit/fetch the panel. */
export const REQUIRED_CHANNEL_PERMISSIONS: { flag: bigint; name: string }[] = [
  { flag: Permission.VIEW_CHANNEL, name: 'View Channel' },
  { flag: Permission.SEND_MESSAGES, name: 'Send Messages' },
  { flag: Permission.EMBED_LINKS, name: 'Embed Links' },
  { flag: Permission.READ_MESSAGE_HISTORY, name: 'Read Message History' },
];

/** Requested when adding the bot: channel permissions for panels, plus Manage Roles for contributor roles. */
export const BOT_INSTALL_PERMISSIONS = REQUIRED_CHANNEL_PERMISSIONS.reduce((acc, p) => acc | p.flag, 0n) | Permission.MANAGE_ROLES;

const ALL = (1n << 64n) - 1n;

/** Guild-level permissions for a member (Discord's documented base-permission algorithm). */
export function computeBasePermissions(
  guildId: string,
  ownerId: string,
  memberId: string,
  memberRoleIds: string[],
  roles: DiscordRole[],
): bigint {
  if (memberId === ownerId) return ALL;
  const byId = new Map(roles.map((r) => [r.id, r]));
  let perms = BigInt(byId.get(guildId)?.permissions ?? '0');
  for (const id of memberRoleIds) perms |= BigInt(byId.get(id)?.permissions ?? '0');
  return perms & Permission.ADMINISTRATOR ? ALL : perms;
}

/** Applies channel overwrites: @everyone, then combined role overwrites, then the member. */
export function computeChannelPermissions(
  base: bigint,
  guildId: string,
  memberId: string,
  memberRoleIds: string[],
  channel: Pick<DiscordChannel, 'permission_overwrites'>,
): bigint {
  if (base & Permission.ADMINISTRATOR) return ALL;
  const overwrites = channel.permission_overwrites ?? [];
  let perms = base;
  const everyone = overwrites.find((o) => o.id === guildId);
  if (everyone) perms = (perms & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && o.id !== guildId && memberRoleIds.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  perms = (perms & ~deny) | allow;
  const member = overwrites.find((o) => o.type === 1 && o.id === memberId);
  if (member) perms = (perms & ~BigInt(member.deny)) | BigInt(member.allow);
  // Without View Channel nothing else applies; without Send Messages, Embed Links is moot.
  if (!(perms & Permission.VIEW_CHANNEL)) return 0n;
  if (!(perms & Permission.SEND_MESSAGES)) perms &= ~Permission.EMBED_LINKS;
  return perms;
}

/** Permissions that make a role more than a label: a role members give themselves can't have any. */
const ELEVATED: [number, string][] = [
  [3, 'Administrator'], [5, 'Manage Server'], [28, 'Manage Roles'], [4, 'Manage Channels'], [1, 'Kick Members'], [2, 'Ban Members'],
  [40, 'Timeout Members'], [13, 'Manage Messages'], [17, 'Mention @everyone'], [29, 'Manage Webhooks'], [27, 'Manage Nicknames'],
  [30, 'Manage Expressions'], [7, 'View Audit Log'], [33, 'Manage Events'], [34, 'Manage Threads'], [22, 'Mute Members'], [23, 'Deafen Members'], [24, 'Move Members'],
];

/** The moderator-type permissions a role has (by name). */
export function elevatedPermissions(perms: string | bigint): string[] {
  const p = BigInt(perms);
  return ELEVATED.filter(([bit]) => p & (1n << BigInt(bit))).map(([, name]) => name);
}

export function missingPermissions(perms: bigint): string[] {
  return REQUIRED_CHANNEL_PERMISSIONS.filter((p) => !(perms & p.flag)).map((p) => p.name);
}

/** True if a user can manage the guild (needed to choose it as the workspace's server). */
export function canManageGuild(g: { owner?: boolean; permissions?: string }): boolean {
  if (g.owner) return true;
  const p = BigInt(g.permissions ?? '0');
  return Boolean(p & Permission.ADMINISTRATOR || p & Permission.MANAGE_GUILD);
}

/** Text (0) and announcement (5) channels can hold the ticket panel. */
export function isPanelChannel(c: { type: number }): boolean {
  return c.type === 0 || c.type === 5;
}
