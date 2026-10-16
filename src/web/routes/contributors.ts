import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  addManualRole,
  addTier,
  checkContributorPanel,
  contributorApps,
  contributorPanelPayload,
  deleteManualRole,
  deleteTier,
  getContributorSettings,
  inspectRoles,
  listManualRoles,
  listTiers,
  listVerifications,
  panelRoleLines,
  publishContributorPanel,
  revokeVerification,
  saveContributorPanelText,
  saveContributorSettings,
  setContributorApps,
  unpublishContributorPanel,
  updateManualRole,
  updateTier,
  type ContributorTier,
  type ManualRole,
  type RoleInspection,
  type VerificationRow,
} from '../../domain/contributors.js';
import { inspectGuild } from '../../domain/discord-checks.js';
import { can } from '../../domain/permissions.js';
import { getDiscordConnection, getGitHubConnection, listApps } from '../../domain/store.js';
import { UserFacingError } from '../../domain/types.js';
import { CONTRIBUTOR_PANEL_DEFAULTS, defaultContributorRolesText } from '../../discord/messages.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { botIdentity, botMessage, discordMd, previewCaption } from '../discord-preview.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import {
  avatar,
  csrfField,
  empty,
  icon,
  iconBtn,
  linkBtn,
  menu,
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

const TEXT_LIMITS = { panel_title: 256, panel_intro: 1000, roles_text: 2000, panel_steps: 1500, panel_footer: 500, button_label: 80 } as const;

const RESULTS: Record<string, { label: string; tone: Tone }> = {
  verified: { label: 'Verified', tone: 'ok' },
  not_contributor: { label: 'Not eligible', tone: 'neutral' },
  conflict: { label: 'Conflict', tone: 'warn' },
  error: { label: 'Error', tone: 'danger' },
};

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'verified', label: 'Verified' },
  { key: 'not', label: 'Not eligible', result: 'not_contributor' },
  { key: 'conflict', label: 'Conflicts' },
] as const;

/** Stable color index per role: automatic tiers by rank, manual roles after them. */
function roleColors(tiers: ContributorTier[], manual: ManualRole[]): Map<string, number> {
  return new Map([...tiers.map((t, i) => [t.role_name, i] as const), ...manual.map((r, i) => [r.role_name, tiers.length + i] as const)]);
}

function roleChip(name: string, colors: Map<string, number>): SafeHtml {
  return html`<span class="tag role"><span class="dot r${String((colors.get(name) ?? 0) % 6)}"></span>@${name}</span>`;
}

/** JSON for app.js (role id → name), safe to embed in a non-executed script element. */
function roleNamesJson(names: Map<string, string>): SafeHtml {
  return raw(`<script type="application/json" id="role-names">${JSON.stringify(Object.fromEntries(names)).replace(/</g, '\\u003c')}</script>`);
}

export function registerContributorRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  // ---- Verifications ----------------------------------------------------------------------------

  app.get('/w/:wid/contributors', async (req, reply) => {
    const ctx = await landOn(web, req, reply, 'verifications');
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    // Edit: revoke roles.
    const edit = can(ctx.membership, 'verifications.edit');
    const [all, tiers, manual] = await Promise.all([listVerifications(deps.db, wid), listTiers(deps.db, wid), listManualRoles(deps.db, wid)]);
    const colors = roleColors(tiers, manual);
    const key = (req.query as { result?: string }).result;
    const filter = FILTERS.find((f) => f.key === key) ?? FILTERS[0];
    const resultOf = (f: (typeof FILTERS)[number]) => ('result' in f ? f.result : f.key);
    const counts = Object.fromEntries(FILTERS.map((f) => [f.key, f.key === 'all' ? all.length : all.filter((v) => v.result === resultOf(f) && !v.revoked_at).length]));
    const rows = filter.key === 'all' ? all : all.filter((v) => v.result === resultOf(filter) && !v.revoked_at);

    const resultCell = (v: VerificationRow) => {
      const r = RESULTS[v.result] ?? { label: v.result, tone: 'neutral' as Tone };
      return v.revoked_at ? pill('Revoked', 'closed') : pill(r.label, r.tone);
    };
    const search = (v: VerificationRow) => [v.discord_name, v.github_login, v.discord_user_id].filter(Boolean).join(' ').toLowerCase();
    const actions = (v: VerificationRow) =>
      edit
        ? menu([
            v.github_login ? { href: `https://github.com/${v.github_login}`, label: 'View on GitHub', icon: 'arrow-up-right', external: true } : null,
            v.result === 'verified' && !v.revoked_at ? 'sep' : null,
            v.result === 'verified' && !v.revoked_at
              ? { post: `${b}/contributors/verifications/${v.id}/revoke`, label: 'Revoke role…', icon: 'user-minus', danger: true, confirm: { title: `Revoke${v.role_name ? ` @${v.role_name}` : ' the role'} from ${v.discord_name}?`, body: `Removes the role in Discord and unlinks ${v.github_login ?? 'the GitHub account'}. ${v.discord_name} can verify again later.`, label: 'Revoke role', danger: true } }
              : null,
          ], { csrf: ctx.csrf, label: `Actions for ${v.discord_name}` })
        : '';

    const table = html`<div class="table-wrap only-desktop" data-search-wrap><table>
        <thead><tr><th class="col-main">Member</th><th>GitHub</th><th>Result</th><th>Role</th><th class="num">Contributions</th><th class="num">When</th>${edit ? html`<th class="actions"><span class="sr-only">Actions</span></th>` : ''}</tr></thead>
        <tbody>${rows.map((v) => html`<tr data-search="${search(v)}">
          <td><span class="who-cell">${avatar(v.discord_name, 24)}<span><span class="cell-title">${v.discord_name}</span><div class="sub mono">${v.discord_user_id}</div></span></span></td>
          <td>${v.github_login ? html`<a class="inline gap-4 small nowrap" href="https://github.com/${v.github_login}" target="_blank" rel="noopener noreferrer">${icon('github', 14, 'muted')}${v.github_login}</a>` : html`<span class="em">—</span>`}</td>
          <td>${resultCell(v)}${(v.result === 'conflict' || v.result === 'error') && v.info ? html`<div class="sub">${v.info}</div>` : ''}</td>
          <td>${v.role_name && v.result === 'verified' ? roleChip(v.role_name, colors) : html`<span class="em">—</span>`}</td>
          <td class="num">${v.contributions !== null ? html`<span class="cell-title">${String(v.contributions)}</span>${v.result !== 'conflict' && v.result !== 'error' && v.info ? html`<div class="sub">${v.info}</div>` : ''}` : html`<span class="em">—</span>`}</td>
          <td class="num">${when(v.created_at)}</td>
          ${edit ? html`<td class="actions">${actions(v)}</td>` : ''}</tr>`)}</tbody></table></div>
      <ul class="list only-mobile" data-search-wrap>${rows.map((v) => html`<li data-search="${search(v)}"><div class="list-row">
        <span class="who-cell">${avatar(v.discord_name, 24)}<span class="l1">${v.discord_name}</span></span><span class="row gap-4">${resultCell(v)}${edit ? actions(v) : ''}</span>
        <span class="l2">${v.role_name && v.result === 'verified' ? roleChip(v.role_name, colors) : ''}${[v.github_login, v.contributions !== null ? plural(v.contributions, 'contribution') : null, timeAgo(v.created_at)].filter(Boolean).join(' · ')}</span></div></li>`)}</ul>`;

    const body = html`
      ${await toolHeader(web, ctx, 'contributors', 'verifications')}
      <div class="card">
        <div class="toolbar">
          ${segLinks('Filter by result', FILTERS.map((f) => ({ href: `${b}/contributors?result=${f.key}`, label: f.label, count: counts[f.key], current: f.key === filter.key })))}
          <div class="tools"><span class="search sm">${icon('search', 14)}<input type="search" placeholder="Search member or GitHub user" aria-label="Search verifications" data-filter-rows="#verification-rows" data-filter-empty="no-verification-match"></span></div>
        </div>
        <div class="card-b flush" id="verification-rows">
          ${rows.length
            ? table
            : all.length
              ? empty('search-x', 'Nothing here', 'No verifications match this filter.', linkBtn(`${b}/contributors`, 'View all', { variant: 'ghost' }))
              : empty('award', 'No verifications yet', 'Members verify from the contributor panel in Discord.', canOpen(ctx.membership, 'contributor-panel') ? linkBtn(areaHref(ctx, 'contributor-panel'), 'Open panel settings') : null)}
          <div id="no-verification-match" hidden>${empty('search-x', 'No matches', html`No verifications match “<span data-term></span>”.`, html`<button type="button" class="btn" data-clear-search>Clear search</button>`)}</div>
        </div>
      </div>`;
    return web.render(reply, ctx, 'Contributor roles', 'contributors', body, { width: 'full' });
  });

  app.post('/w/:wid/contributors/verifications/:vid/revoke', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'verifications.edit' });
    if (!ctx) return reply;
    try {
      await revokeVerification(deps, ctx.workspace.id, (req.params as { vid: string }).vid, ctx.user.id);
      setFlash(reply, 'success', 'Role revoked and GitHub account unlinked');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/contributors`);
  });

  // ---- Roles ------------------------------------------------------------------------------------

  app.get('/w/:wid/contributors/roles', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-roles.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    // Edit: add, change and delete roles, and choose which repositories count.
    const edit = can(ctx.membership, 'contributor-roles.edit');
    const [tiers, manual, apps] = await Promise.all([listTiers(deps.db, wid), listManualRoles(deps.db, wid), listApps(deps.db, wid)]);
    const colors = roleColors(tiers, manual);
    const ladder = [...tiers].reverse();
    const newRole = edit
      ? menu([
          { href: `${b}/contributors/roles/new?kind=auto`, label: 'Automatic role' },
          { href: `${b}/contributors/roles/new?kind=manual`, label: 'Manual role' },
        ], { button: { label: 'New role', opts: { variant: 'primary', icon: 'plus' } } })
      : null;
    const deleteItem = (url: string, name: string) => ({ post: url, label: 'Delete role…', icon: 'trash-2' as const, danger: true, confirm: { title: `Delete @${name} from the contributor roles?`, body: 'Members who have it keep the role in Discord. It just won’t be given or listed anymore.', label: 'Delete role', danger: true } });
    const roleActions = (name: string, editHref: string, deleteUrl: string) =>
      edit ? html`<td class="actions"><div class="row">${iconBtn('pencil', `Edit @${name}`, { size: 'sm', href: editHref })}${menu([deleteItem(deleteUrl, name)], { csrf: ctx.csrf })}</div></td>` : '';
    const appsLink = pageLink(ctx, 'apps', 'Apps & repositories');
    const appRows = html`${apps.map((a) => html`<div class="line sm"><span class="grow inline">${icon('folder-git-2', 16, 'muted')}<span class="mono truncate">${a.repo_owner}/${a.repo_name}</span><span class="small muted truncate">${a.name}</span></span>
      ${switchInput({ name: 'app_ids', value: a.id, checked: a.contributor_enabled, label: `Count ${a.repo_owner}/${a.repo_name} (${a.name})` })}</div>`)}`;
    const whatCounts = html`
      <div class="card-h"><div><h2>What counts</h2><div class="desc">Applies to every automatic role.</div></div></div>
      ${setting('Count', 'What adds up toward each role.', html`<span class="value">Merged pull requests or commits, whichever is higher</span>`)}
      ${setting('Repositories', html`From ${appsLink}. Each repository counts once, even if several apps share it.`, '')}
      ${apps.length
        ? html`<fieldset class="plain${edit ? '' : ' view-only'}" ${edit ? '' : raw('disabled')}>${appRows}</fieldset>`
        : html`<div class="card-b tight"><p class="small muted">${can(ctx.membership, 'apps.edit') ? html`Add apps first on ${appsLink}.` : 'No apps yet.'}</p></div>`}`;

    const body = html`
      ${await toolHeader(web, ctx, 'contributors', 'contributor-roles', { actions: newRole })}
      <div class="card">
        <div class="card-h"><div><h2>Roles</h2><div class="desc">Members get the highest automatic role they qualify for, and moving up replaces the lower role. Manual roles are listed on the panel but given by hand.</div></div></div>
        ${tiers.length || manual.length
          ? html`<div class="card-b flush"><div class="table-wrap"><table>
              <thead><tr><th>Role</th><th>Rule</th><th>Shown on the panel</th>${edit ? html`<th class="actions"><span class="sr-only">Actions</span></th>` : ''}</tr></thead>
              <tbody>
                ${ladder.map((t) => html`<tr><td>${roleChip(t.role_name, colors)}</td><td class="small">${String(t.min_contributions)}+ contributions</td>
                  <td class="small muted">${t.note ?? `at least ${plural(t.min_contributions, 'merged pull request')}`}</td>
                  ${roleActions(t.role_name, `${b}/contributors/roles/${t.id}/edit?kind=auto`, `${b}/contributors/tiers/${t.id}/delete`)}</tr>`)}
                ${manual.map((r) => html`<tr><td>${roleChip(r.role_name, colors)}</td><td><span class="row gap-4">${tag('Manual')}<span class="small muted">Given by hand</span></span></td>
                  <td class="small muted">${r.note ?? 'given manually'}</td>
                  ${roleActions(r.role_name, `${b}/contributors/roles/${r.id}/edit?kind=manual`, `${b}/contributors/manual-roles/${r.id}/delete`)}</tr>`)}
              </tbody></table></div></div>`
          : edit
            ? empty('award', 'No roles yet', 'Add the first role, for example Junior Contributor at 1 merged pull request.', linkBtn(`${b}/contributors/roles/new?kind=auto`, 'New automatic role', { icon: 'plus' }))
            : empty('award', 'No roles yet', 'An admin can add roles here.')}
      </div>

      ${edit
        ? html`<form method="post" action="${b}/contributors/apps" class="card" data-dirty>
            ${csrfField(ctx.csrf)}
            ${whatCounts}
            <div class="card-f"><span></span><div class="end">
              <button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>
              ${submitBtn('Save changes', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
            </div></div>
          </form>`
        : html`<div class="card">
            ${whatCounts}
            <div class="card-f">${viewOnlyFooter('which repositories count')}</div>
          </div>`}`;
    return web.render(reply, ctx, 'Roles · Contributor roles', 'contributors', body);
  });

  /** A new role (Edit only), or an existing one: its form with Edit, the same fields read-only with View. */
  async function renderRoleForm(ctx: WorkspaceRequestContext, reply: FastifyReply, kind: 'auto' | 'manual', existing: ContributorTier | ManualRole | null) {
    const b = ctx.base;
    const edit = can(ctx.membership, 'contributor-roles.edit');
    // Only a new role picks a Discord role, so only then is Discord asked for the server's roles.
    const conn = existing ? null : await getDiscordConnection(deps.db, ctx.workspace.id);
    const roles: RoleInspection | null = conn && deps.discord ? await inspectRoles(deps.discord, conn.guild_id) : null;
    const [tiers, manual] = await Promise.all([listTiers(deps.db, ctx.workspace.id), listManualRoles(deps.db, ctx.workspace.id)]);
    const used = new Set([...tiers.map((t) => t.role_id), ...manual.map((r) => r.role_id)]);
    const label = kind === 'auto' ? 'automatic role' : 'manual role';
    const title = existing ? (edit ? `Edit @${existing.role_name}` : `@${existing.role_name}`) : `New ${label}`;
    const min = existing && 'min_contributions' in existing ? existing.min_contributions : '';
    const action = existing ? `${b}/contributors/${kind === 'auto' ? 'tiers' : 'manual-roles'}/${existing.id}` : `${b}/contributors/${kind === 'auto' ? 'tiers' : 'manual-roles'}`;
    const roleField = existing
      ? html`<div class="field"><span class="label">Discord role</span><div>${tag(`@${existing.role_name}`)}</div>${edit ? html`<div class="hint">To use another role, delete this one and add a new role.</div>` : ''}</div>`
      : html`<div class="field"><label for="role">Discord role</label>
          ${roles?.ok
            ? selectWrap(html`<select id="role" name="role_id" required><option value="">Choose a role…</option>${roles.roles.filter((r) => !used.has(r.id)).map((r) => html`<option value="${r.id}" ${kind === 'auto' && !r.assignable ? raw('disabled') : ''}>@${r.name}${kind === 'auto' && r.reason ? ` (${r.reason})` : ''}</option>`)}</select>`)
            : html`<p class="small muted">${roles && !roles.ok ? roles.message : 'Connect Discord first.'}</p>`}
          <div class="hint">${kind === 'auto' ? 'The bot can only give roles below its own role in Server Settings › Roles.' : 'The bot never gives this role. It’s only listed on the panel.'}</div></div>`;
    const fields = html`<div class="card-b"><div class="fields">
        ${roleField}
        ${kind === 'auto' ? html`<div class="field"><label for="min">Contributions needed</label><div class="row"><input id="min" type="number" class="wide" name="min_contributions" min="1" max="100000" required value="${String(min)}"><span class="small muted">merged pull requests or commits</span></div></div>` : ''}
        ${textField({ id: 'note', label: 'Shown on the panel (optional)', value: existing?.note ?? '', max: 200, placeholder: kind === 'auto' ? 'at least 10 merged pull requests or a big feature' : 'given by hand to our biggest contributors', hint: 'Appears after the role in “Which role will I get?”.' })}
      </div></div>`;
    const body = html`
      ${pageHeader({
        crumbs: [{ href: toolHref(ctx, 'contributors') ?? undefined, label: 'Contributor roles' }, { href: `${b}/contributors/roles`, label: 'Roles' }, { label: existing ? `@${existing.role_name}` : `New ${label}` }],
        title,
        after: edit ? undefined : viewOnlyTag(viewOnlyText('contributor-roles')),
        description: kind === 'auto' ? 'Given automatically when a member has enough merged pull requests or commits.' : 'Listed on the panel so members know it exists. You give it by hand in Discord.',
      })}
      ${edit
        ? html`<form method="post" action="${action}" class="card">
            ${csrfField(ctx.csrf)}
            ${fields}
            <div class="card-f"><span></span><div class="end">${linkBtn(`${b}/contributors/roles`, 'Cancel')}${submitBtn(existing ? 'Save changes' : 'Add role', { variant: 'primary', loading: 'Saving…', disabled: !existing && !roles?.ok })}</div></div>
          </form>`
        : html`<div class="card">
            <fieldset class="plain view-only" disabled>${fields}</fieldset>
            <div class="card-f">${viewOnlyFooter('this role')}</div>
          </div>`}`;
    return web.render(reply, ctx, title, 'contributors', body);
  }

  app.get('/w/:wid/contributors/roles/new', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-roles.edit' });
    if (!ctx) return reply;
    return renderRoleForm(ctx, reply, (req.query as { kind?: string }).kind === 'manual' ? 'manual' : 'auto', null);
  });

  app.get('/w/:wid/contributors/roles/:rid/edit', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-roles.view' });
    if (!ctx) return reply;
    const id = (req.params as { rid: string }).rid;
    const kind = (req.query as { kind?: string }).kind === 'manual' ? 'manual' : 'auto';
    const existing = kind === 'auto'
      ? (await listTiers(deps.db, ctx.workspace.id)).find((t) => t.id === id)
      : (await listManualRoles(deps.db, ctx.workspace.id)).find((r) => r.id === id);
    if (!existing) return reply.callNotFound();
    return renderRoleForm(ctx, reply, kind, existing);
  });

  const rolesUrl = (ctx: WorkspaceRequestContext) => `${ctx.base}/contributors/roles`;
  const note = (body: { note?: string }) => (body.note ?? '').trim().slice(0, 200) || null;

  app.post('/w/:wid/contributors/tiers', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-roles.edit' });
    if (!ctx) return reply;
    const body = req.body as { role_id?: string; min_contributions?: string; note?: string };
    const min = Number(body.min_contributions);
    const conn = await getDiscordConnection(deps.db, ctx.workspace.id);
    try {
      if (!conn || !deps.discord) throw new UserFacingError('Connect a Discord server first.');
      if (!Number.isInteger(min) || min < 1 || min > 100000) throw new UserFacingError('Enter the number of contributions needed (1 or more).');
      const roles = await inspectRoles(deps.discord, conn.guild_id);
      // Server-side allowlist: the role must exist in the connected server and be assignable.
      const role = roles.ok ? roles.roles.find((r) => r.id === body.role_id) : undefined;
      if (!role || !role.assignable) throw new UserFacingError(role ? `The bot can't assign @${role.name}: ${role.reason}.` : 'Choose one of the listed roles.');
      await addTier(deps.db, ctx.workspace.id, role, min, note(body));
      setFlash(reply, 'success', `Added @${role.name} at ${min}+ contributions. Update the panel to list it.`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(rolesUrl(ctx));
  });

  app.post('/w/:wid/contributors/tiers/:tid', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-roles.edit' });
    if (!ctx) return reply;
    const body = req.body as { min_contributions?: string; note?: string };
    const min = Number(body.min_contributions);
    try {
      if (!Number.isInteger(min) || min < 1 || min > 100000) throw new UserFacingError('Enter the number of contributions needed (1 or more).');
      await updateTier(deps.db, ctx.workspace.id, (req.params as { tid: string }).tid, min, note(body));
      setFlash(reply, 'success', 'Role saved. Update the panel to show the change.');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(rolesUrl(ctx));
  });

  app.post('/w/:wid/contributors/tiers/:tid/delete', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-roles.edit' });
    if (!ctx) return reply;
    await deleteTier(deps.db, ctx.workspace.id, (req.params as { tid: string }).tid);
    setFlash(reply, 'success', 'Role deleted. Update the panel to show the change.');
    return reply.redirect(rolesUrl(ctx));
  });

  app.post('/w/:wid/contributors/manual-roles', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-roles.edit' });
    if (!ctx) return reply;
    const body = req.body as { role_id?: string; note?: string };
    const conn = await getDiscordConnection(deps.db, ctx.workspace.id);
    const roles = conn && deps.discord ? await inspectRoles(deps.discord, conn.guild_id) : null;
    // Server-side allowlist: the role must exist in the connected server.
    const role = roles?.ok ? roles.roles.find((r) => r.id === body.role_id) : undefined;
    try {
      if (!role) throw new UserFacingError('Choose one of the listed roles.');
      await addManualRole(deps.db, ctx.workspace.id, role, note(body));
      setFlash(reply, 'success', `Added @${role.name} as a manual role. Update the panel to list it.`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(rolesUrl(ctx));
  });

  app.post('/w/:wid/contributors/manual-roles/:mid', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-roles.edit' });
    if (!ctx) return reply;
    try {
      await updateManualRole(deps.db, ctx.workspace.id, (req.params as { mid: string }).mid, note(req.body as { note?: string }));
      setFlash(reply, 'success', 'Role saved. Update the panel to show the change.');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(rolesUrl(ctx));
  });

  app.post('/w/:wid/contributors/manual-roles/:mid/delete', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-roles.edit' });
    if (!ctx) return reply;
    await deleteManualRole(deps.db, ctx.workspace.id, (req.params as { mid: string }).mid);
    setFlash(reply, 'success', 'Manual role deleted. Update the panel to show the change.');
    return reply.redirect(rolesUrl(ctx));
  });

  app.post('/w/:wid/contributors/apps', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-roles.edit' });
    if (!ctx) return reply;
    const ids = (req.body as { app_ids?: string | string[] }).app_ids;
    const requested = ids === undefined ? [] : Array.isArray(ids) ? ids : [ids];
    const own = new Set((await listApps(deps.db, ctx.workspace.id)).map((a) => a.id));
    await setContributorApps(deps.db, ctx.workspace.id, requested.filter((id) => own.has(id)));
    setFlash(reply, 'success', 'Repositories saved');
    return reply.redirect(rolesUrl(ctx));
  });

  // ---- Panel ------------------------------------------------------------------------------------

  app.get('/w/:wid/contributors/panel', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-panel.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    const m = ctx.membership;
    // Edit: change, publish or remove the panel. View: the same page with its controls turned off.
    const edit = can(m, 'contributor-panel.edit');
    const rolesEdit = can(m, 'contributor-roles.edit');
    // A way to fix a check, for people who can make that fix.
    const fix = (allowed: boolean, label: string, href: string) => (allowed ? { label, href } : undefined);
    const [settings, tiers, manual, apps, conn, gh, bot] = await Promise.all([
      getContributorSettings(deps.db, wid),
      listTiers(deps.db, wid),
      listManualRoles(deps.db, wid),
      listApps(deps.db, wid),
      getDiscordConnection(deps.db, wid),
      getGitHubConnection(deps.db, wid),
      botIdentity(deps),
    ]);
    const enabledApps = contributorApps(apps);
    const colors = roleColors(tiers, manual);

    // Live Discord and GitHub checks.
    const checks: Check[] = [];
    const roles = deps.discord && conn ? await inspectRoles(deps.discord, conn.guild_id) : null;
    const guild = deps.discord && conn ? await inspectGuild(deps.discord, conn.guild_id) : null;
    if (!conn) checks.push({ status: 'error', title: 'Connect a Discord server first', fix: fix(can(m, 'manage'), 'Connect Discord', `${b}/setup/discord`) });
    else if (roles && !roles.ok) checks.push({ status: 'error', title: roles.message });
    else if (roles?.ok) {
      checks.push(roles.canManageRoles
        ? { status: 'ok', title: 'The bot has the Manage Roles permission' }
        : { status: 'error', title: 'The bot is missing the Manage Roles permission', detail: 'In Discord: Server Settings › Roles › the bot’s role › turn on Manage Roles.' });
      if (!tiers.length) checks.push({ status: 'error', title: 'No automatic roles yet', fix: fix(rolesEdit, 'Add a role', `${b}/contributors/roles/new?kind=auto`) });
      for (const tier of tiers) {
        const role = roles.roles.find((r) => r.id === tier.role_id);
        if (!role) checks.push({ status: 'error', title: `The role for “${tier.role_name}” no longer exists`, detail: 'Delete it and add the role again.', fix: fix(rolesEdit, 'Roles', areaHref(ctx, 'contributor-roles')) });
        else if (!role.assignable) checks.push({ status: 'error', title: `The bot can't assign @${role.name}`, detail: `${role.reason}. In Server Settings › Roles, drag the bot's role above @${role.name}.` });
        else checks.push({ status: 'ok', title: `@${role.name} at ${tier.min_contributions}+ contribution${tier.min_contributions === 1 ? '' : 's'}` });
      }
    }
    const channel = guild?.ok && settings.channel_id ? guild.channels.find((c) => c.id === settings.channel_id) : null;
    if (conn && guild?.ok) {
      if (!settings.channel_id) checks.push({ status: 'error', title: 'No panel channel chosen', fix: fix(edit, 'Choose channel', '#channel') });
      else if (!channel) checks.push({ status: 'error', title: 'The chosen channel no longer exists or is hidden from the bot' });
      else if (channel.missing.length) checks.push({ status: 'error', title: `The bot is missing permissions in #${channel.name}`, detail: `Missing: ${channel.missing.join(', ')}` });
      else checks.push({ status: 'ok', title: `The bot can post in #${channel.name}` });
    }
    checks.push(enabledApps.length
      ? { status: 'ok', title: `${plural(enabledApps.length, 'app')} counted for verification` }
      : { status: 'error', title: 'No repositories are counted', fix: fix(rolesEdit, 'What counts', areaHref(ctx, 'contributor-roles')) });
    if (!gh || gh.status !== 'active') checks.push({ status: 'error', title: 'Connect GitHub first', fix: fix(can(m, 'manage'), 'Connect GitHub', `${b}/setup/github`) });
    else if (deps.github) {
      try {
        const inst = await deps.github.getInstallation(gh.installation_id);
        const missing = [['pull_requests', 'Pull requests'], ['contents', 'Contents']].filter(([k]) => !inst.permissions[k!]).map(([, n]) => `${n}: Read`);
        checks.push(missing.length
          ? { status: 'warning', title: `The GitHub App is missing ${missing.join(' and ')}`, detail: 'Needed to check merged pull requests and commits in private repositories. Add them in the GitHub App settings › Permissions, then accept them on the installation.' }
          : { status: 'ok', title: 'The GitHub App can read pull requests and commits' });
      } catch {
        checks.push({ status: 'warning', title: 'Couldn’t check the GitHub App permissions right now' });
      }
    }
    if (!settings.enabled) checks.push({ status: 'warning', title: 'Verification is turned off', detail: edit ? 'Turn it on under Channel to publish the panel.' : undefined });
    const blocking = checks.some((c) => c.status === 'error') || !settings.enabled;
    const panel = await checkContributorPanel(deps, wid, conn);

    const roleNames = new Map<string, string>(roles?.ok ? roles.roles.map((r) => [r.id, r.name]) : [...tiers, ...manual].map((t) => [t.role_id, t.role_name]));
    const lines = panelRoleLines(tiers, manual);
    const defaultRoles = defaultContributorRolesText(lines);
    const preview = contributorPanelPayload(tiers, settings, manual).payload;
    const value = (v: string | null, fallback: string) => v?.trim() || fallback;
    const d = CONTRIBUTOR_PANEL_DEFAULTS;
    // What to do next, for people who can; what's going on, for people who can only look.
    const strip =
      panel.state === 'published'
        ? panel.channelChanged
          ? html`${pill('Channel changed', 'warn')}<span class="small muted">${edit ? `Update the panel to move it to #${settings.channel_name ?? ''}.` : `It’s still in the old channel, not #${settings.channel_name ?? ''}.`}</span>`
          : panel.outdated
            ? html`${pill('Out of date', 'warn')}<span class="small muted">Roles or text changed since it was posted.</span>`
            : html`${pill('Published', 'ok')}<span class="small muted">in #${settings.channel_name ?? ''}</span>`
        : panel.state === 'missing'
          ? html`${pill('Deleted in Discord', 'warn')}<span class="small muted">Someone deleted the panel message.${edit ? ' Publish it again.' : ''}</span>`
          : html`${pill('Not published', 'neutral')}<span class="small muted">${blocking ? (edit ? 'Fix the health checks below to publish.' : 'The health checks below need fixing first.') : 'Ready to post.'}</span>`;
    const publishLabel = panel.state === 'published' ? (panel.channelChanged ? 'Move panel' : 'Update panel') : panel.state === 'missing' ? 'Publish again' : 'Publish panel';

    const channelControl = guild?.ok
      ? selectWrap(html`<select id="channel" name="channel_id" aria-label="Contributor panel channel">
          ${settings.channel_id ? '' : html`<option value="" selected disabled>Choose a channel…</option>`}
          ${guild.channels.map((c) => html`<option value="${c.id}" ${c.id === settings.channel_id ? raw('selected') : ''} ${c.missing.length ? raw('disabled') : ''}>#${c.name}${c.missing.length ? ` (bot missing: ${c.missing.join(', ')})` : c.category ? ` · ${c.category}` : ''}</option>`)}
        </select>`)
      : html`<span class="small muted">${conn ? 'Discord can’t be reached right now.' : 'Connect Discord first.'}</span>`;

    const panelSettings = html`
      <div class="card-h strip"><div class="row">${strip}</div></div>
      <fieldset class="plain${edit ? '' : ' view-only'}" ${edit ? '' : raw('disabled')}>
      <div class="section" id="channel">
        ${setting('Channel', 'Where members verify. Use a different channel from the ticket panel.', channelControl, { for: guild?.ok ? 'channel' : undefined, flat: true })}
        ${setting('Verification', 'When off, members can’t verify and the panel can’t be published.', switchInput({ name: 'enabled', checked: settings.enabled, label: 'Verification turned on', id: 'enabled' }), { flat: true, switchRow: true })}
      </div>
      <div class="section">
        <div class="section-h"><div><h3>Content</h3><div class="desc">Discord formatting works: **bold**, ## heading, - list.</div></div>
          ${edit ? html`<button type="button" class="btn ghost sm" data-reset-fields="panel_title panel_intro panel_steps panel_footer button_label"><span class="lead">${icon('undo-2', 14)}</span><span class="lbl">Reset to default</span></button>` : ''}</div>
        <div class="fields">
          ${textField({ id: 'panel_title', label: 'Title', value: value(settings.panel_title, d.title), max: TEXT_LIMITS.panel_title, placeholder: d.title, preview: 'pv-title' })}
          ${textField({ id: 'panel_intro', label: 'Introduction', value: value(settings.panel_intro, d.intro), max: TEXT_LIMITS.panel_intro, rows: 2, placeholder: d.intro, preview: 'pv-intro', md: true })}
          ${textField({ id: 'panel_steps', label: 'How it works', value: value(settings.panel_steps, d.steps), max: TEXT_LIMITS.panel_steps, rows: 3, placeholder: d.steps, preview: 'pv-steps', md: true })}
          ${textField({ id: 'panel_footer', label: 'Footer', value: value(settings.panel_footer, d.footer), max: TEXT_LIMITS.panel_footer, rows: 2, placeholder: d.footer, preview: 'pv-footer', md: true })}
          ${textField({ id: 'button_label', label: 'Button label', value: value(settings.button_label, d.buttonLabel), max: TEXT_LIMITS.button_label, placeholder: d.buttonLabel, preview: 'pv-button' })}
        </div>
      </div>
      <div class="section">
        <div class="section-h"><div><h3>Roles on the panel</h3><div class="desc">Listed automatically from the Roles tab, highest first.</div></div>${rolesEdit || canOpen(m, 'contributor-roles') ? linkBtn(areaHref(ctx, 'contributor-roles'), rolesEdit ? 'Edit roles' : 'See roles', { variant: 'ghost', size: 'sm', trail: 'arrow-right' }) : ''}</div>
        ${lines.length
          ? html`<div class="stack gap-8">${[...tiers].reverse().map((t) => html`<div class="row">${roleChip(t.role_name, colors)}<span class="small muted">${t.note ?? `at least ${plural(t.min_contributions, 'merged pull request')}`}</span></div>`)}${manual.map((r) => html`<div class="row">${roleChip(r.role_name, colors)}<span class="small muted">${r.note ?? 'given manually'}</span></div>`)}</div>`
          : html`<p class="small muted">No roles yet.</p>`}
        <div class="fields mt-16">
          ${textField({ id: 'roles_text', label: 'Custom role list (optional)', value: settings.roles_text ?? '', max: TEXT_LIMITS.roles_text, rows: 3, placeholder: defaultRoles, preview: 'pv-roles', md: true, hint: 'Leave empty to use the list above. Role tags like <@&ROLE_ID> show as role names and never ping.' })}
        </div>
      </div>
      <div class="section">
        <div class="section-h"><div><h3>Health</h3><div class="desc">Checked live against Discord and GitHub when this page loads.</div></div>${linkBtn(`${b}/contributors/panel`, 'Check again', { variant: 'ghost', size: 'sm', icon: 'refresh-cw' })}</div>
        ${checklist(checks)}
      </div>
      </fieldset>`;

    const body = html`
      ${await toolHeader(web, ctx, 'contributors', 'contributor-panel')}
      ${roleNamesJson(roleNames)}
      <div class="panel-grid">
        ${edit
          ? html`<form method="post" action="${b}/contributors/panel" class="card" data-dirty>
              ${csrfField(ctx.csrf)}<input type="hidden" name="settings" value="1">
              ${panelSettings}
              <div class="card-f">
                ${panel.state !== 'not_published' ? html`<button type="submit" class="btn ghost danger" form="remove-form"><span class="lead">${icon('trash-2')}</span><span class="lbl">Remove panel</span></button>` : html`<span></span>`}
                <div class="end">
                  ${blocking ? html`<span class="small muted" data-clean-show>Fix the problems under Health to publish.</span>` : ''}
                  <span class="row small muted" data-dirty-show hidden><span class="dot c4" aria-hidden="true"></span>Unsaved changes</span>
                  <button type="button" class="btn ghost" data-discard data-dirty-show hidden>Discard</button>
                  ${!blocking
                    ? submitBtn(publishLabel, { variant: 'primary', icon: 'send', loading: 'Publishing…', name: 'intent', value: 'publish' })
                    : submitBtn('Save changes', { variant: 'primary', loading: 'Saving…', name: 'intent', value: 'save', attrs: raw('data-dirty-enable') })}
                </div>
              </div>
            </form>`
          : html`<div class="card">
              ${panelSettings}
              <div class="card-f">${viewOnlyFooter('the panel')}</div>
            </div>`}

        <div class="panel-preview">
          ${previewCaption(settings.channel_name, panel.state === 'published' ? panel.link : null)}
          ${botMessage(bot, html`<div class="dp-embed green"><h4 id="pv-title">${preview.embeds[0]!.title}</h4>
            <p><span id="pv-intro">${discordMd(value(settings.panel_intro, d.intro))}</span><br><br><span class="dp-h">Which role will I get?</span><span id="pv-roles">${discordMd(value(settings.roles_text, defaultRoles), roleNames)}</span><br><br><span class="dp-h">How it works</span><span id="pv-steps">${discordMd(value(settings.panel_steps, d.steps))}</span><br><br><span id="pv-footer">${discordMd(value(settings.panel_footer, d.footer))}</span></p></div>
            <span class="dp-button" id="pv-button">${preview.components[0]!.components[0]!.label}</span>`, 'Preview of the contributor panel in Discord')}
          <p class="dp-note">Members sign in with GitHub, then get the highest role they qualify for.</p>
        </div>
      </div>
      ${edit && panel.state !== 'not_published' ? html`<form method="post" action="${b}/contributors/remove" id="remove-form" hidden data-confirm-title="Remove the contributor panel${settings.channel_name ? ` from #${settings.channel_name}` : ''}?" data-confirm-body="Members can’t verify until you post it again. Roles already given are kept." data-confirm-label="Remove panel" data-confirm-danger>${csrfField(ctx.csrf)}</form>` : ''}`;
    return web.render(reply, ctx, 'Panel · Contributor roles', 'contributors', body);
  });

  /** Saves channel, on/off and text (fields left out stay unchanged), then publishes when asked to. */
  app.post('/w/:wid/contributors/panel', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-panel.edit' });
    if (!ctx) return reply;
    const back = `${ctx.base}/contributors/panel`;
    const wid = ctx.workspace.id;
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    try {
      const current = await getContributorSettings(deps.db, wid);
      if (body.settings === '1' || body.channel_id !== undefined) {
        let channel = current.channel_id ? { id: current.channel_id, name: current.channel_name ?? '' } : null;
        if (body.channel_id && body.channel_id !== current.channel_id) {
          const conn = await getDiscordConnection(deps.db, wid);
          if (!conn || !deps.discord) throw new UserFacingError('Connect a Discord server first.');
          const guild = await inspectGuild(deps.discord, conn.guild_id);
          if (!guild.ok) throw new UserFacingError('Couldn’t read the server from Discord. Try again in a moment.');
          // Server-side allowlist: the channel must belong to the connected server.
          const found = guild.channels.find((c) => c.id === body.channel_id);
          if (!found) throw new UserFacingError('Choose one of the listed channels.');
          if (found.missing.length) throw new UserFacingError(`The bot is missing permissions in #${found.name}: ${found.missing.join(', ')}.`);
          channel = found;
        }
        await saveContributorSettings(deps.db, wid, { enabled: body.enabled !== undefined, role_id: null, role_name: null, channel_id: channel?.id ?? null, channel_name: channel?.name ?? null });
      }
      const keys = Object.keys(TEXT_LIMITS) as (keyof typeof TEXT_LIMITS)[];
      if (keys.some((k) => body[k] !== undefined)) {
        const [tiers, manual] = await Promise.all([listTiers(deps.db, wid), listManualRoles(deps.db, wid)]);
        const d = CONTRIBUTOR_PANEL_DEFAULTS;
        const defaults: Record<keyof typeof TEXT_LIMITS, string> = {
          panel_title: d.title, panel_intro: d.intro, roles_text: defaultContributorRolesText(panelRoleLines(tiers, manual)), panel_steps: d.steps, panel_footer: d.footer, button_label: d.buttonLabel,
        };
        // Text equal to the default is stored as "use the default", so later default changes apply.
        const clean = (k: keyof typeof TEXT_LIMITS) => {
          if (body[k] === undefined) return current[k];
          const v = (body[k] ?? '').replace(/\r\n/g, '\n').trim().slice(0, TEXT_LIMITS[k]);
          return v && v !== defaults[k] ? v : null;
        };
        await saveContributorPanelText(deps.db, wid, {
          panel_title: clean('panel_title'), panel_intro: clean('panel_intro'), roles_text: clean('roles_text'),
          panel_steps: clean('panel_steps'), panel_footer: clean('panel_footer'), button_label: clean('button_label'),
        });
      }
      if (body.intent === 'publish') {
        const result = await publishContributorPanel(deps, wid, ctx.user.id);
        setFlash(reply, 'success', { created: 'Contributor panel posted', updated: 'Contributor panel updated', recreated: 'The old panel was deleted, so a new one was posted', moved: 'Contributor panel moved' }[result]);
      } else {
        setFlash(reply, 'success', 'Changes saved. Publish the panel to show them in Discord.');
      }
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(back);
  });

  app.post('/w/:wid/contributors/publish', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-panel.edit' });
    if (!ctx) return reply;
    try {
      const result = await publishContributorPanel(deps, ctx.workspace.id, ctx.user.id);
      setFlash(reply, 'success', { created: 'Contributor panel posted', updated: 'Contributor panel updated', recreated: 'The old panel was deleted, so a new one was posted', moved: 'Contributor panel moved' }[result]);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/contributors/panel`);
  });

  app.post('/w/:wid/contributors/remove', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'contributor-panel.edit' });
    if (!ctx) return reply;
    await unpublishContributorPanel(deps, ctx.workspace.id);
    setFlash(reply, 'success', 'Contributor panel removed from Discord. Roles already given were kept.');
    return reply.redirect(`${ctx.base}/contributors/panel`);
  });
}

