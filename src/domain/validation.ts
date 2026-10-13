import { GitHubApiError } from '../github/client.js';
import { inspectGuild } from './discord-checks.js';
import { checkPanel } from './panel.js';
import { getDiscordConnection, getGitHubConnection, listApps, refreshAppRepo, setDiscordStatus, setGitHubStatus } from './store.js';
import type { Deps } from './types.js';

export interface Check {
  area: 'deployment' | 'github' | 'discord' | 'apps' | 'panel';
  status: 'ok' | 'warning' | 'error';
  title: string;
  detail?: string;
  fix?: { label: string; href: string };
}

export interface ValidationReport {
  checks: Check[];
  canPublish: boolean;
}

/**
 * Runs every check needed before tickets can flow: GitHub installation and repository
 * access (Issues enabled, not archived, labels present), Discord bot membership and
 * channel permissions, and panel state. Updates stored connection status as a side effect.
 */
export async function validateWorkspace(deps: Deps, workspaceId: string, base: string): Promise<ValidationReport> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  if (!deps.github) add({ area: 'deployment', status: 'error', title: 'GitHub App credentials are not configured on this deployment', detail: `Missing: ${deps.config.missing.github.join(', ')}`, fix: { label: 'Deployment', href: `${base}/deployment` } });
  if (!deps.discord) add({ area: 'deployment', status: 'error', title: 'Discord application credentials are not configured on this deployment', detail: `Missing: ${deps.config.missing.discord.join(', ')}`, fix: { label: 'Deployment', href: `${base}/deployment` } });

  // ---- GitHub
  const gh = await getGitHubConnection(deps.db, workspaceId);
  let githubOk = false;
  if (!gh) {
    add({ area: 'github', status: 'error', title: 'GitHub is not connected', fix: { label: 'Connect GitHub', href: `${base}/setup/github` } });
  } else if (deps.github) {
    try {
      const inst = await deps.github.getInstallation(gh.installation_id);
      if (inst.suspended) {
        await setGitHubStatus(deps.db, workspaceId, 'suspended', 'The installation is suspended in GitHub.');
        add({ area: 'github', status: 'error', title: `The GitHub App installation on ${inst.accountLogin} is suspended`, detail: 'Unsuspend it from the GitHub installation settings.', fix: { label: 'GitHub settings', href: `${base}/setup/github` } });
      } else {
        await deps.github.installationToken(gh.installation_id);
        if (gh.status !== 'active') await setGitHubStatus(deps.db, workspaceId, 'active', null);
        githubOk = true;
        add({ area: 'github', status: 'ok', title: `Connected to GitHub as ${inst.accountLogin}` });
      }
    } catch (err) {
      const removed = err instanceof GitHubApiError && err.status === 404;
      await setGitHubStatus(deps.db, workspaceId, removed ? 'removed' : 'error', removed ? 'The GitHub App was uninstalled.' : 'GitHub could not be reached.');
      add({ area: 'github', status: 'error', title: removed ? 'The GitHub App is no longer installed' : 'Could not reach GitHub', fix: { label: 'Reconnect GitHub', href: `${base}/setup/github` } });
    }
  }

  // ---- Discord
  const dc = await getDiscordConnection(deps.db, workspaceId);
  let discordOk = false;
  if (!dc) {
    add({ area: 'discord', status: 'error', title: 'No Discord server connected', fix: { label: 'Connect Discord', href: `${base}/setup/discord` } });
  } else if (deps.discord) {
    const access = await inspectGuild(deps.discord, dc.guild_id);
    if (!access.ok) {
      if (access.reason === 'bot_not_in_guild') await setDiscordStatus(deps.db, workspaceId, 'removed', access.message);
      add({ area: 'discord', status: 'error', title: access.message, fix: { label: 'Reconnect Discord', href: `${base}/setup/discord` } });
    } else {
      if (dc.status !== 'active') await setDiscordStatus(deps.db, workspaceId, 'active', null);
      add({ area: 'discord', status: 'ok', title: `Bot is in the “${access.guild.name}” server` });
      if (!dc.tickets_channel_id) {
        add({ area: 'discord', status: 'error', title: 'No tickets channel selected', fix: { label: 'Choose channel', href: `${base}/tickets/panel#channel` } });
      } else {
        const channel = access.channels.find((c) => c.id === dc.tickets_channel_id);
        if (!channel) {
          add({ area: 'discord', status: 'error', title: `The #${dc.tickets_channel_name ?? 'tickets'} channel no longer exists or is hidden from the bot`, fix: { label: 'Choose channel', href: `${base}/tickets/panel#channel` } });
        } else if (channel.missing.length) {
          add({ area: 'discord', status: 'error', title: `The bot is missing permissions in #${channel.name}`, detail: `Missing: ${channel.missing.join(', ')}. Grant them to the bot's role in the channel settings.`, fix: { label: 'Check again', href: `${base}/tickets/panel` } });
        } else {
          discordOk = true;
          add({ area: 'discord', status: 'ok', title: `The bot can post in #${channel.name}` });
        }
      }
    }
  }

  // ---- Apps
  const apps = await listApps(deps.db, workspaceId);
  const enabled = apps.filter((a) => a.enabled);
  if (!enabled.length) {
    add({ area: 'apps', status: 'error', title: apps.length ? 'All apps are disabled' : 'No apps configured yet', fix: { label: 'Configure apps', href: `${base}/apps` } });
  }
  let appsOk = enabled.length > 0;
  if (githubOk && gh && deps.github) {
    const labelCache = new Map<number, Set<string>>();
    for (const app of enabled) {
      const edit = { label: 'Edit app', href: `${base}/apps/${app.id}/edit` };
      try {
        const repo = await deps.github.getRepoById(gh.installation_id, app.repo_id);
        await refreshAppRepo(deps.db, workspaceId, repo);
        if (repo.archived) {
          appsOk = false;
          add({ area: 'apps', status: 'error', title: `${app.name}: ${repo.fullName} is archived`, detail: 'Archived repositories do not accept new issues.', fix: edit });
          continue;
        }
        if (!repo.hasIssues) {
          appsOk = false;
          add({ area: 'apps', status: 'error', title: `${app.name}: Issues are disabled in ${repo.fullName}`, detail: 'Enable Issues in the repository settings on GitHub, then check again.', fix: edit });
          continue;
        }
        if (app.labels.length) {
          let labels = labelCache.get(repo.id);
          if (!labels) {
            labels = new Set(await deps.github.listLabels(gh.installation_id, repo.owner, repo.name));
            labelCache.set(repo.id, labels);
          }
          const missing = app.labels.filter((l) => !labels!.has(l));
          if (missing.length) {
            add({ area: 'apps', status: 'warning', title: `${app.name}: label${missing.length > 1 ? 's' : ''} ${missing.join(', ')} no longer exist${missing.length > 1 ? '' : 's'} in ${repo.fullName}`, detail: 'Tickets will be filed without them.', fix: edit });
            continue;
          }
        }
        add({ area: 'apps', status: 'ok', title: `${app.name} → ${repo.fullName} (${repo.private ? 'private' : 'public'})` });
      } catch (err) {
        appsOk = false;
        const notFound = err instanceof GitHubApiError && (err.status === 404 || err.status === 403);
        add({
          area: 'apps',
          status: 'error',
          title: notFound ? `${app.name}: the GitHub App can no longer access ${app.repo_owner}/${app.repo_name}` : `${app.name}: could not check ${app.repo_owner}/${app.repo_name}`,
          detail: notFound ? 'Grant the app access to this repository in GitHub, or map the app to another repository.' : 'GitHub could not be reached. Try again.',
          fix: edit,
        });
      }
    }
  }

  // ---- Panel
  if (discordOk) {
    const panel = await checkPanel(deps, workspaceId);
    if (panel.state === 'not_published') add({ area: 'panel', status: 'warning', title: 'The ticket panel has not been published yet' });
    else if (panel.state === 'missing') add({ area: 'panel', status: 'warning', title: 'The ticket panel was deleted from Discord', detail: 'Publish it again to restore it.' });
    else if (panel.state === 'unknown') add({ area: 'panel', status: 'warning', title: panel.error });
    else if (panel.channelChanged) add({ area: 'panel', status: 'warning', title: 'The panel is in a different channel than the selected tickets channel', detail: 'Publishing moves it to the new channel.' });
    else if (panel.outdated) add({ area: 'panel', status: 'warning', title: 'The published panel is out of date', detail: 'Your app list or panel text changed. Update the panel to show the changes.' });
    else add({ area: 'panel', status: 'ok', title: 'The ticket panel is published and up to date' });
  }

  return { checks, canPublish: githubOk && discordOk && appsOk && Boolean(deps.github && deps.discord) };
}
