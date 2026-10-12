import { randomUUID } from 'node:crypto';
import { withTransaction, type Queryable } from '../db/database.js';
import { DiscordApiError, DiscordErrorCode, type DiscordClient } from '../discord/client.js';
import * as m from '../discord/messages.js';
import { computeBasePermissions, Permission } from '../discord/permissions.js';
import { GitHubApiError } from '../github/client.js';
import { sha256 } from '../lib/crypto.js';
import { consumeState, createState, type StateRow } from './oauth-state.js';
import { getAppByPublicId, getDiscordConnection, getGitHubConnection, listApps } from './store.js';
import { UserFacingError, type AppRow, type Deps, type DiscordConnectionRow, type WorkspaceRow } from './types.js';

/**
 * Contributor roles: a second Discord panel where members sign in with GitHub so we can
 * count their contributions (per repository: merged pull requests or direct commits,
 * whichever is higher) added up across every enabled app's repository, then receive the
 * highest contributor tier they qualify for
 * (e.g. Junior Contributor at 1, Contributor at 10). Roles are only removed by an admin,
 * except that a lower tier role is swapped out when a member moves up a tier.
 */

export const VERIFY_LINK_TTL_MINUTES = 10;
const VERIFY_RATE_LIMIT = { count: 5, windowMs: 10 * 60_000 };

export interface ContributorSettings {
  enabled: boolean;
  role_id: string | null;
  role_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  /** Custom “Which role will I get?” list for the panel; null = generated from the tiers. */
  roles_text: string | null;
  /** Other panel text overrides; null = built-in default. */
  panel_title: string | null;
  panel_intro: string | null;
  panel_steps: string | null;
  panel_footer: string | null;
  button_label: string | null;
}

export type ContributorPanelTextFields = Pick<ContributorSettings, 'panel_title' | 'panel_intro' | 'roles_text' | 'panel_steps' | 'panel_footer' | 'button_label'>;

const TEXT_COLUMNS = ['panel_title', 'panel_intro', 'roles_text', 'panel_steps', 'panel_footer', 'button_label'] as const;

export async function getContributorSettings(q: Queryable, workspaceId: string): Promise<ContributorSettings> {
  const { rows } = await q.query<Omit<ContributorSettings, 'enabled'> & { enabled: number }>(
    `SELECT enabled, role_id, role_name, channel_id, channel_name, ${TEXT_COLUMNS.join(', ')} FROM contributor_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  const r = rows[0];
  return r ? { ...r, enabled: Boolean(r.enabled) } : { enabled: false, role_id: null, role_name: null, channel_id: null, channel_name: null, roles_text: null, panel_title: null, panel_intro: null, panel_steps: null, panel_footer: null, button_label: null };
}

/** Saves on/off and the panel channel (panel text is saved separately). */
export async function saveContributorSettings(
  q: Queryable,
  workspaceId: string,
  s: Pick<ContributorSettings, 'enabled' | 'role_id' | 'role_name' | 'channel_id' | 'channel_name'>,
): Promise<void> {
  await q.query(
    `INSERT INTO contributor_settings (workspace_id, enabled, role_id, role_name, channel_id, channel_name, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now_ms())
     ON CONFLICT (workspace_id) DO UPDATE SET enabled = EXCLUDED.enabled, role_id = EXCLUDED.role_id,
       role_name = EXCLUDED.role_name, channel_id = EXCLUDED.channel_id, channel_name = EXCLUDED.channel_name, updated_at = now_ms()`,
    [workspaceId, s.enabled, s.role_id, s.role_name, s.channel_id, s.channel_name],
  );
}

/** Saves the panel text overrides (null = default). */
export async function saveContributorPanelText(q: Queryable, workspaceId: string, t: ContributorPanelTextFields): Promise<void> {
  await q.query(
    `INSERT INTO contributor_settings (workspace_id, ${TEXT_COLUMNS.join(', ')}, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now_ms())
     ON CONFLICT (workspace_id) DO UPDATE SET ${TEXT_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now_ms()`,
    [workspaceId, ...TEXT_COLUMNS.map((c) => t[c])],
  );
}

/** Enables contributor verification for exactly the given apps of the workspace. */
export async function setContributorApps(q: Queryable, workspaceId: string, appIds: string[]): Promise<void> {
  await q.query(
    `UPDATE apps SET contributor_enabled = CASE WHEN id IN (SELECT value FROM json_each($2)) THEN 1 ELSE 0 END WHERE workspace_id = $1`,
    [workspaceId, appIds],
  );
}

export interface ContributorTier {
  id: string;
  role_id: string;
  role_name: string;
  min_contributions: number;
  /** Optional panel text for this role; default "at least N merged pull requests". */
  note: string | null;
}

/** A role only listed on the panel; admins give it by hand, the bot never does. */
export interface ManualRole {
  id: string;
  role_id: string;
  role_name: string;
  note: string | null;
}

/** Tiers sorted by the contributions they require (lowest first). */
export async function listTiers(q: Queryable, workspaceId: string): Promise<ContributorTier[]> {
  const { rows } = await q.query<ContributorTier>(
    'SELECT id, role_id, role_name, min_contributions, note FROM contributor_tiers WHERE workspace_id = $1 ORDER BY min_contributions',
    [workspaceId],
  );
  return rows;
}

export async function addTier(
  q: Queryable,
  workspaceId: string,
  role: { id: string; name: string },
  minContributions: number,
  note: string | null = null,
): Promise<void> {
  const tiers = await listTiers(q, workspaceId);
  if (tiers.some((t) => t.role_id === role.id)) throw new UserFacingError(`@${role.name} is already a tier.`);
  if ((await listManualRoles(q, workspaceId)).some((r) => r.role_id === role.id)) throw new UserFacingError(`@${role.name} is listed as a manual role. Remove it there first.`);
  if (tiers.some((t) => t.min_contributions === minContributions)) throw new UserFacingError(`Another tier already needs ${minContributions} contribution${minContributions === 1 ? '' : 's'}.`);
  await q.query(
    'INSERT INTO contributor_tiers (id, workspace_id, role_id, role_name, min_contributions, note) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), workspaceId, role.id, role.name, minContributions, note],
  );
}

export async function listManualRoles(q: Queryable, workspaceId: string): Promise<ManualRole[]> {
  const { rows } = await q.query<ManualRole>(
    'SELECT id, role_id, role_name, note FROM contributor_manual_roles WHERE workspace_id = $1 ORDER BY created_at',
    [workspaceId],
  );
  return rows;
}

export async function addManualRole(q: Queryable, workspaceId: string, role: { id: string; name: string }, note: string | null): Promise<void> {
  if ((await listTiers(q, workspaceId)).some((t) => t.role_id === role.id)) throw new UserFacingError(`@${role.name} is already given automatically as a tier.`);
  if ((await listManualRoles(q, workspaceId)).some((r) => r.role_id === role.id)) throw new UserFacingError(`@${role.name} is already listed.`);
  await q.query(
    'INSERT INTO contributor_manual_roles (id, workspace_id, role_id, role_name, note) VALUES ($1, $2, $3, $4, $5)',
    [randomUUID(), workspaceId, role.id, role.name, note],
  );
}

export async function deleteManualRole(q: Queryable, workspaceId: string, id: string): Promise<void> {
  await q.query('DELETE FROM contributor_manual_roles WHERE workspace_id = $1 AND id = $2', [workspaceId, id]);
}

export async function deleteTier(q: Queryable, workspaceId: string, tierId: string): Promise<void> {
  await q.query('DELETE FROM contributor_tiers WHERE workspace_id = $1 AND id = $2', [workspaceId, tierId]);
}

function tierLabel(t: Pick<ContributorTier, 'role_name' | 'min_contributions'>): string {
  return `${t.role_name} at ${t.min_contributions}+`;
}

export function contributorApps(apps: AppRow[]): AppRow[] {
  return apps.filter((a) => a.contributor_enabled);
}

// ---- Discord role checks ---------------------------------------------------------------------

export interface RoleOption {
  id: string;
  name: string;
  position: number;
  assignable: boolean;
  reason: string | null;
}

export type RoleInspection =
  | { ok: true; canManageRoles: boolean; botRoleName: string | null; roles: RoleOption[] }
  | { ok: false; message: string };

/**
 * Lists roles the bot could hand out. Discord only lets a bot assign roles below its own
 * highest role, and only with Manage Roles; managed (integration) roles can't be assigned.
 */
export async function inspectRoles(discord: DiscordClient, guildId: string): Promise<RoleInspection> {
  try {
    const [guild, bot] = await Promise.all([discord.getGuild(guildId), discord.getBotUser()]);
    const [roles, member] = await Promise.all([discord.listRoles(guildId), discord.getMember(guildId, bot.id)]);
    const base = computeBasePermissions(guildId, guild.owner_id, bot.id, member.roles, roles);
    const canManageRoles = Boolean(base & Permission.MANAGE_ROLES);
    const botRoles = roles.filter((r) => member.roles.includes(r.id)).sort((a, b) => b.position - a.position);
    const botTop = botRoles[0]?.position ?? 0;
    const options = roles
      .filter((r) => r.id !== guildId)
      .sort((a, b) => b.position - a.position)
      .map((r) => {
        let reason: string | null = null;
        if (r.managed) reason = 'Managed by an integration';
        else if (r.position >= botTop) reason = `Above the bot's role (${botRoles[0]?.name ?? 'none'})`;
        return { id: r.id, name: r.name, position: r.position, assignable: reason === null, reason };
      });
    return { ok: true, canManageRoles, botRoleName: botRoles[0]?.name ?? null, roles: options };
  } catch {
    return { ok: false, message: 'Could not read the server roles from Discord. Check that the bot is still in the server.' };
  }
}

// ---- Contributor panel -------------------------------------------------------------------------

export interface ContributorPanelRow {
  workspace_id: string;
  channel_id: string;
  message_id: string;
  content_hash: string;
  status: 'published' | 'missing';
  published_at: Date;
  last_error: string | null;
}

export async function getContributorPanel(q: Queryable, workspaceId: string): Promise<ContributorPanelRow | null> {
  const { rows } = await q.query<ContributorPanelRow>('SELECT * FROM contributor_panels WHERE workspace_id = $1', [workspaceId]);
  return rows[0] ?? null;
}

/** Lines for the panel's role list: automatic tiers first, then manually given roles. */
export function panelRoleLines(tiers: ContributorTier[], manual: ManualRole[]): m.PanelRoleLine[] {
  return [
    ...tiers.map((t) => ({ roleId: t.role_id, min: t.min_contributions, note: t.note })),
    ...manual.map((r) => ({ roleId: r.role_id, min: null, note: r.note })),
  ];
}

export function contributorPanelPayload(tiers: ContributorTier[], settings: ContributorPanelTextFields, manual: ManualRole[] = []) {
  const payload = m.buildContributorPanel({
    roles: panelRoleLines(tiers, manual),
    text: {
      title: settings.panel_title,
      intro: settings.panel_intro,
      rolesText: settings.roles_text,
      steps: settings.panel_steps,
      footer: settings.panel_footer,
      buttonLabel: settings.button_label,
    },
  });
  return { payload, hash: sha256(JSON.stringify(payload)) };
}

function explainDiscordError(err: unknown): UserFacingError {
  if (err instanceof DiscordApiError) {
    if (err.code === DiscordErrorCode.MissingAccess || err.code === DiscordErrorCode.MissingPermissions) {
      return new UserFacingError('The bot is missing permissions in that channel. It needs View Channel, Send Messages, Embed Links and Read Message History.');
    }
    if (err.code === DiscordErrorCode.UnknownChannel) return new UserFacingError('That channel no longer exists. Choose another channel.');
    if (err.status === 429) return new UserFacingError('Discord is rate limiting the bot. Try again in a minute.', 429);
  }
  return new UserFacingError('Discord did not accept the panel. Try again in a moment.', 502);
}

export async function publishContributorPanel(deps: Deps, workspaceId: string, userId: string | null): Promise<'created' | 'updated' | 'recreated' | 'moved'> {
  const discord = deps.discord;
  if (!discord) throw new UserFacingError('Discord is not configured on this deployment.');
  const settings = await getContributorSettings(deps.db, workspaceId);
  if (!settings.channel_id) throw new UserFacingError('Choose a channel for the contributor panel first.');
  const tiers = await listTiers(deps.db, workspaceId);
  if (!tiers.length) throw new UserFacingError('Add at least one contributor role tier first.');
  const apps = await listApps(deps.db, workspaceId);
  if (!contributorApps(apps).length) throw new UserFacingError('Turn on contributor verification for at least one app first.');
  const { payload, hash } = contributorPanelPayload(tiers, settings, await listManualRoles(deps.db, workspaceId));
  const existing = await getContributorPanel(deps.db, workspaceId);

  if (existing && existing.channel_id === settings.channel_id) {
    try {
      await discord.editMessage(existing.channel_id, existing.message_id, payload);
      await saveContributorPanel(deps.db, workspaceId, settings.channel_id, existing.message_id, hash, userId);
      return 'updated';
    } catch (err) {
      if (!(err instanceof DiscordApiError && err.code === DiscordErrorCode.UnknownMessage)) throw explainDiscordError(err);
    }
  }
  let created;
  try {
    created = await discord.createMessage(settings.channel_id, payload);
  } catch (err) {
    throw explainDiscordError(err);
  }
  await saveContributorPanel(deps.db, workspaceId, settings.channel_id, created.id, hash, userId);
  if (existing && existing.channel_id !== settings.channel_id) {
    await discord.deleteMessage(existing.channel_id, existing.message_id).catch(() => {});
    return 'moved';
  }
  return existing ? 'recreated' : 'created';
}

async function saveContributorPanel(q: Queryable, workspaceId: string, channelId: string, messageId: string, hash: string, userId: string | null) {
  await q.query(
    `INSERT INTO contributor_panels (workspace_id, channel_id, message_id, content_hash, status, published_by)
     VALUES ($1, $2, $3, $4, 'published', $5)
     ON CONFLICT (workspace_id) DO UPDATE SET channel_id = EXCLUDED.channel_id, message_id = EXCLUDED.message_id,
       content_hash = EXCLUDED.content_hash, status = 'published', published_by = EXCLUDED.published_by,
       published_at = now_ms(), last_error = NULL`,
    [workspaceId, channelId, messageId, hash, userId],
  );
}

export type ContributorPanelState =
  | { state: 'not_published' }
  | { state: 'missing' }
  | { state: 'published'; outdated: boolean; channelChanged: boolean; link: string | null };

export async function checkContributorPanel(deps: Deps, workspaceId: string, conn: DiscordConnectionRow | null): Promise<ContributorPanelState> {
  const panel = await getContributorPanel(deps.db, workspaceId);
  if (!panel) return { state: 'not_published' };
  if (deps.discord) {
    try {
      await deps.discord.getMessage(panel.channel_id, panel.message_id);
    } catch (err) {
      if (err instanceof DiscordApiError && (err.code === DiscordErrorCode.UnknownMessage || err.code === DiscordErrorCode.UnknownChannel)) {
        await deps.db.query(`UPDATE contributor_panels SET status = 'missing' WHERE workspace_id = $1`, [workspaceId]);
        return { state: 'missing' };
      }
    }
  }
  const settings = await getContributorSettings(deps.db, workspaceId);
  const { hash } = contributorPanelPayload(await listTiers(deps.db, workspaceId), settings, await listManualRoles(deps.db, workspaceId));
  return {
    state: 'published',
    outdated: hash !== panel.content_hash,
    channelChanged: settings.channel_id !== panel.channel_id,
    link: conn ? `https://discord.com/channels/${conn.guild_id}/${panel.channel_id}/${panel.message_id}` : null,
  };
}

export async function unpublishContributorPanel(deps: Deps, workspaceId: string): Promise<void> {
  const panel = await getContributorPanel(deps.db, workspaceId);
  if (!panel) return;
  if (deps.discord) await deps.discord.deleteMessage(panel.channel_id, panel.message_id).catch(() => {});
  await deps.db.query('DELETE FROM contributor_panels WHERE workspace_id = $1', [workspaceId]);
}

// ---- Discord interaction (member picks an app) -------------------------------------------------

interface MemberInteraction {
  token: string;
  guild_id?: string;
  member?: { nick?: string | null; user: { id: string; username: string; global_name?: string | null } };
  data?: { custom_id?: string; values?: string[] };
}

function notice(title: string, description: string) {
  return { response: { type: 4, data: m.noticeMessage(title, description) } };
}

export async function handleContributorComponent(deps: Deps, i: MemberInteraction, workspace: WorkspaceRow): Promise<{ response: unknown }> {
  const customId = i.data?.custom_id ?? '';
  // cv:verify is the current panel button; cv:pick / cv:pickp / cv:page are from the earlier
  // app-picker panel and run the same all-apps check until the panel is updated.
  if (!['cv:verify', 'cv:pick', 'cv:pickp'].includes(customId) && !customId.startsWith('cv:page:')) {
    return notice('Out of date', 'This button is no longer active. Please use the current panel.');
  }
  const settings = await getContributorSettings(deps.db, workspace.id);
  const tiers = await listTiers(deps.db, workspace.id);
  const apps = contributorApps(await listApps(deps.db, workspace.id));
  if (!settings.enabled || !tiers.length || !apps.length) {
    return notice('Not available', 'Contributor verification is turned off for this server right now.');
  }
  const gh = await getGitHubConnection(deps.db, workspace.id);
  if (!gh || gh.status !== 'active' || !deps.github) return notice('Temporarily unavailable', 'Verification is temporarily unavailable. Please try again later.');

  const member = i.member!;
  const recent = await deps.db.query<{ n: number }>(
    `SELECT count(*) AS n FROM contributor_verifications WHERE workspace_id = $1 AND discord_user_id = $2 AND created_at > now_ms() - $3`,
    [workspace.id, member.user.id, VERIFY_RATE_LIMIT.windowMs],
  );
  if (recent.rows[0]!.n >= VERIFY_RATE_LIMIT.count) {
    return notice('Please wait a moment', 'You have tried to verify several times recently. Please try again in a few minutes.');
  }

  const state = await createState(deps.db, 'contributor_verify', null, workspace.id, {
    guildId: i.guild_id,
    discordUserId: member.user.id,
    discordName: member.nick || member.user.global_name || member.user.username,
    tokenEnc: deps.box.encrypt(i.token),
    tokenExpiresAt: Date.now() + 14 * 60_000,
  }, VERIFY_LINK_TTL_MINUTES);
  const url = deps.github.authorizeUrl(state, `${deps.config.publicUrl}/oauth/github/callback`);
  return { response: { type: 4, data: m.contributorVerifyPrompt({ tiers: tiers.map(tierLabel), url }) } };
}

// ---- GitHub callback (member returns from GitHub sign-in) ----------------------------------------

export interface VerificationResult {
  outcome: m.ContributorOutcome;
  appName: string;
  roleName: string | null;
  login: string | null;
  /** Shown to the member (browser page and Discord). */
  explanation: string;
}

interface VerifyStateData {
  guildId: string;
  discordUserId: string;
  discordName: string;
  tokenEnc: string;
  tokenExpiresAt: number;
}

/** Consumes a contributor-verification state. Returns null when it isn't one. */
export async function consumeContributorState(q: Queryable, token: string | undefined): Promise<StateRow | null> {
  return consumeState(q, token, ['contributor_verify']);
}

/** Distinct repositories of the enabled apps (several apps can share one repository). */
function distinctRepos(apps: AppRow[]): { owner: string; name: string }[] {
  const seen = new Map<number, { owner: string; name: string }>();
  for (const a of apps) if (!seen.has(a.repo_id)) seen.set(a.repo_id, { owner: a.repo_owner, name: a.repo_name });
  return [...seen.values()];
}

export async function completeVerification(deps: Deps, state: StateRow, code: string | undefined): Promise<VerificationResult> {
  const data = state.data as unknown as VerifyStateData;
  const workspaceId = state.workspace_id!;
  const settings = await getContributorSettings(deps.db, workspaceId);
  const tiers = await listTiers(deps.db, workspaceId);
  const apps = contributorApps(await listApps(deps.db, workspaceId));
  const repos = distinctRepos(apps);
  const gh = await getGitHubConnection(deps.db, workspaceId);
  const conn = await getDiscordConnection(deps.db, workspaceId);
  const appName = 'all apps';

  const finish = async (
    outcome: m.ContributorOutcome,
    explanation: string,
    extra: { login?: string | null; githubUserId?: number | null; method?: 'merged_pr' | 'commit' | null; info?: string | null; contributions?: number | null; roleName?: string | null } = {},
  ): Promise<VerificationResult> => {
    await deps.db.query(
      `INSERT INTO contributor_verifications (id, workspace_id, app_id, app_name, repo_owner, repo_name, discord_user_id, discord_name,
         github_user_id, github_login, result, method, info, contributions, role_name)
       VALUES ($1, $2, NULL, 'All apps', '', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [randomUUID(), workspaceId, repos.map((r) => `${r.owner}/${r.name}`).join(', '), data.discordUserId, data.discordName,
        extra.githubUserId ?? null, extra.login ?? null, outcome, extra.method ?? null, extra.info ?? null, extra.contributions ?? null, extra.roleName ?? null],
    );
    const result = { outcome, appName, roleName: extra.roleName ?? null, login: extra.login ?? null, explanation };
    // Update the member's private message in Discord while the interaction token is valid.
    if (deps.discord && data.tokenEnc && data.tokenExpiresAt > Date.now()) {
      const { flags: _flags, ...edit } = m.contributorResultMessage(result);
      await deps.discord.editOriginalResponse(deps.box.decrypt(data.tokenEnc), { ...edit, components: [] }).catch(() => {});
    }
    deps.log.info({ workspace: workspaceId, outcome, contributions: extra.contributions ?? null }, 'contributor verification');
    return result;
  };

  if (!code) return { outcome: 'error', appName, roleName: null, login: null, explanation: 'GitHub sign-in was cancelled. Click Verify with GitHub in Discord again to retry.' };
  if (!repos.length || !settings.enabled || !tiers.length || !gh || gh.status !== 'active' || !deps.github || !deps.discord || !conn || conn.guild_id !== data.guildId) {
    return finish('error', 'Verification is not available right now. Please ask a server admin.', { info: 'Contributor settings, tiers, apps, GitHub or Discord connection changed during verification.' });
  }

  let user: { id: number; login: string };
  try {
    const userToken = await deps.github.exchangeOAuthCode(code, `${deps.config.publicUrl}/oauth/github/callback`);
    user = await deps.github.getAuthenticatedUser(userToken);
  } catch (err) {
    return finish('error', 'GitHub sign-in failed. Please try again from Discord.', { info: `GitHub sign-in failed: ${(err as Error).message}` });
  }
  const who = { login: user.login, githubUserId: user.id };

  // One GitHub account can only be linked to one Discord member in this workspace.
  const existing = await deps.db.query<{ discord_user_id: string }>(
    'SELECT discord_user_id FROM contributor_links WHERE workspace_id = $1 AND github_user_id = $2',
    [workspaceId, user.id],
  );
  if (existing.rows[0] && existing.rows[0].discord_user_id !== data.discordUserId) {
    return finish('conflict', `The GitHub account **${user.login}** is already linked to another member of this server. If this is a mistake, ask a server admin.`, { ...who, info: `Already linked to Discord user ${existing.rows[0].discord_user_id}.` });
  }

  // Per repository: merged PRs or direct commits, whichever is higher (a squash-merged PR is
  // usually also a commit). Then add up all repositories. Checked one repository at a time
  // to stay within GitHub's search rate limit; any failure aborts rather than under-counting.
  const perRepo: { repo: string; prs: number; commits: number; count: number }[] = [];
  try {
    for (const r of repos) {
      const [prs, commits] = await Promise.all([
        deps.github.countMergedPullRequests(gh.installation_id, r.owner, r.name, user.login),
        deps.github.countAuthoredCommits(gh.installation_id, r.owner, r.name, user.login),
      ]);
      perRepo.push({ repo: r.name, prs, commits, count: Math.max(prs, commits) });
    }
  } catch (err) {
    const status = err instanceof GitHubApiError ? err.status : null;
    const info = err instanceof GitHubApiError && err.isRateLimit
      ? 'GitHub rate limit reached while counting contributions.'
      : status === 403 || status === 404
        ? `GitHub refused the contribution check (${status}). The GitHub App needs "Pull requests: Read" and "Contents: Read" and access to every enabled app's repository.`
        : `Contribution check failed: ${(err as Error).message}`;
    return finish('error', 'We could not check your contributions right now. Please try again in a minute or ask a server admin.', { ...who, info });
  }
  const contributions = perRepo.reduce((sum, r) => sum + r.count, 0);
  const prTotal = perRepo.reduce((sum, r) => sum + (r.prs >= r.commits ? r.count : 0), 0);
  const method = contributions === 0 ? null : prTotal * 2 >= contributions ? 'merged_pr' : 'commit';
  const breakdown = perRepo.filter((r) => r.count > 0).map((r) => `${r.repo} ${r.count}`).join(', ');
  const counted = `${contributions} contribution${contributions === 1 ? '' : 's'}${breakdown ? ` (${breakdown})` : ''}`;
  const earned = [...tiers].reverse().find((t) => contributions >= t.min_contributions);
  const next = tiers.find((t) => contributions < t.min_contributions);
  const info = breakdown ? `Counted: ${breakdown}` : null;

  if (!earned) {
    return finish(
      'not_contributor',
      contributions === 0
        ? `We couldn't find a merged pull request or commit by **${user.login}** in any of our apps. If your pull request was just merged, wait a minute and try again. Commits only count when their email is linked to your GitHub account.`
        : `**${user.login}** has ${counted}. **${next!.role_name}** needs ${next!.min_contributions}.`,
      { ...who, method, contributions, info },
    );
  }

  // Claim the GitHub account for this member (race-safe), then add the role.
  const claimed = await withTransaction(deps.db, async (tx) => {
    await tx.query(
      `INSERT INTO contributor_links (workspace_id, github_user_id, github_login, discord_user_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, github_user_id) DO NOTHING`,
      [workspaceId, user.id, user.login, data.discordUserId],
    );
    const { rows } = await tx.query<{ discord_user_id: string }>('SELECT discord_user_id FROM contributor_links WHERE workspace_id = $1 AND github_user_id = $2', [workspaceId, user.id]);
    return rows[0]!.discord_user_id === data.discordUserId;
  });
  if (!claimed) {
    return finish('conflict', `The GitHub account **${user.login}** is already linked to another member of this server.`, { ...who, contributions, info });
  }

  try {
    await deps.discord.addMemberRole(data.guildId, data.discordUserId, earned.role_id, `Verified GitHub contributor ${user.login}: ${contributions} contributions`);
  } catch (err) {
    const code = err instanceof DiscordApiError ? err.code : null;
    const why = code === DiscordErrorCode.MissingPermissions || code === DiscordErrorCode.MissingAccess
      ? `Discord refused to add the role: the bot needs Manage Roles and its role must be above "${earned.role_name}".`
      : code === DiscordErrorCode.UnknownMember ? 'The member is no longer in the server.' : `Adding the role failed: ${(err as Error).message}`;
    if (!existing.rows[0]) await deps.db.query('DELETE FROM contributor_links WHERE workspace_id = $1 AND github_user_id = $2', [workspaceId, user.id]);
    return finish('error', 'You qualify, but the bot could not add the role. A server admin has been shown what to fix.', { ...who, method, contributions, roleName: earned.role_name, info: why });
  }
  // Moving up a tier replaces the lower tier roles (best effort; the member may not have them).
  for (const lower of tiers.filter((t) => t.min_contributions < earned.min_contributions)) {
    await deps.discord.removeMemberRole(data.guildId, data.discordUserId, lower.role_id, `Promoted to ${earned.role_name}`).catch(() => {});
  }

  return finish(
    'verified',
    `Thanks for contributing! **${user.login}** has ${counted}, so you now have the **${earned.role_name}** role.${next ? ` Reach ${next.min_contributions} for **${next.role_name}**.` : ''}`,
    { ...who, method, contributions, roleName: earned.role_name, info },
  );
}

// ---- Admin: history and revoke -------------------------------------------------------------------

export interface VerificationRow {
  id: string;
  app_name: string;
  repo_owner: string;
  repo_name: string;
  discord_user_id: string;
  discord_name: string;
  github_login: string | null;
  github_user_id: number | null;
  result: m.ContributorOutcome;
  method: 'merged_pr' | 'commit' | null;
  info: string | null;
  contributions: number | null;
  role_name: string | null;
  revoked_at: Date | null;
  created_at: Date;
}

export async function listVerifications(q: Queryable, workspaceId: string, limit = 100): Promise<VerificationRow[]> {
  const { rows } = await q.query<VerificationRow>(
    'SELECT * FROM contributor_verifications WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2',
    [workspaceId, limit],
  );
  return rows;
}

/** Removes the role and unlinks the GitHub account so it can be verified again. */
export async function revokeVerification(deps: Deps, workspaceId: string, verificationId: string, userId: string): Promise<void> {
  const { rows } = await deps.db.query<VerificationRow>('SELECT * FROM contributor_verifications WHERE workspace_id = $1 AND id = $2', [workspaceId, verificationId]);
  const v = rows[0];
  if (!v) throw new UserFacingError('Verification not found.', 404);
  if (v.result !== 'verified' || v.revoked_at) throw new UserFacingError('Only active verifications can be revoked.');
  const tiers = await listTiers(deps.db, workspaceId);
  const conn = await getDiscordConnection(deps.db, workspaceId);
  if (deps.discord && conn) {
    for (const tier of tiers) {
      try {
        await deps.discord.removeMemberRole(conn.guild_id, v.discord_user_id, tier.role_id, 'Contributor verification revoked by an admin');
      } catch (err) {
        if (err instanceof DiscordApiError && err.code === DiscordErrorCode.UnknownMember) break;
        throw new UserFacingError(`Discord did not let the bot remove @${tier.role_name}. Check that it has Manage Roles and sits above the role.`);
      }
    }
  }
  await deps.db.query('UPDATE contributor_verifications SET revoked_at = now_ms(), revoked_by = $3 WHERE workspace_id = $1 AND id = $2', [workspaceId, verificationId, userId]);
  if (v.github_user_id !== null) {
    await deps.db.query('DELETE FROM contributor_links WHERE workspace_id = $1 AND github_user_id = $2 AND discord_user_id = $3', [workspaceId, v.github_user_id, v.discord_user_id]);
  }
}
