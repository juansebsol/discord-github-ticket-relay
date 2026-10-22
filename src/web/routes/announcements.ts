/**
 * Announcements: each app's new GitHub releases posted in Discord. Posts lists the releases (the
 * ones waiting to be posted first) and each one has its own page to check the notes, edit them and
 * post; Settings chooses review first or automatic, the channel, the notes, the message and pings;
 * Pings panel posts the message members use to get (or drop) the ping roles.
 */
import type { FastifyInstance } from 'fastify';
import {
  announceManually,
  CHECK_MS,
  deletePost,
  postNow,
  readReleases,
  rewriteNotes,
  updatePost,
  viewOf,
  type GitHubRelease,
} from '../../announcements/announcer.js';
import { announcementPayload, downloadLinks, EMPTY_NOTES, githubNotes, NOTES_MAX, templates, varsFor, type ReleaseView } from '../../announcements/message.js';
import { checkPingPanel, publishPingPanel, unpublishPingPanel, workspacePingRoles, type PingRole } from '../../announcements/pings.js';
import {
  announcedRepos,
  appAnnounceSettings,
  APP_DEFAULTS,
  getAnnouncement,
  getAnnouncementSettings,
  INSTRUCTIONS_MAX,
  listAnnouncements,
  PANEL_DEFAULTS,
  PANEL_LIMITS,
  PLACEHOLDERS,
  saveAnnouncementSettings,
  saveAppAnnounceSettings,
  targetFor,
  TEMPLATE_DEFAULTS,
  TEMPLATE_LIMITS,
  type AnnouncementRow,
  type AnnouncementSettings,
  type AnnouncementStatus,
  type AppAnnounceSettings,
  type RoleMode,
} from '../../announcements/settings.js';
import { resolveClaudeKey } from '../../domain/claude-key.js';
import { inspectRoles, type RoleInspection } from '../../domain/contributors.js';
import { inspectGuild, type GuildAccess } from '../../domain/discord-checks.js';
import { can } from '../../domain/permissions.js';
import { getDiscordConnection, getGitHubConnection, listApps } from '../../domain/store.js';
import { UserFacingError, type AppRow } from '../../domain/types.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { botIdentity, botMessage, discordMd, previewCaption, type BotIdentity } from '../discord-preview.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import {
  choices,
  csrfField,
  empty,
  icon,
  linkBtn,
  pageHeader,
  pill,
  plural,
  segLinks,
  selectWrap,
  setting,
  submitBtn,
  switchInput,
  tag,
  timeAgo,
  viewOnlyTag,
  when,
  type Tone,
} from '../ui.js';
import { checklist, textField } from './panel.js';
import { areaHref, canOpen, landOn, pageLink, toolHeader, toolHref, viewOnlyText } from './tool.js';
import { viewOnlyFooter } from './triage.js';

type Check = { status: 'ok' | 'warning' | 'error'; title: string; detail?: string; fix?: { label: string; href: string } };

const STATUS: Record<AnnouncementStatus, { label: string; tone: Tone }> = {
  writing: { label: 'Writing notes', tone: 'neutral' },
  waiting: { label: 'Waiting to post', tone: 'warn' },
  posting: { label: 'Posting', tone: 'neutral' },
  posted: { label: 'Posted', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'closed' },
};
const NOTES_BY: Record<string, string> = { claude: 'Claude', github: 'GitHub', edited: 'Edited' };

const SHOWS = [
  { key: 'all', label: 'All', statuses: null },
  { key: 'waiting', label: 'To post', statuses: ['writing', 'waiting', 'posting', 'failed'] },
  { key: 'posted', label: 'Posted', statuses: ['posted'] },
  { key: 'skipped', label: 'Skipped', statuses: ['skipped'] },
] as const;

const SAMPLE_NOTES = '- **Faster exports**: big projects save in half the time\n- You can now pick where new files are saved\n- Several crash fixes';

/** JSON for app.js (role id → name), safe to embed in a non-executed script element. */
function roleNamesJson(names: Map<string, string>): SafeHtml {
  return raw(`<script type="application/json" id="role-names">${JSON.stringify(Object.fromEntries(names)).replace(/</g, '\\u003c')}</script>`);
}

/** Data for a non-executed attribute, read by app.js. */
const json = (v: unknown) => JSON.stringify(v);

/**
 * An announcement as members will see it. The template parts carry their template and the values
 * (data-tpl, data-tpl-vars) so app.js redraws them while the fields are edited.
 */
function announcementPreview(bot: BotIdentity, r: ReleaseView, s: Pick<AnnouncementSettings, 'messageText' | 'titleText' | 'bodyText' | 'downloadButtons'>, roleId: string | null, roleNames: Map<string, string>): SafeHtml {
  const t = templates(s);
  const vars = varsFor(r, roleId);
  const payload = announcementPayload(r, s, roleId);
  const embed = payload.embeds[0]!;
  const downloads = downloadLinks(r.files);
  const button = (label: string) => html`<span class="dp-button grey">${label}${icon('arrow-up-right', 14)}</span>`;
  return html`<div data-tpl-vars="${json(vars)}">${botMessage(bot, html`
    <div class="dp-content" id="pv-message" data-tpl="${t.message}" ${payload.content ? '' : raw('hidden')}>${discordMd(payload.content, roleNames)}</div>
    <div class="dp-embed">
      <h4 id="pv-title" data-tpl="${t.title}" data-tpl-plain ${'title' in embed ? '' : raw('hidden')}><span class="dp-a">${'title' in embed ? embed.title : ''}</span></h4>
      <p id="pv-body" data-tpl="${t.body}">${discordMd('description' in embed ? String(embed.description) : '', roleNames)}</p>
      ${r.publishedAt ? html`<div class="dp-time">${r.publishedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</div>` : ''}
    </div>
    <div class="dp-buttons">${downloads.length ? html`<span id="pv-downloads" class="dp-buttons-in" ${s.downloadButtons ? '' : raw('hidden')}>${downloads.map((d) => button(d.label))}</span>` : ''}${button('Release notes')}</div>`, 'Preview of the announcement in Discord')}</div>`;
}

/**
 * The newest release announced (or a sample) to preview the settings with: one of an app that
 * uses the workspace's channel and role when there is one, so the preview follows those fields.
 */
function sampleRelease(rows: AnnouncementRow[], apps: AppRow[], appSettings: Map<string, AppAnnounceSettings>): ReleaseView & { appId: string | null } {
  const ready = rows.filter((r) => r.status !== 'writing');
  const plain = (appId: string | null) => !appId || (appSettings.get(appId)?.roleMode ?? 'default') === 'default';
  const latest = ready.find((r) => plain(r.app_id)) ?? ready[0];
  if (latest) return { ...viewOf(latest), appId: latest.app_id };
  const app = apps.find((a) => plain(a.id)) ?? apps[0];
  return {
    appId: app?.id ?? null,
    appName: app?.name ?? 'PhotoCraft', tag: 'v1.2.0', releaseName: null,
    releaseUrl: app ? `https://github.com/${app.repo_owner}/${app.repo_name}/releases` : 'https://github.com',
    publishedAt: new Date(), notes: SAMPLE_NOTES,
    files: [{ name: 'app-1.2.0-windows-x64.msi', url: 'https://github.com' }, { name: 'app-1.2.0-macos-universal.dmg', url: 'https://github.com' }, { name: 'app-1.2.0-linux-x86_64.AppImage', url: 'https://github.com' }],
  };
}

export function registerAnnouncementRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const base = (ctx: WorkspaceRequestContext) => `${ctx.base}/announcements`;

  // ---- Posts ------------------------------------------------------------------------------------

  function postsTable(ctx: WorkspaceRequestContext, rows: AnnouncementRow[]): SafeHtml {
    const b = base(ctx);
    return html`<div class="table-wrap"><table>
      <thead><tr><th class="col-main">Release</th><th>Status</th><th>Notes</th><th class="num">Released</th></tr></thead>
      <tbody>${rows.map((r) => {
        const st = STATUS[r.status];
        const sub = r.status === 'posted' && r.posted_at ? `${r.posted_by_name ? `Posted by ${r.posted_by_name}` : 'Posted automatically'} ${timeAgo(r.posted_at)}` : r.status === 'failed' ? r.error : r.status === 'writing' ? 'Claude is writing the notes…' : null;
        return html`<tr>
          <td><a class="cell-title" href="${b}/${r.id}"><span>${r.app_name}</span> <span class="mono">${r.tag}</span></a>
            ${r.prerelease ? html` ${tag('Pre-release')}` : ''}${r.manual ? html` ${tag('Added by hand', { title: 'Someone announced this release from Posts › Announce a release' })}` : ''}
            ${r.release_name && r.release_name !== r.tag ? html`<div class="sub truncate">${r.release_name}</div>` : ''}</td>
          <td>${pill(st.label, st.tone)}${sub ? html`<div class="sub">${sub}</div>` : ''}</td>
          <td>${r.notes_by ? html`<span class="small">${NOTES_BY[r.notes_by] ?? r.notes_by}</span>${r.notes_error ? html` <span title="${r.notes_error}">${icon('triangle-alert', 14, 'warn')}</span>` : ''}` : html`<span class="em">—</span>`}</td>
          <td class="num">${when(r.published_at ?? r.created_at)}</td>
        </tr>`;
      })}</tbody></table></div>`;
  }

  app.get('/w/:wid/announcements', async (req, reply) => {
    const ctx = await landOn(web, req, reply, 'announcements');
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = base(ctx);
    const q = req.query as { show?: string; partial?: string };
    const edit = can(ctx.membership, 'announcements.edit');
    const [s, all] = await Promise.all([getAnnouncementSettings(deps.db, wid), listAnnouncements(deps.db, wid)]);
    const counts = Object.fromEntries(SHOWS.map((f) => [f.key, f.statuses ? all.filter((r) => (f.statuses as readonly string[]).includes(r.status)).length : all.length]));
    const show = SHOWS.find((f) => f.key === q.show) ?? SHOWS[0];
    const rows = show.statuses ? all.filter((r) => (show.statuses as readonly string[]).includes(r.status)) : all;
    const busy = all.some((r) => r.status === 'writing' || r.status === 'posting');
    const list = rows.length ? postsTable(ctx, rows) : html`<div class="card-b"><p class="small muted">Nothing here.</p></div>`;
    if (q.partial === '1') return reply.header('x-live-partial', '1').header('Cache-Control', 'no-store').type('text/html').send(html`${list}${busy ? '' : raw('<span data-live-reload hidden></span>')}`.toString());

    const settingsLink = pageLink(ctx, 'announcement-settings', 'Settings');
    const body = html`
      ${await toolHeader(web, ctx, 'announcements', 'announcements', { actions: edit ? linkBtn(`${b}/new`, 'Announce a release', { variant: s.enabled ? 'primary' : undefined, icon: 'plus' }) : null })}
      ${!s.enabled ? noticeOff(ctx) : ''}
      ${all.length
        ? html`<div class="card">
            <div class="card-h"><div class="row">${segLinks('Show', SHOWS.map((f) => ({ href: f.key === 'all' ? b : `${b}?show=${f.key}`, label: f.label, count: counts[f.key], current: f.key === show.key })))}</div>
              <span class="small muted">${s.enabled ? `${s.mode === 'auto' ? 'Automatic: posted as soon as the notes are written' : 'Review first: new releases wait here until someone posts them'}. Checked every ${CHECK_MS / 60_000} minutes.` : ''}</span></div>
            <div class="card-b flush" ${busy ? html`data-live="5000" data-live-src="${`${b}?${new URLSearchParams({ partial: '1', ...(show.key !== 'all' ? { show: show.key } : {}) }).toString()}`}"` : ''}>${list}</div>
          </div>`
        : html`<div class="card">${s.enabled
          ? empty('megaphone', 'No releases yet', html`New releases show up here within ${CHECK_MS / 60_000} minutes of being published on GitHub. To try it now, announce one of the latest releases by hand.`, edit ? linkBtn(`${b}/new`, 'Announce a release', { icon: 'plus' }) : null)
          : empty('megaphone', 'Announcements are off', html`Turn them on in ${settingsLink} to post each app’s new GitHub releases in Discord.`, can(ctx.membership, 'announcement-settings.edit') ? linkBtn(areaHref(ctx, 'announcement-settings'), 'Set up announcements', { variant: 'primary' }) : null)}</div>`}`;
    return web.render(reply, ctx, 'Announcements', 'announcements', body, { width: 'full' });
  });

  function noticeOff(ctx: WorkspaceRequestContext): SafeHtml {
    return html`<div class="notice info" role="status">${icon('info')}<div><div class="n-title">Announcements are off</div><div class="n-text">New releases aren’t checked or posted. You can still announce a release by hand.${can(ctx.membership, 'announcement-settings.edit') ? html` Turn them on in ${pageLink(ctx, 'announcement-settings', 'Settings')}.` : ''}</div></div><span></span></div>`;
  }

  // ---- Announce a release by hand ---------------------------------------------------------------------

  app.get('/w/:wid/announcements/new', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'announcements.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = base(ctx);
    const apps = (await listApps(deps.db, wid)).sort((x, y) => x.position - y.position);
    const appId = (req.query as { app?: string }).app ?? apps[0]?.id;
    const chosen = apps.find((a) => a.id === appId);
    const gh = await getGitHubConnection(deps.db, wid);
    let releases: GitHubRelease[] = [];
    let problem: string | null = null;
    if (!gh || gh.status !== 'active' || !deps.github) problem = 'Connect GitHub first.';
    else if (chosen) {
      try {
        releases = (await readReleases(deps.github, gh.installation_id, chosen.repo_owner, chosen.repo_name, 10)).filter((r) => !r.draft);
      } catch {
        problem = `Couldn’t read ${chosen.repo_owner}/${chosen.repo_name}’s releases from GitHub. Try again in a moment.`;
      }
    }
    const known = new Map((await listAnnouncements(deps.db, wid, 500)).filter((r) => chosen && r.repo_id === chosen.repo_id).map((r) => [r.tag, r]));
    const body = html`
      ${pageHeader({
        crumbs: [{ href: toolHref(ctx, 'announcements') ?? undefined, label: 'Announcements' }, { label: 'Announce a release' }],
        title: 'Announce a release',
        description: 'Pick one of an app’s latest releases. Its notes are written as usual, then it waits under Posts for you to check and post it.',
      })}
      <div class="card">
        <form method="get" action="${b}/new" class="card-h"><div class="row"><label class="small muted" for="ann-app">App</label>
          ${selectWrap(html`<select id="ann-app" name="app" data-autosubmit>${apps.map((a) => html`<option value="${a.id}" ${a.id === chosen?.id ? raw('selected') : ''}>${a.name} · ${a.repo_owner}/${a.repo_name}</option>`)}</select>`, { sm: true })}
          <noscript><button class="btn sm" type="submit">Show releases</button></noscript></div></form>
        ${!apps.length
          ? html`<div class="card-b"><p class="small muted">Add an app first on ${pageLink(ctx, 'apps', 'Apps & repositories')}.</p></div>`
          : problem
            ? html`<div class="card-b"><p class="small muted">${problem}</p></div>`
            : releases.length
              ? html`<form method="post" action="${b}/new">${csrfField(ctx.csrf)}<input type="hidden" name="app" value="${chosen!.id}">
                  <div class="card-b"><div class="choices" role="radiogroup" aria-label="Release">${releases.map((r, i) => {
                    const had = known.get(r.tag);
                    return html`<label class="choice"><input type="radio" name="tag" value="${r.tag}" ${i === 0 ? raw('checked') : ''}><span><span class="t"><span class="mono">${r.tag}</span>${r.name && r.name !== r.tag ? ` · ${r.name}` : ''}${r.prerelease ? html` ${tag('Pre-release')}` : ''}</span>
                      <span class="d">${r.publishedAt ? `Published ${timeAgo(r.publishedAt)}` : 'Not published'}${had ? ` · ${STATUS[had.status].label.toLowerCase()} already` : ''}</span></span></label>`;
                  })}</div></div>
                  <div class="card-f"><span></span><div class="end">${linkBtn(b, 'Cancel')}${submitBtn('Add release', { variant: 'primary', loading: 'Adding…' })}</div></div></form>`
              : html`<div class="card-b"><p class="small muted">${chosen ? `${chosen.repo_owner}/${chosen.repo_name} has no published releases.` : ''}</p></div>`}
      </div>`;
    return web.render(reply, ctx, 'Announce a release', 'announcements', body);
  });

  app.post('/w/:wid/announcements/new', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'announcements.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const body = req.body as { app?: string; tag?: string };
    try {
      const chosen = (await listApps(deps.db, wid)).find((a) => a.id === body.app);
      const gh = await getGitHubConnection(deps.db, wid);
      if (!chosen) throw new UserFacingError('Choose one of your apps.');
      if (!gh || gh.status !== 'active') throw new UserFacingError('Connect GitHub first.');
      if (!body.tag) throw new UserFacingError('Choose a release.');
      const id = await announceManually(deps, wid, gh.installation_id, chosen, body.tag);
      const row = await getAnnouncement(deps.db, wid, id);
      setFlash(reply, 'success', row?.status === 'writing' ? 'Release added. Its notes are being written; this page updates when they’re ready.' : 'This release was already here.');
      return reply.redirect(`${base(ctx)}/${id}`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
      return reply.redirect(`${base(ctx)}/new${body.app ? `?app=${encodeURIComponent(body.app)}` : ''}`);
    }
  });

  // ---- One announcement ---------------------------------------------------------------------------

  app.get('/w/:wid/announcements/:id', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'announcements.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = base(ctx);
    const row = await getAnnouncement(deps.db, wid, (req.params as { id: string }).id);
    if (!row) return reply.callNotFound();
    const busy = row.status === 'writing' || row.status === 'posting';
    if ((req.query as { partial?: string }).partial === '1') {
      return reply.header('x-live-partial', '1').header('Cache-Control', 'no-store').type('text/html').send((busy ? html`${statusLine(row)}` : html`${statusLine(row)}<span data-live-reload hidden></span>`).toString());
    }
    const edit = can(ctx.membership, 'announcements.edit');
    const [s, appSettings, conn, bot] = await Promise.all([getAnnouncementSettings(deps.db, wid), appAnnounceSettings(deps.db, wid), getDiscordConnection(deps.db, wid), botIdentity(deps)]);
    const target = targetFor(s, row.app_id ? appSettings.get(row.app_id) : undefined);
    const posted = row.status === 'posted';
    const channelName = posted ? (row.channel_id === target.channelId ? target.channelName : null) : target.channelName;
    const link = posted && conn && row.channel_id && row.message_id ? `https://discord.com/channels/${conn.guild_id}/${row.channel_id}/${row.message_id}` : null;
    const view = viewOf(row);
    const roleNames = new Map(target.roleId ? [[target.roleId, target.roleName ?? 'role']] : []);
    const notesValue = row.notes ?? '';
    const canEditNotes = edit && !busy;

    const notesField = html`<div class="field"><div class="field-head"><label for="notes">Release notes</label><span class="counter" data-counter-for="notes">${String(notesValue.length)} / ${String(NOTES_MAX)}</span></div>
      <textarea id="notes" name="notes" rows="10" maxlength="${String(NOTES_MAX)}" data-tpl-var="notes" placeholder="${row.status === 'writing' ? 'Claude is writing the notes…' : EMPTY_NOTES}" ${canEditNotes ? '' : raw('readonly')}>${notesValue}</textarea>
      <div class="hint">Shown where the message has {notes}. Discord formatting works: **bold**, - list, ## heading.${row.notes_by ? ` Written by ${row.notes_by === 'claude' ? 'Claude' : row.notes_by === 'github' ? 'GitHub (as written)' : 'hand'}.` : ''}</div></div>`;
    const actions = (() => {
      if (!edit) return html`${viewOnlyFooter('announcements')}`;
      const left = html`<div class="row">${row.status !== 'posted' && !busy ? html`
          <button type="submit" class="btn ghost" name="intent" value="rewrite" data-loading-text="Asking Claude…"><span class="lead">${icon('sparkles')}</span><span class="lbl">Rewrite with Claude</span></button>
          <button type="submit" class="btn ghost" name="intent" value="github"><span class="lead">${icon('github')}</span><span class="lbl">Use GitHub’s notes</span></button>` : ''}</div>`;
      const right = row.status === 'waiting' || row.status === 'failed'
        ? html`<button type="submit" class="btn ghost" name="intent" value="skip">Skip</button>
            <button type="submit" class="btn ghost" name="intent" value="save" data-dirty-enable>Save notes</button>
            ${submitBtn(row.status === 'failed' ? 'Try again' : 'Post now', { variant: 'primary', icon: 'send', loading: 'Posting…', name: 'intent', value: 'post', disabled: !target.channelId, title: target.channelId ? undefined : 'Choose a channel in Settings first' })}`
        : posted
          ? html`<button type="submit" class="btn ghost danger" form="ann-delete"><span class="lead">${icon('trash-2')}</span><span class="lbl">Delete from Discord</span></button>
              ${submitBtn('Update in Discord', { variant: 'primary', icon: 'refresh-cw', loading: 'Updating…', name: 'intent', value: 'update' })}`
          : row.status === 'skipped'
            ? html`<button type="submit" class="btn ghost" name="intent" value="save" data-dirty-enable>Save notes</button>${submitBtn('Move back to waiting', { variant: 'primary', name: 'intent', value: 'unskip' })}`
            : html`<span class="small muted">${row.status === 'writing' ? 'Waiting for the notes…' : 'Posting…'}</span>`;
      return html`${left}<div class="end">${right}</div>`;
    })();

    const facts = html`<dl class="props">
      <dt>Release</dt><dd><a href="${row.release_url}" target="_blank" rel="noopener noreferrer" class="mono">${row.repo_owner}/${row.repo_name}@${row.tag}</a>${row.prerelease ? tag('Pre-release') : ''}</dd>
      <dt>Published</dt><dd>${row.published_at ? when(row.published_at) : html`<span class="em">—</span>`}</dd>
      <dt>Channel</dt><dd>${channelName ? `#${channelName}` : html`<span class="em">None chosen</span>`}</dd>
      <dt>Ping</dt><dd>${target.roleId ? tag(`@${target.roleName ?? 'role'}`, { cls: 'role' }) : html`<span class="em">${s.pingEnabled ? 'No ping for this app' : 'Off'}</span>`}</dd>
    </dl>`;

    const body = html`
      ${pageHeader({
        crumbs: [{ href: toolHref(ctx, 'announcements') ?? undefined, label: 'Announcements' }, { label: `${row.app_name} ${row.tag}` }],
        title: html`${row.app_name} <span class="mono">${row.tag}</span>`,
        after: [pill(STATUS[row.status].label, STATUS[row.status].tone), edit ? '' : viewOnlyTag(viewOnlyText('announcements'))],
        description: row.release_name && row.release_name !== row.tag ? row.release_name : undefined,
      })}
      ${roleNamesJson(roleNames)}
      <div class="panel-grid">
        <div class="stack gap-16">
          <form method="post" action="${b}/${row.id}" class="card" ${canEditNotes ? raw('data-dirty') : ''}>
            ${csrfField(ctx.csrf)}
            <div class="card-h strip" ${busy ? html`data-live="3000" data-live-src="${`${b}/${row.id}?partial=1`}"` : ''}>${statusLine(row)}</div>
            ${row.notes_error ? html`<div class="card-b tight">${html`<div class="notice warn" role="status">${icon('triangle-alert')}<div><div class="n-text">${row.notes_error}</div></div><span></span></div>`}</div>` : ''}
            <div class="card-b"><div class="fields">${notesField}</div></div>
            <details class="card-b tight ann-gh" id="ann-gh"><summary class="small">Release notes as written on GitHub</summary><pre class="ann-gh-notes">${row.github_notes || '(empty)'}</pre></details>
            <div class="card-f">${actions}</div>
          </form>
          <div class="card">${facts}</div>
        </div>
        <div class="panel-preview">
          ${previewCaption(channelName, link)}
          ${announcementPreview(bot, view, s, target.roleId, roleNames)}
          <p class="dp-note">${target.roleId ? `Pings @${target.roleName ?? 'role'} only. ` : 'No one is pinged. '}Message, title and buttons follow ${pageLink(ctx, 'announcement-settings', 'Settings')}.</p>
        </div>
      </div>
      ${edit && posted ? html`<form method="post" action="${b}/${row.id}" id="ann-delete" hidden data-confirm-title="Delete this post from Discord?" data-confirm-body="The announcement goes back to waiting, so you can post it again." data-confirm-label="Delete post" data-confirm-danger>${csrfField(ctx.csrf)}<input type="hidden" name="intent" value="delete"></form>` : ''}`;
    return web.render(reply, ctx, `${row.app_name} ${row.tag} · Announcements`, 'announcements', body);
  });

  function statusLine(row: AnnouncementRow): SafeHtml {
    const st = STATUS[row.status];
    const text = row.status === 'writing' ? (row.attempts ? 'Claude was busy; trying again shortly…' : 'Claude is writing friendlier notes from GitHub’s…')
      : row.status === 'waiting' ? 'Check the notes, then post it.'
        : row.status === 'posting' ? 'Posting in Discord…'
          : row.status === 'posted' && row.posted_at ? `${row.posted_by_name ? `Posted by ${row.posted_by_name}` : 'Posted automatically'} ${timeAgo(row.posted_at)}.`
            : row.status === 'failed' ? row.error ?? 'Discord didn’t take the post.'
              : 'Skipped: it won’t be posted.';
    return html`<div class="row">${row.status === 'writing' || row.status === 'posting' ? icon('loader-circle', 16, 'muted ann-spin') : ''}${pill(st.label, st.tone)}<span class="small muted">${text}</span></div>`;
  }

  app.post('/w/:wid/announcements/:id', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'announcements.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { intent?: string; notes?: string };
    const back = `${base(ctx)}/${id}`;
    try {
      let row = await getAnnouncement(deps.db, wid, id);
      if (!row) return reply.callNotFound();
      const intent = body.intent ?? 'save';
      // Edited notes are kept first, whatever comes next.
      if (body.notes !== undefined && ['save', 'post', 'update', 'unskip'].includes(intent) && row.status !== 'writing' && row.status !== 'posting') {
        const notes = body.notes.replace(/\r\n/g, '\n').trim().slice(0, NOTES_MAX);
        if (notes !== (row.notes ?? '')) {
          await deps.db.query(`UPDATE announcements SET notes = $2, notes_by = 'edited', updated_at = now_ms() WHERE id = $1`, [id, notes || null]);
          row = (await getAnnouncement(deps.db, wid, id))!;
        }
      }
      if (intent === 'post') {
        await postNow(deps, wid, id, ctx.user.id);
        setFlash(reply, 'success', 'Posted in Discord');
      } else if (intent === 'update') {
        await updatePost(deps, row);
        setFlash(reply, 'success', 'Post updated in Discord. No one was pinged again.');
      } else if (intent === 'delete') {
        await deletePost(deps, row);
        setFlash(reply, 'success', 'Post deleted from Discord. It’s waiting to be posted again.');
      } else if (intent === 'skip') {
        await deps.db.query(`UPDATE announcements SET status = 'skipped', updated_at = now_ms() WHERE id = $1 AND status IN ('waiting', 'failed')`, [id]);
        setFlash(reply, 'success', 'Skipped. It won’t be posted.');
      } else if (intent === 'unskip') {
        await deps.db.query(`UPDATE announcements SET status = 'waiting', updated_at = now_ms() WHERE id = $1 AND status = 'skipped'`, [id]);
        setFlash(reply, 'success', 'Moved back to waiting');
      } else if (intent === 'rewrite') {
        await rewriteNotes(deps.db, wid, id);
        setFlash(reply, 'success', 'Claude is writing the notes again. This page updates when they’re ready.');
      } else if (intent === 'github') {
        if (row.status === 'writing' || row.status === 'posting' || row.status === 'posted') throw new UserFacingError('The notes can’t be changed right now.');
        await deps.db.query(`UPDATE announcements SET notes = $2, notes_by = 'github', notes_error = NULL, updated_at = now_ms() WHERE id = $1`, [id, githubNotes(row.github_notes) || EMPTY_NOTES]);
        setFlash(reply, 'success', 'Using GitHub’s notes, trimmed to fit Discord');
      } else {
        setFlash(reply, 'success', 'Notes saved');
      }
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(back);
  });

  // ---- Settings ---------------------------------------------------------------------------------------

  async function healthChecks(ctx: WorkspaceRequestContext, s: AnnouncementSettings, guild: GuildAccess | null, roles: RoleInspection | null, apps: AppRow[], appSettings: Map<string, AppAnnounceSettings>): Promise<Check[]> {
    const wid = ctx.workspace.id;
    const m = ctx.membership;
    const checks: Check[] = [];
    const [conn, gh, key] = await Promise.all([getDiscordConnection(deps.db, wid), getGitHubConnection(deps.db, wid), resolveClaudeKey(deps, wid)]);
    if (!conn) checks.push({ status: 'error', title: 'Connect a Discord server first', fix: can(m, 'manage') ? { label: 'Connect Discord', href: `${ctx.base}/setup/discord` } : undefined });
    else if (guild && !guild.ok) checks.push({ status: 'error', title: guild.message });
    if (!gh || gh.status !== 'active') checks.push({ status: 'error', title: 'Connect GitHub first', fix: can(m, 'manage') ? { label: 'Connect GitHub', href: `${ctx.base}/setup/github` } : undefined });
    const announced = announcedRepos(apps, appSettings);
    checks.push(announced.length ? { status: 'ok', title: `${plural(announced.length, 'app')} announced` } : { status: 'error', title: 'No apps are announced', detail: apps.length ? 'Turn on at least one app under Apps.' : 'Add an app first.' });
    if (guild?.ok) {
      const channelIds = new Set([s.channelId, ...announced.map((a) => appSettings.get(a.id)?.channelId)].filter((c): c is string => Boolean(c)));
      if (!s.channelId) checks.push({ status: 'error', title: 'No channel chosen' });
      for (const id of channelIds) {
        const c = guild.channels.find((x) => x.id === id);
        if (!c) checks.push({ status: 'error', title: 'A chosen channel no longer exists or is hidden from the bot', detail: 'Choose another one.' });
        else if (c.missing.length) checks.push({ status: 'error', title: `The bot is missing permissions in #${c.name}`, detail: `Missing: ${c.missing.join(', ')}` });
        else checks.push({ status: 'ok', title: `The bot can post in #${c.name}` });
      }
    }
    if (s.pingEnabled && roles?.ok) {
      const used = new Map<string, string>();
      if (s.roleId) used.set(s.roleId, s.roleName ?? 'role');
      for (const a of announced) {
        const t = targetFor(s, appSettings.get(a.id));
        if (t.roleId) used.set(t.roleId, t.roleName ?? 'role');
      }
      if (!s.roleId && ![...announced].some((a) => appSettings.get(a.id)?.roleMode === 'role')) checks.push({ status: 'warning', title: 'Pings are on, but no role is chosen', detail: 'Choose the role to ping.' });
      for (const [id, name] of used) {
        const role = roles.roles.find((r) => r.id === id);
        if (!role) checks.push({ status: 'error', title: `@${name} no longer exists`, detail: 'Choose another role.' });
        else if (!role.mentionable && !roles.canMentionAll) checks.push({ status: 'warning', title: `@${role.name} won’t be pinged`, detail: 'In Discord: Server Settings › Roles › the role › turn on “Allow anyone to @mention this role”, or give the bot “Mention @everyone, @here and All Roles”.' });
        else checks.push({ status: 'ok', title: `@${role.name} can be pinged` });
      }
    }
    if (s.notesSource === 'claude') {
      checks.push(key
        ? { status: 'ok', title: 'Claude writes the notes', detail: key.source === 'server' ? 'with the server’s API key' : undefined }
        : { status: 'warning', title: 'No Claude API key', detail: 'GitHub’s notes are posted as written until a key is added.', fix: can(m, 'manage') ? { label: 'Add key', href: `${ctx.base}/settings/claude` } : undefined });
    }
    if (!s.enabled) checks.push({ status: 'warning', title: 'Announcements are off', detail: 'Turn them on at the top to check for new releases.' });
    return checks;
  }

  app.get('/w/:wid/announcements/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'announcement-settings.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = base(ctx);
    const edit = can(ctx.membership, 'announcement-settings.edit');
    const [s, apps, appSettings, conn, rows, bot] = await Promise.all([
      getAnnouncementSettings(deps.db, wid), listApps(deps.db, wid), appAnnounceSettings(deps.db, wid), getDiscordConnection(deps.db, wid), listAnnouncements(deps.db, wid, 20), botIdentity(deps),
    ]);
    const sorted = [...apps].sort((x, y) => x.position - y.position);
    const [guild, roles] = conn && deps.discord ? await Promise.all([inspectGuild(deps.discord, conn.guild_id), inspectRoles(deps.discord, conn.guild_id)]) : [null, null];
    const checks = await healthChecks(ctx, s, guild, roles, apps, appSettings);
    const sample = sampleRelease(rows, sorted, appSettings);
    const sampleTarget = targetFor(s, sample.appId ? appSettings.get(sample.appId) : undefined);
    const previewRole = sampleTarget.roleId;
    // The ping and role fields redraw the preview only when the sample uses the workspace's role.
    const followsRole = (sample.appId ? appSettings.get(sample.appId)?.roleMode ?? 'default' : 'default') === 'default';
    const roleList = roles?.ok ? roles.roles.filter((r) => !r.reason?.startsWith('Managed')) : [];
    const roleNames = new Map<string, string>(roleList.map((r) => [r.id, r.name]));
    if (s.roleId && !roleNames.has(s.roleId)) roleNames.set(s.roleId, s.roleName ?? 'role');

    const channels = guild?.ok ? guild.channels : [];
    const channelOptions = (selected: string | null, o: { def?: string } = {}) => html`
      ${o.def !== undefined ? html`<option value="" ${selected ? '' : raw('selected')}>${o.def}</option>` : selected ? '' : html`<option value="" selected disabled>Choose a channel…</option>`}
      ${channels.map((c) => html`<option value="${c.id}" ${c.id === selected ? raw('selected') : ''} ${c.missing.length ? raw('disabled') : ''}>#${c.name}${c.missing.length ? ` (bot missing: ${c.missing.join(', ')})` : c.category ? ` · ${c.category}` : ''}</option>`)}
      ${selected && !channels.some((c) => c.id === selected) ? html`<option value="${selected}" selected>#${o.def !== undefined ? (selected === s.channelId ? s.channelName : '') ?? 'unknown' : s.channelName ?? 'unknown'}</option>` : ''}`;
    const roleOptions = (selected: string | null, first: SafeHtml) => html`${first}
      ${roleList.map((r) => html`<option value="${r.id}" ${r.id === selected ? raw('selected') : ''} ${r.elevated.length && r.id !== selected ? raw('disabled') : ''}>@${r.name}${r.elevated.length ? ' (has moderator permissions)' : !r.mentionable && !(roles?.ok && roles.canMentionAll) ? ' (can’t be pinged yet)' : ''}</option>`)}
      ${selected && !roleList.some((r) => r.id === selected) ? html`<option value="${selected}" selected>@${roleNames.get(selected) ?? 'unknown role'}</option>` : ''}`;
    const discordUnavailable = html`<span class="small muted">${conn ? 'Discord can’t be reached right now.' : 'Connect Discord first.'}</span>`;

    const channelControl = guild?.ok ? selectWrap(html`<select id="ann-channel" name="channel_id" aria-label="Announcements channel">${channelOptions(s.channelId)}</select>`) : discordUnavailable;
    const roleControl = roles?.ok
      ? selectWrap(html`<select id="ann-role" name="role_id" aria-label="Role to ping" ${followsRole ? raw('data-tpl-role') : ''}>${roleOptions(s.roleId, html`<option value="" ${s.roleId ? '' : raw('selected')}>Choose a role…</option>`)}</select>`)
      : discordUnavailable;
    const t = { message: s.messageText ?? TEMPLATE_DEFAULTS.message, title: s.titleText ?? TEMPLATE_DEFAULTS.title, body: s.bodyText ?? TEMPLATE_DEFAULTS.body };
    const placeholders = html`Fill-ins: ${PLACEHOLDERS.map((p, i) => html`${i ? ', ' : ''}<code>{${p}}</code>`)}. {role} is the ping (nothing when there’s none).`;
    const defaultRoleName = s.roleId ? `@${s.roleName ?? 'role'}` : 'no role yet';

    const appRows = sorted.map((a) => {
      const x = appSettings.get(a.id) ?? APP_DEFAULTS;
      const roleValue = x.roleMode === 'role' ? x.roleId : x.roleMode === 'none' ? 'none' : '';
      return html`<tr>
        <td><span class="cell-title">${a.name}</span><div class="sub mono truncate">${a.repo_owner}/${a.repo_name}</div></td>
        <td>${switchInput({ name: `app_${a.id}_on`, checked: x.enabled, label: `Announce ${a.name}` })}</td>
        <td>${guild?.ok ? selectWrap(html`<select name="app_${a.id}_channel" aria-label="${`Channel for ${a.name}`}">${channelOptions(x.channelId, { def: 'Default' })}</select>`, { sm: true }) : html`<span class="small muted">${x.channelName ? `#${x.channelName}` : 'Default'}</span>`}</td>
        <td>${roles?.ok ? selectWrap(html`<select name="app_${a.id}_role" aria-label="${`Ping for ${a.name}`}">${roleOptions(roleValue === 'none' ? null : roleValue, html`<option value="" ${roleValue === '' ? raw('selected') : ''}>Default</option><option value="none" ${roleValue === 'none' ? raw('selected') : ''}>No ping</option>`)}</select>`, { sm: true }) : html`<span class="small muted">${x.roleMode === 'role' ? `@${x.roleName ?? 'role'}` : x.roleMode === 'none' ? 'No ping' : 'Default'}</span>`}</td>
      </tr>`;
    });

    const fields = html`
      <div class="card-h strip"><div class="row">${s.enabled ? pill(s.mode === 'auto' ? 'Automatic' : 'Review first', 'ok') : pill('Off', 'neutral')}<span class="small muted">${s.enabled
        ? `New releases are checked every ${CHECK_MS / 60_000} minutes${s.enabledAt ? `, since ${timeAgo(s.enabledAt)}` : ''}.`
        : 'Nothing is checked or posted. Releases published before you turn it on aren’t announced.'}</span></div></div>
      <fieldset class="plain${edit ? '' : ' view-only'}" ${edit ? '' : raw('disabled')}>
      <div class="section">
        ${setting('Announcements', 'Check every app’s GitHub releases and announce the new ones.', switchInput({ name: 'enabled', checked: s.enabled, label: 'Announcements turned on', id: 'ann-enabled' }), { flat: true, switchRow: true })}
        ${setting('Posting', null, choices('mode', [
          { value: 'review', title: 'Review first', desc: 'New releases wait under Posts until someone checks the notes and posts them.' },
          { value: 'auto', title: 'Automatic', desc: 'Posted as soon as the notes are written. You can still edit or delete a post afterwards.' },
        ], s.mode), { flat: true, stacked: true })}
        ${setting('Channel', 'Where releases are posted. Apps can have their own below. In an announcement channel, posts are also published to servers that follow it.', channelControl, { for: guild?.ok ? 'ann-channel' : undefined, flat: true })}
        ${setting('Pre-releases', 'Also announce releases marked as pre-release on GitHub.', switchInput({ name: 'include_prereleases', checked: s.includePrereleases, label: 'Announce pre-releases', id: 'ann-pre' }), { flat: true, switchRow: true })}
      </div>
      <div class="section">
        <div class="section-h"><div><h3>Release notes</h3><div class="desc">What goes in {notes}. You can always edit them before posting.</div></div></div>
        ${choices('notes_source', [
          { value: 'claude', title: 'Friendlier, written by Claude', desc: 'From GitHub’s notes: what changed for people using the app, without build and code details. Uses your Claude API key.' },
          { value: 'github', title: 'As written on GitHub', desc: 'The release notes as they are, trimmed to fit Discord.' },
        ], s.notesSource)}
        <div class="fields mt-16">
          ${textField({ id: 'notes_instructions', label: 'Instructions for Claude (optional)', value: s.notesInstructions ?? '', max: INSTRUCTIONS_MAX, rows: 3, placeholder: 'For example: keep it to 5 bullets, start each with a fitting emoji, and mention when something needs a restart.', hint: 'Added to what Claude is asked, for tone, length or emoji.' })}
        </div>
      </div>
      <div class="section">
        <div class="section-h"><div><h3>Message</h3><div class="desc">${placeholders}</div></div>
          ${edit ? html`<button type="button" class="btn ghost sm" data-reset-fields="message_text title_text body_text"><span class="lead">${icon('undo-2', 14)}</span><span class="lbl">Reset to default</span></button>` : ''}</div>
        <div class="fields">
          ${textField({ id: 'message_text', label: 'Message', value: t.message, max: TEMPLATE_LIMITS.message, rows: 2, placeholder: TEMPLATE_DEFAULTS.message, defaultValue: TEMPLATE_DEFAULTS.message, preview: 'pv-message', hint: 'Above the post. Put {role} here for the ping to notify people.' })}
          ${textField({ id: 'title_text', label: 'Title', value: t.title, max: TEMPLATE_LIMITS.title, placeholder: TEMPLATE_DEFAULTS.title, defaultValue: TEMPLATE_DEFAULTS.title, preview: 'pv-title', hint: 'Links to the release on GitHub.' })}
          ${textField({ id: 'body_text', label: 'Text', value: t.body, max: TEMPLATE_LIMITS.body, rows: 3, placeholder: TEMPLATE_DEFAULTS.body, defaultValue: TEMPLATE_DEFAULTS.body, preview: 'pv-body' })}
        </div>
        ${setting('Download buttons', 'A button for Windows, macOS and Linux, linking straight to each one’s download. The release notes button is always there.', switchInput({ name: 'download_buttons', checked: s.downloadButtons, label: 'Download buttons', id: 'ann-downloads', attrs: html`data-toggle-show="pv-downloads"` }), { flat: true, switchRow: true })}
      </div>
      <div class="section">
        <div class="section-h"><div><h3>Pings</h3><div class="desc">Off until you have a role for it. Members can give themselves the role from the ${pageLink(ctx, 'announcement-pings', 'Pings panel')}.</div></div></div>
        ${setting('Ping a role', 'Each post pings the role below (or an app’s own). Only that role is pinged, never @everyone.', switchInput({ name: 'ping_enabled', checked: s.pingEnabled, label: 'Ping a role', id: 'ann-ping', attrs: followsRole ? html`data-tpl-role-on` : undefined }), { flat: true, switchRow: true })}
        ${setting('Role', 'For every app, unless an app has its own below.', roleControl, { for: roles?.ok ? 'ann-role' : undefined, flat: true })}
      </div>
      <div class="section">
        <div class="section-h"><div><h3>Apps</h3><div class="desc">Which apps are announced, and where. Two apps on one repository are announced once, as the first.</div></div></div>
        ${sorted.length
          ? html`<input type="hidden" name="apps" value="1"><div class="table-wrap"><table class="ann-apps"><thead><tr><th class="col-main">App</th><th>Announce</th><th>Channel<div class="sub">Default: ${s.channelName ? `#${s.channelName}` : 'none yet'}</div></th><th>Ping<div class="sub">${s.pingEnabled ? `Default: ${defaultRoleName}` : 'When pings are on'}</div></th></tr></thead><tbody>${appRows}</tbody></table></div>`
          : html`<p class="small muted">Add apps first on ${pageLink(ctx, 'apps', 'Apps & repositories')}.</p>`}
      </div>
      <div class="section">
        <div class="section-h"><div><h3>Health</h3><div class="desc">Checked live against Discord, GitHub and Claude when this page loads.</div></div>${linkBtn(`${b}/settings`, 'Check again', { variant: 'ghost', size: 'sm', icon: 'refresh-cw' })}</div>
        ${checklist(checks)}
      </div>
      </fieldset>`;

    const body = html`
      ${await toolHeader(web, ctx, 'announcements', 'announcement-settings')}
      ${roleNamesJson(roleNames)}
      <div class="panel-grid">
        ${edit
          ? html`<form method="post" action="${b}/settings" class="card" data-dirty>
              ${csrfField(ctx.csrf)}
              ${fields}
              <div class="card-f">
                <button type="submit" class="btn ghost" form="ann-test" ${s.channelId ? '' : raw('disabled title="Choose a channel and save first"')}><span class="lead">${icon('send')}</span><span class="lbl">Send a test post</span></button>
                <div class="end">
                  <span class="row small muted" data-dirty-show hidden><span class="dot c4" aria-hidden="true"></span>Unsaved changes</span>
                  <button type="button" class="btn ghost" data-discard data-dirty-show hidden>Discard</button>
                  ${submitBtn('Save changes', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
                </div>
              </div>
            </form>`
          : html`<div class="card">${fields}<div class="card-f">${viewOnlyFooter('announcements')}</div></div>`}
        <div class="panel-preview">
          ${previewCaption(s.channelName, null)}
          ${announcementPreview(bot, sample, s, previewRole, roleNames)}
          <p class="dp-note">${rows.some((r) => r.status !== 'writing') ? `Shown with ${sample.appName} ${sample.tag}.` : 'Shown with a sample release.'} ${previewRole ? 'Only the chosen role is pinged.' : 'No one is pinged.'}</p>
        </div>
      </div>
      ${edit ? html`<form method="post" action="${b}/test" id="ann-test" hidden data-confirm-title="Send a test post to #${s.channelName ?? ''}?" data-confirm-body="It uses ${sample.appName} ${sample.tag}, marked as a test, and pings no one. You can delete it in Discord afterwards." data-confirm-label="Send test">${csrfField(ctx.csrf)}</form>` : ''}`;
    return web.render(reply, ctx, 'Settings · Announcements', 'announcements', body);
  });

  app.post('/w/:wid/announcements/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'announcement-settings.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const back = `${base(ctx)}/settings`;
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    try {
      const [current, apps, appSettings, conn] = await Promise.all([getAnnouncementSettings(deps.db, wid), listApps(deps.db, wid), appAnnounceSettings(deps.db, wid), getDiscordConnection(deps.db, wid)]);
      let guild: GuildAccess | null = null;
      let roles: RoleInspection | null = null;
      const discordNeeded = () => {
        if (!conn || !deps.discord) throw new UserFacingError('Connect a Discord server first.');
        return { discord: deps.discord, guildId: conn.guild_id };
      };
      // Server-side allowlists: channels and roles must belong to the connected server.
      const channelOf = async (id: string | undefined, keep: { id: string | null; name: string | null }): Promise<{ id: string | null; name: string | null }> => {
        if (!id) return { id: null, name: null };
        if (id === keep.id) return keep;
        const d = discordNeeded();
        guild ??= await inspectGuild(d.discord, d.guildId);
        if (!guild.ok) throw new UserFacingError('Couldn’t read the server from Discord. Try again in a moment.');
        const c = guild.channels.find((x) => x.id === id);
        if (!c) throw new UserFacingError('Choose one of the listed channels.');
        if (c.missing.length) throw new UserFacingError(`The bot is missing permissions in #${c.name}: ${c.missing.join(', ')}.`);
        return { id: c.id, name: c.name };
      };
      const roleOf = async (id: string | undefined, keep: { id: string | null; name: string | null }): Promise<{ id: string | null; name: string | null }> => {
        if (!id) return { id: null, name: null };
        if (id === keep.id) return keep;
        const d = discordNeeded();
        roles ??= await inspectRoles(d.discord, d.guildId);
        const r = roles.ok ? roles.roles.find((x) => x.id === id && !x.reason?.startsWith('Managed')) : undefined;
        if (!r) throw new UserFacingError('Choose one of the listed roles.');
        // Members can give themselves a ping role from the Pings panel: never one with moderator powers.
        if (r.elevated.length) throw new UserFacingError(`@${r.name} can ${r.elevated.slice(0, 3).join(', ')}, so it can’t be a ping role members give themselves. Use a role made just for pings.`);
        return { id: r.id, name: r.name };
      };
      const text = (k: string, max: number, def: string | null) => {
        const v = (body[k] ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
        return v && v !== def ? v : null;
      };
      const channel = body.channel_id !== undefined ? await channelOf(body.channel_id, { id: current.channelId, name: current.channelName }) : { id: current.channelId, name: current.channelName };
      const role = body.role_id !== undefined ? await roleOf(body.role_id, { id: current.roleId, name: current.roleName }) : { id: current.roleId, name: current.roleName };
      const next: AnnouncementSettings = {
        ...current,
        enabled: body.enabled !== undefined,
        mode: body.mode === 'auto' ? 'auto' : 'review',
        channelId: channel.id,
        channelName: channel.name,
        includePrereleases: body.include_prereleases !== undefined,
        notesSource: body.notes_source === 'github' ? 'github' : 'claude',
        notesInstructions: text('notes_instructions', INSTRUCTIONS_MAX, null),
        messageText: body.message_text !== undefined ? text('message_text', TEMPLATE_LIMITS.message, TEMPLATE_DEFAULTS.message) : current.messageText,
        titleText: body.title_text !== undefined ? text('title_text', TEMPLATE_LIMITS.title, TEMPLATE_DEFAULTS.title) : current.titleText,
        bodyText: body.body_text !== undefined ? text('body_text', TEMPLATE_LIMITS.body, TEMPLATE_DEFAULTS.body) : current.bodyText,
        downloadButtons: body.download_buttons !== undefined,
        pingEnabled: body.ping_enabled !== undefined,
        roleId: role.id,
        roleName: role.name,
      };
      if (next.enabled && !next.channelId) throw new UserFacingError('Choose the channel to post in, then turn announcements on.');
      // The apps table was on the form (its switches are only sent when on).
      for (const a of body.apps === '1' ? apps : []) {
        const x = appSettings.get(a.id) ?? APP_DEFAULTS;
        const ch = body[`app_${a.id}_channel`] !== undefined ? await channelOf(body[`app_${a.id}_channel`], { id: x.channelId, name: x.channelName }) : { id: x.channelId, name: x.channelName };
        const rv = body[`app_${a.id}_role`];
        let roleMode: RoleMode = x.roleMode;
        let appRole = { id: x.roleId, name: x.roleName };
        if (rv !== undefined) {
          roleMode = rv === '' ? 'default' : rv === 'none' ? 'none' : 'role';
          appRole = roleMode === 'role' ? await roleOf(rv, { id: x.roleId, name: x.roleName }) : { id: null, name: null };
        }
        await saveAppAnnounceSettings(deps.db, wid, a.id, { enabled: body[`app_${a.id}_on`] !== undefined, channelId: ch.id, channelName: ch.name, roleMode, roleId: appRole.id, roleName: appRole.name });
      }
      await saveAnnouncementSettings(deps.db, wid, next);
      setFlash(reply, 'success', next.enabled && !current.enabled
        ? `Announcements are on. New releases are checked every ${CHECK_MS / 60_000} minutes${next.mode === 'review' ? ' and wait under Posts' : ''}.`
        : 'Settings saved');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(back);
  });

  app.post('/w/:wid/announcements/test', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'announcement-settings.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    try {
      const s = await getAnnouncementSettings(deps.db, wid);
      if (!deps.discord) throw new UserFacingError('Discord is not configured on this deployment.');
      if (!s.channelId) throw new UserFacingError('Choose a channel and save first.');
      const sample = sampleRelease(await listAnnouncements(deps.db, wid, 20), await listApps(deps.db, wid), await appAnnounceSettings(deps.db, wid));
      const payload = announcementPayload(sample, s, null);
      await deps.discord.createMessage(s.channelId, { ...payload, content: `*Test post: no one was pinged.*${payload.content ? `\n${payload.content}` : ''}` });
      setFlash(reply, 'success', `Test post sent to #${s.channelName ?? ''}`);
    } catch (err) {
      if (err instanceof UserFacingError) setFlash(reply, 'error', err.message);
      else {
        deps.log.warn({ err: (err as Error).message }, 'announcement test post failed');
        setFlash(reply, 'error', 'Discord didn’t take the test post. Check the health list for missing permissions.');
      }
    }
    return reply.redirect(`${base(ctx)}/settings`);
  });

  // ---- Pings panel ------------------------------------------------------------------------------------

  function pingPreview(bot: BotIdentity, s: AnnouncementSettings, roles: PingRole[]): SafeHtml {
    const names = new Map(roles.map((r) => [r.id, r.name]));
    const list = roles.map((r) => `- <@&${r.id}>: ${r.apps.join(', ')}`).join('\n');
    return botMessage(bot, html`<div class="dp-embed"><h4 id="pv-ptitle">${s.panelTitle ?? PANEL_DEFAULTS.title}</h4>
      <p><span id="pv-pintro">${discordMd(s.panelIntro ?? PANEL_DEFAULTS.intro)}</span>${roles.length ? html`<br><br>${discordMd(list, names)}` : ''}</p></div>
      <div class="dp-buttons">${roles.length ? roles.map((r) => html`<span class="dp-button grey">${r.name}</span>`) : html`<span class="dp-button grey">No roles yet</span>`}</div>`, 'Preview of the pings message in Discord');
  }

  app.get('/w/:wid/announcements/pings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'announcement-pings.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = base(ctx);
    const m = ctx.membership;
    const edit = can(m, 'announcement-pings.edit');
    const [s, conn, bot] = await Promise.all([getAnnouncementSettings(deps.db, wid), getDiscordConnection(deps.db, wid), botIdentity(deps)]);
    const roles = await workspacePingRoles(deps.db, wid, s);
    const inspection = conn && deps.discord ? await inspectRoles(deps.discord, conn.guild_id) : null;
    const panel = await checkPingPanel(deps, wid, conn);
    const settingsHref = canOpen(m, 'announcement-settings') ? areaHref(ctx, 'announcement-settings') : null;
    const checks: Check[] = [];
    if (!conn) checks.push({ status: 'error', title: 'Connect a Discord server first' });
    if (!s.enabled) checks.push({ status: 'warning', title: 'Announcements are off', detail: 'Buttons answer “not available” until they’re on.', fix: settingsHref ? { label: 'Settings', href: settingsHref } : undefined });
    if (!s.channelId) checks.push({ status: 'error', title: 'No announcements channel chosen', fix: settingsHref ? { label: 'Settings', href: settingsHref } : undefined });
    if (!s.pingEnabled) checks.push({ status: 'error', title: 'Pings are off', detail: 'Turn on “Ping a role” and choose the role in Settings.', fix: settingsHref ? { label: 'Settings', href: settingsHref } : undefined });
    else if (!roles.length) checks.push({ status: 'error', title: 'No role chosen to ping', fix: settingsHref ? { label: 'Settings', href: settingsHref } : undefined });
    if (inspection?.ok) {
      checks.push(inspection.canManageRoles
        ? { status: 'ok', title: 'The bot has the Manage Roles permission' }
        : { status: 'error', title: 'The bot is missing the Manage Roles permission', detail: 'In Discord: Server Settings › Roles › the bot’s role › turn on Manage Roles.' });
      for (const r of roles) {
        const role = inspection.roles.find((x) => x.id === r.id);
        if (!role) checks.push({ status: 'error', title: `@${r.name} no longer exists` });
        else if (role.elevated.length) checks.push({ status: 'error', title: `@${role.name} has moderator permissions`, detail: `${role.elevated.join(', ')}. Members can’t give themselves a role like that: use one made just for pings.` });
        else if (!role.assignable) checks.push({ status: 'error', title: `The bot can’t give @${role.name}`, detail: `${role.reason}. In Server Settings › Roles, drag the bot’s role above @${role.name}.` });
        else checks.push({ status: 'ok', title: `Members can get @${role.name}`, detail: r.apps.join(', ') });
      }
    } else if (inspection && !inspection.ok) checks.push({ status: 'error', title: inspection.message });
    const blocking = checks.some((c) => c.status === 'error');
    const strip = panel.state === 'published'
      ? panel.channelChanged ? html`${pill('Channel changed', 'warn')}<span class="small muted">Update it to move it to #${s.channelName ?? ''}.</span>`
        : panel.outdated ? html`${pill('Out of date', 'warn')}<span class="small muted">Roles or text changed since it was posted.</span>`
          : html`${pill('Published', 'ok')}<span class="small muted">in #${s.channelName ?? ''}</span>`
      : panel.state === 'missing' ? html`${pill('Deleted in Discord', 'warn')}<span class="small muted">Someone deleted the message.${edit ? ' Publish it again.' : ''}</span>`
        : html`${pill('Not published', 'neutral')}<span class="small muted">${blocking ? 'Fix the checks below to publish.' : 'Ready to post.'}</span>`;
    const publishLabel = panel.state === 'published' ? (panel.channelChanged ? 'Move message' : 'Update message') : panel.state === 'missing' ? 'Publish again' : 'Publish message';
    const fields = html`
      <div class="card-h strip"><div class="row">${strip}</div></div>
      <fieldset class="plain${edit ? '' : ' view-only'}" ${edit ? '' : raw('disabled')}>
      <div class="section">
        <div class="section-h"><div><h3>Text</h3><div class="desc">Posted in the announcements channel. A button per role; members click it to get the role, and again to drop it.</div></div></div>
        <div class="fields">
          ${textField({ id: 'panel_title', label: 'Title', value: s.panelTitle ?? PANEL_DEFAULTS.title, max: PANEL_LIMITS.title, placeholder: PANEL_DEFAULTS.title, preview: 'pv-ptitle', defaultValue: PANEL_DEFAULTS.title })}
          ${textField({ id: 'panel_intro', label: 'Introduction', value: s.panelIntro ?? PANEL_DEFAULTS.intro, max: PANEL_LIMITS.intro, rows: 3, placeholder: PANEL_DEFAULTS.intro, preview: 'pv-pintro', md: true, defaultValue: PANEL_DEFAULTS.intro })}
        </div>
      </div>
      <div class="section">
        <div class="section-h"><div><h3>Roles</h3><div class="desc">From ${pageLink(ctx, 'announcement-settings', 'Settings')}: the role to ping, and any app’s own.</div></div></div>
        ${roles.length ? html`<div class="stack gap-8">${roles.map((r) => html`<div class="row">${tag(`@${r.name}`, { cls: 'role' })}<span class="small muted">${r.apps.join(', ')}</span></div>`)}</div>` : html`<p class="small muted">No roles yet.</p>`}
      </div>
      <div class="section">
        <div class="section-h"><div><h3>Health</h3><div class="desc">Checked live against Discord when this page loads.</div></div>${linkBtn(`${b}/pings`, 'Check again', { variant: 'ghost', size: 'sm', icon: 'refresh-cw' })}</div>
        ${checklist(checks)}
      </div>
      </fieldset>`;
    const body = html`
      ${await toolHeader(web, ctx, 'announcements', 'announcement-pings')}
      <div class="panel-grid">
        ${edit
          ? html`<form method="post" action="${b}/pings" class="card" data-dirty>
              ${csrfField(ctx.csrf)}
              ${fields}
              <div class="card-f">
                ${panel.state !== 'not_published' ? html`<button type="submit" class="btn ghost danger" form="ann-remove"><span class="lead">${icon('trash-2')}</span><span class="lbl">Remove message</span></button>` : html`<span></span>`}
                <div class="end">
                  <span class="row small muted" data-dirty-show hidden><span class="dot c4" aria-hidden="true"></span>Unsaved changes</span>
                  <button type="button" class="btn ghost" data-discard data-dirty-show hidden>Discard</button>
                  ${blocking
                    ? submitBtn('Save changes', { variant: 'primary', loading: 'Saving…', name: 'intent', value: 'save', attrs: raw('data-dirty-enable') })
                    : submitBtn(publishLabel, { variant: 'primary', icon: 'send', loading: 'Publishing…', name: 'intent', value: 'publish' })}
                </div>
              </div>
            </form>`
          : html`<div class="card">${fields}<div class="card-f">${viewOnlyFooter('the pings message')}</div></div>`}
        <div class="panel-preview">
          ${previewCaption(s.channelName, panel.state === 'published' ? panel.link : null)}
          ${pingPreview(bot, s, roles)}
          <p class="dp-note">Members click a button to get the role, and again to drop it. Only they see the answer.</p>
        </div>
      </div>
      ${edit && panel.state !== 'not_published' ? html`<form method="post" action="${b}/pings/remove" id="ann-remove" hidden data-confirm-title="Remove the pings message from Discord?" data-confirm-body="Members keep the roles they have. You can post it again later." data-confirm-label="Remove message" data-confirm-danger>${csrfField(ctx.csrf)}</form>` : ''}`;
    return web.render(reply, ctx, 'Pings panel · Announcements', 'announcements', body);
  });

  app.post('/w/:wid/announcements/pings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'announcement-pings.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    try {
      const s = await getAnnouncementSettings(deps.db, wid);
      const text = (k: 'panel_title' | 'panel_intro', def: string) => {
        if (body[k] === undefined) return k === 'panel_title' ? s.panelTitle : s.panelIntro;
        const v = (body[k] ?? '').replace(/\r\n/g, '\n').trim().slice(0, PANEL_LIMITS[k === 'panel_title' ? 'title' : 'intro']);
        return v && v !== def ? v : null;
      };
      await saveAnnouncementSettings(deps.db, wid, { ...s, panelTitle: text('panel_title', PANEL_DEFAULTS.title), panelIntro: text('panel_intro', PANEL_DEFAULTS.intro) });
      if (body.intent === 'publish') {
        const result = await publishPingPanel(deps, wid, ctx.user.id);
        setFlash(reply, 'success', { created: 'Pings message posted', updated: 'Pings message updated', moved: 'Pings message moved' }[result]);
      } else setFlash(reply, 'success', 'Changes saved. Publish the message to show them in Discord.');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${base(ctx)}/pings`);
  });

  app.post('/w/:wid/announcements/pings/remove', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'announcement-pings.edit' });
    if (!ctx) return reply;
    await unpublishPingPanel(deps, ctx.workspace.id);
    setFlash(reply, 'success', 'Pings message removed from Discord. Members keep their roles.');
    return reply.redirect(`${base(ctx)}/pings`);
  });
}
