import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  AREA_KEYS,
  AREAS,
  areaLabel,
  areasOf,
  can,
  levelOf,
  ROLE_LABELS,
  TOOL_NAMES,
  TOOLS,
  toolAccess,
  uniformLevel,
  type AccessLevel,
  type Area,
  type AreaDef,
  type MemberAccess,
  type Tool,
} from '../../domain/permissions.js';
import { UserFacingError, type Role } from '../../domain/types.js';
import { createInvite, listInvites, listMembers, removeMember, revokeInvite, setMemberRole, setModeratorAccess } from '../../domain/workspaces.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import {
  avatar,
  badge,
  choices,
  copyField,
  csrfField,
  dialog,
  discordAvatar,
  empty,
  icon,
  iconBtn,
  linkBtn,
  menu,
  pageHeader,
  plural,
  segRadios,
  selectWrap,
  submitBtn,
  tag,
  timeAgo,
  when,
} from '../ui.js';
import { TOOL_ICONS } from './tool.js';

const CAPABILITIES: [string, string, string, string][] = [
  ['See the tickets inbox', 'yes', 'yes', 'yes'],
  ['Discord tickets: act on tickets, panel, ticket types, files and settings', 'yes', 'yes', 'maybe'],
  ['GitHub issues', 'yes', 'yes', 'maybe'],
  ['AI triage: review suggestions and change its pages', 'yes', 'yes', 'maybe'],
  ['Contributor roles', 'yes', 'yes', 'maybe'],
  ['Apps & repositories', 'yes', 'yes', 'maybe'],
  ['Server health', 'yes', 'yes', 'maybe'],
  ['File cleanup rules and storage limit', 'yes', 'yes', 'no'],
  ['GitHub and Discord connections', 'yes', 'yes', 'no'],
  ['Workspace settings, Claude key and deployment', 'yes', 'yes', 'no'],
  ['Invite people and change roles', 'yes', 'no', 'no'],
];

/** Short tool names for the access tags in the members table. */
const TOOL_TAGS: Record<Tool, string> = { tickets: 'Tickets', issues: 'Issues', triage: 'Triage', contributors: 'Roles', setup: 'Apps', workspace: 'Health' };
const LEVEL_NAMES: Record<AccessLevel, string> = { none: 'No access', view: 'View', edit: 'Edit' };
const SET_NAMES: Record<AccessLevel, string> = { none: 'No access', view: 'View all', edit: 'Edit all' };

/** The choices a page's select offers: the Inbox can't be turned off, Activity has nothing to edit. */
function levelsFor(a: Area): AccessLevel[] {
  return [...((AREAS[a] as AreaDef).min ? [] : (['none'] as const)), ...AREAS[a].levels];
}

/** Page names that need their tool to make sense on their own: two pages are called Panel, and Settings isn't the workspace's. */
const GENERIC_NAMES = new Set([...AREA_KEYS.map((a) => AREAS[a].name).filter((n, i, all) => all.indexOf(n) !== i), 'Settings']);
/** A page's name in a saved message: "Inbox", "Discord tickets › Panel". */
const changeName = (a: Area) => (GENERIC_NAMES.has(AREAS[a].name) ? areaLabel(a) : AREAS[a].name);

/** Each page of a tool and its level, for tooltips: "Inbox: edit · Files: view". */
function toolDetail(m: MemberAccess, tool: Tool): string {
  return areasOf(tool).map((a) => `${AREAS[a].name}: ${LEVEL_NAMES[levelOf(m.access, a)].toLowerCase()}`).join(' · ');
}

/** One tag per tool the moderator can open: "Tickets: edit", "Inbox: view", "Triage · 4 of 6". */
function accessTags(m: MemberAccess): SafeHtml {
  if (m.role === 'owner') return html`${tag('Full access')}${tag('Invites & roles')}`;
  if (m.role === 'admin') return tag('Full access');
  return html`${TOOLS.map((tool) => {
    const t = toolAccess(m, tool);
    if (!t.open) return '';
    const areas = areasOf(tool);
    const only = t.open === 1 && areas.length > 1 ? areas.find((a) => levelOf(m.access, a) !== 'none')! : null;
    const onlyName = only && (GENERIC_NAMES.has(AREAS[only].name) ? `${TOOL_TAGS[tool]} ${AREAS[only].name.toLowerCase()}` : AREAS[only].name);
    const text = only
      ? `${onlyName}: ${levelOf(m.access, only)}`
      : t.level === 'edit' || t.level === 'view' ? `${TOOL_TAGS[tool]}: ${t.level}` : `${TOOL_TAGS[tool]} · ${t.open} of ${t.pages}`;
    return tag(text, { title: `${TOOL_NAMES[tool]}: ${toolDetail(m, tool)}` });
  })}`;
}

/** "6 of 19 pages · 2 editable", for a moderator's collapsed block on phones. */
function accessCount(m: MemberAccess): string {
  const open = AREA_KEYS.filter((a) => levelOf(m.access, a) !== 'none').length;
  const edit = AREA_KEYS.filter((a) => levelOf(m.access, a) === 'edit').length;
  return `${open} of ${plural(AREA_KEYS.length, 'page')}${edit ? ` · ${edit} editable` : ' · view only'}`;
}

export function registerMemberRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const nameOf = (m: { display_name: string | null; username: string }) => m.display_name ?? m.username;

  async function renderMembers(ctx: WorkspaceRequestContext, reply: FastifyReply, o: { invite?: boolean; inviteUrl?: string; inviteRole?: string } = {}) {
    const b = ctx.base;
    const ws = ctx.workspace;
    const [members, invites] = await Promise.all([listMembers(deps.db, ws.id), listInvites(deps.db, ws.id)]);
    type Member = (typeof members)[number];
    const owner = can(ctx.membership, 'members');
    const mods = members.filter((m) => m.role === 'moderator');
    const showInvite = owner && (o.invite || o.inviteUrl);

    const rowMenu = (m: Member) => {
      if (m.role === 'owner' || m.id === ctx.user.id) return '';
      const name = nameOf(m);
      return menu([
        m.role === 'moderator' ? { href: `#mod-${m.id}`, label: 'Edit access', icon: 'sliders-horizontal' } : null,
        owner ? { dialog: `role-${m.id}`, label: 'Change role…', icon: 'user-cog' } : null,
        owner ? 'sep' : null,
        owner ? { post: `${b}/members/${m.id}/remove`, label: 'Remove from workspace…', icon: 'user-x', danger: true, confirm: { title: `Remove ${name} from the workspace?`, body: `${name} loses access to the console right away. Their Discord roles aren’t affected.`, label: 'Remove', danger: true } } : null,
      ], { csrf: ctx.csrf, label: `Actions for ${name}` });
    };

    const inviteCard = showInvite
      ? html`<div class="card readable" id="invite">
          <div class="card-h"><div><h2>Invite someone</h2><div class="desc">Creates a one-time link. Send it to them privately, for example in a Discord DM.</div></div>${iconBtn('x', 'Close invite', { size: 'sm', href: `${b}/members` })}</div>
          ${o.inviteUrl
            ? html`<div class="card-b"><div class="field"><label for="invite-url">${ROLE_LABELS[(o.inviteRole as Role) ?? 'moderator']} invite link</label>${copyField('invite-url', o.inviteUrl, 'Invite link')}
                <div class="hint">One use · expires in 7 days · it won’t be shown again, so copy it now.</div></div></div>
                <div class="card-f plain"><span></span><div class="end">${linkBtn(`${b}/members?invite=1#invite`, 'Create another', { variant: 'ghost', icon: 'plus' })}</div></div>`
            : html`<form method="post" action="${b}/members/invites">${csrfField(ctx.csrf)}
                <div class="card-b"><div class="invite-grid">
                  <span class="lbl" id="invite-role-label">Role</span>
                  <div class="stack gap-8">${segRadios('role', [{ value: 'moderator', label: 'Moderator' }, { value: 'admin', label: 'Admin' }], 'moderator', 'Role')}
                    <p class="small muted">Moderators start with the tickets inbox and contributor verifications, view only. Choose what else they can open under Moderator access once they join. Admins can change setup, panels and settings.</p></div>
                </div></div>
                <div class="card-f plain"><span></span><div class="end">${submitBtn('Create invite link', { variant: 'primary', icon: 'link', loading: 'Creating…' })}</div></div></form>`}
        </div>`
      : '';

    const memberTable = html`<div class="table-wrap only-desktop"><table>
        <thead><tr><th>Member</th><th>Role</th><th class="col-main">Access</th><th class="num">Joined</th><th class="actions"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${members.map((m) => html`<tr>
          <td><span class="who-cell">${avatar(nameOf(m), 28, { src: discordAvatar(m) })}<span><span class="name">${nameOf(m)}${m.id === ctx.user.id ? tag('You', { cls: 'subtle' }) : ''}</span><span class="sub">@${m.username}</span></span></span></td>
          <td>${tag(ROLE_LABELS[m.role])}</td>
          <td><div class="tags">${accessTags(m)}</div></td>
          <td class="num">${when(m.joined_at)}</td>
          <td class="actions">${rowMenu(m)}</td></tr>`)}</tbody></table></div>
      <ul class="list only-mobile">${members.map((m) => html`<li><div class="list-row">
        <span class="who-cell">${avatar(nameOf(m), 32, { src: discordAvatar(m) })}<span><span class="name">${nameOf(m)}${m.id === ctx.user.id ? tag('You', { cls: 'subtle' }) : ''}</span><span class="sub">${ROLE_LABELS[m.role]} · @${m.username}</span></span></span>${rowMenu(m)}</div></li>`)}</ul>`;

    const pending = invites.length
      ? html`<div class="sub-h">Pending invites · ${String(invites.length)}</div>
          ${invites.map((i) => html`<div class="line"><span class="av av-28 pending" aria-hidden="true"></span>
            <div class="grow"><div class="name">${ROLE_LABELS[i.role]} invite</div><div class="sub">Created${i.created_by_name ? ` by ${i.created_by_name}` : ''} ${timeAgo(i.created_at)} · expires ${timeAgo(i.expires_at)}</div></div>
            ${owner ? menu([{ post: `${b}/members/invites/${i.id}/revoke`, label: 'Revoke invite', icon: 'link-2-off', danger: true, confirm: { title: 'Revoke this invite?', body: 'The link stops working right away.', label: 'Revoke invite', danger: true } }], { csrf: ctx.csrf, label: 'Invite actions' }) : ''}</div>`)}`
      : '';

    // ---- Moderator access: pages (rows, grouped by tool) × moderators (columns) ----------------

    // Each moderator's selects belong to a hidden form that saves right away (one for the table, one for phones).
    const formId = (m: Member, mobile: boolean) => `acc-${mobile ? 'm-' : ''}${m.id}`;
    const accessForm = (m: Member, mobile: boolean) => html`<form id="${formId(m, mobile)}" method="post" action="${b}/members/${m.id}/access" data-async hidden>${csrfField(ctx.csrf)}</form>`;
    const levelSelect = (m: Member, a: Area, mobile: boolean) => {
      const level = levelOf(m.access, a);
      return selectWrap(html`<select name="${a}" form="${formId(m, mobile)}" class="level-select" data-level="${level}" data-tool="${AREAS[a].tool}" aria-label="${nameOf(m)}: ${areaLabel(a)}">${levelsFor(a).map((l) => html`<option value="${l}" ${l === level ? raw('selected') : ''}>${LEVEL_NAMES[l]}</option>`)}</select>`, { sm: true, cls: 'level' });
    };
    // Sets every page (or a whole tool) at once; shows Custom when those pages differ.
    const setSelect = (m: Member, mobile: boolean, tool?: Tool) => {
      const current = uniformLevel(m, tool ? areasOf(tool) : AREA_KEYS);
      const label = tool ? `every ${TOOL_NAMES[tool]} page` : 'every page';
      return selectWrap(html`<select class="set-select" data-set-levels="${formId(m, mobile)}" ${tool ? html`data-set-group="${tool}"` : ''} data-level="${current ?? 'custom'}" aria-label="${nameOf(m)}: ${label}"><option value="" ${current ? '' : raw('selected')} disabled hidden>Custom</option>${(['none', 'view', 'edit'] as const).map((l) => html`<option value="${l}" ${l === current ? raw('selected') : ''}>${SET_NAMES[l]}</option>`)}</select>`, { sm: true, cls: 'level' });
    };
    const who = (m: Member) => html`<span class="who-cell">${avatar(nameOf(m), 24, { src: discordAvatar(m) })}<span><span class="name"><span class="truncate">${nameOf(m)}</span></span><span class="sub truncate">@${m.username}</span></span></span>`;
    const cells = (render: (m: Member) => SafeHtml | string) => mods.map((m) => html`<td class="lv" data-col="${m.id}">${render(m)}</td>`);
    // The Inbox can't be turned off: say so next to its name.
    const always = (a: Area) => ((AREAS[a] as AreaDef).min ? tag('Always visible', { cls: 'subtle', title: 'Moderators can always see the tickets inbox.' }) : '');
    const pageLabel = (name: SafeHtml | string, desc: string) => html`<div class="l">${name}</div><div class="d">${desc}</div>`;

    const matrix = html`<div class="table-wrap only-desktop"><table class="access-matrix">
        <thead><tr><th class="page-col" scope="col">Page</th>${mods.map((m) => html`<th class="lv" scope="col" id="mod-${m.id}" title="${nameOf(m)}" data-flash data-flash-col="${m.id}" data-flash-alt="mod-m-${m.id}">${who(m)}</th>`)}</tr></thead>
        <tbody class="all"><tr><th class="page-col" scope="row">${pageLabel('All pages', 'Set every page at once.')}</th>${cells((m) => setSelect(m, false))}</tr></tbody>
        ${TOOLS.map((tool) => {
          const areas = areasOf(tool);
          return html`<tbody>
            <tr class="tool-h"><th class="page-col" scope="rowgroup"><span class="tool-name">${icon(TOOL_ICONS[tool], 16)}${TOOL_NAMES[tool]}</span></th>${cells((m) => (areas.length > 1 ? setSelect(m, false, tool) : ''))}</tr>
            ${areas.map((a) => html`<tr><th class="page-col" scope="row">${pageLabel(html`${AREAS[a].name}${always(a)}`, AREAS[a].desc)}</th>${cells((m) => levelSelect(m, a, false))}</tr>`)}
          </tbody>`;
        })}
        <tfoot class="nojs"><tr><th class="page-col"></th>${cells((m) => html`<button type="submit" class="btn sm" form="${formId(m, false)}">Save</button>`)}</tr></tfoot>
      </table></div>`;

    const mobileBlocks = html`<div class="only-mobile">${mods.map((m) => html`<details class="mod-block" id="mod-m-${m.id}" data-flash ${mods.length === 1 ? raw('open') : ''}>
        <summary>${who(m)}<span class="count">${accessCount(m)}</span>${icon('chevron-down', 16, 'chev')}</summary>
        <div class="acc-row all"><div><div class="lbl">All pages</div><div class="desc">Set every page at once.</div></div>${setSelect(m, true)}</div>
        ${TOOLS.map((tool) => {
          const areas = areasOf(tool);
          return html`<div class="acc-tool"><span class="tool-name">${icon(TOOL_ICONS[tool], 16)}${TOOL_NAMES[tool]}</span>${areas.length > 1 ? setSelect(m, true, tool) : ''}</div>
            ${areas.map((a) => html`<div class="acc-row"><div><div class="lbl">${AREAS[a].name}${always(a)}</div><div class="desc">${AREAS[a].desc}</div></div>${levelSelect(m, a, true)}</div>`)}`;
        })}
        <div class="nojs card-b tight"><button type="submit" class="btn sm" form="${formId(m, true)}">Save</button></div></details>`)}</div>`;

    // A few moderators fit a readable width (and the moderators' names follow you down the page);
    // more use the whole window, then scroll sideways beside the page names.
    const modAccess = html`<div class="card access-card${mods.length <= 4 ? ` readable cols-${mods.length}` : ''}" id="moderator-access">
      <div class="card-h"><div><h2>Moderator access</h2><div class="desc">What each moderator can open, tool by tool. <strong>View</strong> shows a page with its controls turned off; <strong>Edit</strong> lets them change it. GitHub and Discord connections, workspace settings, deployment and members stay with admins.</div></div></div>
      ${mods.length
        ? html`${mods.map((m) => html`${accessForm(m, false)}${accessForm(m, true)}`)}
            ${matrix}
            ${mobileBlocks}
            <div class="card-note">Changes apply right away. Applying or dismissing AI suggestions, on Review, tickets or issues, needs Edit on Review. “Use these settings” on a re-run also needs Edit on Actions, Label groups and Prompt. Edit on Apps &amp; repositories lets them add, change and remove apps; updating the panel in Discord needs Edit on Discord tickets › Panel.</div>`
        : empty('users', 'No moderators yet', 'Moderators can read the tickets inbox. Invite someone as a moderator, then choose what else they can open here.', owner ? linkBtn(`${b}/members?invite=1#invite`, 'Invite', { icon: 'user-plus' }) : null)}
    </div>`;

    const mark = (v: string) => (v === 'yes' ? html`${icon('circle-check', 16, 'ok')}<span class="sr-only">Yes</span>` : v === 'maybe' ? html`<span class="xs muted">If allowed</span>` : html`<span class="em" aria-label="No">—</span>`);
    const body = html`
      ${pageHeader({
        title: 'Members & permissions',
        description: 'Who can open this console and what they can do.',
        actions: owner && !showInvite ? linkBtn(`${b}/members?invite=1#invite`, 'Invite', { variant: 'primary', icon: 'user-plus' }) : undefined,
      })}
      ${inviteCard}
      <div class="card">
        <div class="card-h"><div><div class="title"><h2>Members</h2>${badge(members.length)}</div><div class="desc inline">${icon('lock', 14)}Only the owner can invite people and change roles.</div></div></div>
        <div class="card-b flush">${memberTable}</div>
        ${pending}
      </div>
      ${modAccess}
      <details class="card">
        <summary>${icon('info')}<span>What each role can do</span>${icon('chevron-down', 16, 'chev')}</summary>
        <div class="table-wrap"><table>
          <thead><tr><th class="col-main">Capability</th><th class="center">Owner</th><th class="center">Admin</th><th class="center">Moderator</th></tr></thead>
          <tbody>${CAPABILITIES.map(([c, o1, a, m]) => html`<tr><td>${c}</td><td class="center">${mark(o1)}</td><td class="center">${mark(a)}</td><td class="center">${mark(m)}</td></tr>`)}</tbody></table></div>
      </details>
      ${owner ? members.filter((m) => m.role !== 'owner').map((m) => dialog(`role-${m.id}`, {
        title: `Change ${nameOf(m)}’s role`,
        action: `${b}/members/${m.id}/role`,
        csrf: ctx.csrf,
        body: choices('role', [
          { value: 'admin', title: 'Admin', desc: 'Everything except inviting people and changing roles.' },
          { value: 'moderator', title: 'Moderator', desc: 'The tickets inbox, plus the pages chosen under Moderator access.' },
        ], m.role),
        submit: submitBtn('Save', { variant: 'primary' }),
      })) : ''}`;
    return web.render(reply, ctx, 'Members & permissions', 'members', body, { width: 'full' });
  }

  app.get('/w/:wid/members', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    return renderMembers(ctx, reply, { invite: (req.query as { invite?: string }).invite === '1' });
  });

  app.post('/w/:wid/members/invites', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'members' });
    if (!ctx) return reply;
    const role = (req.body as { role?: string }).role === 'admin' ? 'admin' : 'moderator';
    const token = await createInvite(deps.db, ctx.workspace.id, ctx.user.id, role);
    return renderMembers(ctx, reply, { inviteUrl: web.publicUrl(`/invite/${token}`), inviteRole: role });
  });

  app.post('/w/:wid/members/invites/:inviteId/revoke', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'members' });
    if (!ctx) return reply;
    await revokeInvite(deps.db, ctx.workspace.id, (req.params as { inviteId: string }).inviteId);
    setFlash(reply, 'success', 'Invite revoked');
    return reply.redirect(`${ctx.base}/members`);
  });

  app.post('/w/:wid/members/:userId/role', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'members' });
    if (!ctx) return reply;
    const role = (req.body as { role?: string }).role;
    try {
      if (role !== 'admin' && role !== 'moderator') throw new UserFacingError('Choose Admin or Moderator.');
      await setMemberRole(deps.db, ctx.workspace.id, (req.params as { userId: string }).userId, role);
      setFlash(reply, 'success', `Role changed to ${ROLE_LABELS[role]}`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/members`);
  });

  /**
   * Owners and admins set what a moderator can open, page by page. The selects send every page
   * of that moderator (JSON reply); a plain form works the same without JavaScript.
   */
  app.post('/w/:wid/members/:userId/access', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'manage' });
    if (!ctx) return reply;
    const userId = (req.params as { userId: string }).userId;
    try {
      const before = (await listMembers(deps.db, ctx.workspace.id)).find((m) => m.id === userId);
      const next = await setModeratorAccess(deps.db, ctx.workspace.id, userId, (req.body ?? {}) as Record<string, unknown>);
      const changed = AREA_KEYS.filter((a) => levelOf(before?.access, a) !== levelOf(next, a));
      // A few changes are listed. More come from a tool's select or All pages: "AI triage → Edit all".
      const after: MemberAccess = { role: 'moderator', access: next };
      const tools = [...new Set(changed.map((a) => AREAS[a].tool))];
      const all = uniformLevel(after, AREA_KEYS);
      const tool = tools.length === 1 ? uniformLevel(after, areasOf(tools[0]!)) : null;
      const what = !changed.length
        ? 'access saved'
        : changed.length <= 4
          ? changed.map((a) => `${changeName(a)} → ${LEVEL_NAMES[levelOf(next, a)]}`).join(', ')
          : tools.length > 1 && all ? `All pages → ${SET_NAMES[all]}`
          : tool ? `${TOOL_NAMES[tools[0]!]} → ${SET_NAMES[tool]}`
          : `${changed.length} pages changed`;
      const message = `${before ? nameOf(before) : 'Moderator'}: ${what}`;
      if (web.wantsJson(req)) return reply.send({ ok: true, message });
      setFlash(reply, 'success', message);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      if (web.wantsJson(req)) return reply.code(err.status).send({ ok: false, error: err.message });
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/members#moderator-access`);
  });

  app.post('/w/:wid/members/:userId/remove', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'members' });
    if (!ctx) return reply;
    try {
      await removeMember(deps.db, ctx.workspace.id, (req.params as { userId: string }).userId);
      setFlash(reply, 'success', 'Member removed');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/members`);
  });
}
