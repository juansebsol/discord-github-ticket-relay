import type { FastifyInstance, FastifyReply } from 'fastify';
import { can, PAGE_AREA_NAMES, PAGE_AREAS, pageLevel, ROLE_LABELS, TRIAGE_AREA_NAMES, TRIAGE_AREAS, triageLevel, VIEW_ONLY_AREAS, type AccessLevel, type MemberAccess, type PageArea, type TriageArea } from '../../domain/permissions.js';
import { UserFacingError, type Role } from '../../domain/types.js';
import { createInvite, listInvites, listMembers, removeMember, revokeInvite, setMemberRole, setModeratorPageAccess, setModeratorPermissions, setModeratorTriageAccess } from '../../domain/workspaces.js';
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
  locked,
  menu,
  pageHeader,
  segRadios,
  selectWrap,
  setting,
  submitBtn,
  switchInput,
  tag,
  timeAgo,
  when,
} from '../ui.js';

const PERMS = [
  { key: 'view', label: 'See tickets', desc: 'Inbox, ticket text and GitHub link.' },
  { key: 'act', label: 'Act on tickets', desc: 'Retry, link, close, add or delete files.' },
  { key: 'contrib', label: 'See verifications', desc: 'Who verified and their role.' },
  { key: 'issues', label: 'Search all issues', desc: 'The Issues tab.' },
  { key: 'files', label: 'Clean up files', desc: 'The Files tab.' },
  { key: 'health', label: 'See server health', desc: 'The Server health page.' },
  { key: 'revoke', label: 'Revoke roles', desc: 'Remove contributor roles.' },
] as const;

/** The switches an admin can turn on for a moderator, in table order. */
const MOD_SWITCHES = [
  { field: 'can_act_tickets', perm: PERMS[1] },
  { field: 'can_view_contributors', perm: PERMS[2] },
  { field: 'can_search_issues', perm: PERMS[3] },
  { field: 'can_manage_files', perm: PERMS[4] },
  { field: 'can_view_health', perm: PERMS[5] },
] as const;
type ModField = (typeof MOD_SWITCHES)[number]['field'];

const CAPABILITIES: [string, string, string, string][] = [
  ['GitHub, Discord, panels and settings', 'yes', 'yes', 'no'],
  ['Apps & repositories (view or edit)', 'yes', 'yes', 'maybe'],
  ['Ticket forms and file rules', 'yes', 'yes', 'no'],
  ['Triage pages (view or edit, page by page)', 'yes', 'yes', 'maybe'],
  ['Tickets inbox', 'yes', 'yes', 'yes'],
  ['Act on tickets', 'yes', 'yes', 'maybe'],
  ['Contributor verifications', 'yes', 'yes', 'maybe'],
  ['Search all issues', 'yes', 'yes', 'maybe'],
  ['Clean up files', 'yes', 'yes', 'maybe'],
  ['Server health', 'yes', 'yes', 'maybe'],
  ['Revoke contributor roles', 'yes', 'yes', 'no'],
  ['Invite people and change roles', 'yes', 'no', 'no'],
];

/** What each setup page covers, for the access table. */
const PAGE_AREA_DESC: Record<PageArea, string> = {
  apps: 'Apps and their repositories.',
};

/** What each Triage page covers, for the access table. */
const TRIAGE_AREA_DESC: Record<TriageArea, string> = {
  actions: 'Switches, actions, rules and limits.',
  labels: 'Label groups and their options.',
  prompt: 'What Claude is told.',
  runs: 'Previews and applying their results.',
  activity: 'What triage did, live.',
};
const LEVEL_NAMES: Record<AccessLevel, string> = { none: 'No access', view: 'View', edit: 'Edit' };

/** A moderator's Triage access in a few words: "Triage: view", "Triage · 3 pages". */
function triageSummary(m: MemberAccess): string | null {
  const levels = TRIAGE_AREAS.map((a) => triageLevel(m.triage_access, a));
  const on = levels.filter((l) => l !== 'none').length;
  if (!on) return null;
  const top = TRIAGE_AREAS.map((a) => (VIEW_ONLY_AREAS.has(a) ? 'view' : 'edit'));
  if (on === TRIAGE_AREAS.length && levels.every((l, i) => l === top[i])) return 'Triage: edit';
  if (levels.every((l) => l === 'view')) return 'Triage: view';
  return `Triage · ${on} of ${TRIAGE_AREAS.length} pages`;
}

function accessTags(m: MemberAccess): SafeHtml {
  if (m.role === 'owner') return html`${tag('Full access')}${tag('Invites & roles')}`;
  if (m.role === 'admin') return tag('Full access');
  const triage = triageSummary(m);
  const pages = PAGE_AREAS.filter((a) => pageLevel(m.page_access, a) !== 'none').map((a) => tag(`${a === 'apps' ? 'Apps' : PAGE_AREA_NAMES[a]}: ${pageLevel(m.page_access, a)}`));
  return html`${pages}${tag(m.can_act_tickets ? 'Act on tickets' : 'View tickets')}${m.can_view_contributors ? tag('Verifications') : ''}${m.can_search_issues ? tag('Issue search') : ''}${m.can_manage_files ? tag('Files') : ''}${m.can_view_health ? tag('Server health') : ''}${triage ? tag(triage) : ''}`;
}

export function registerMemberRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  async function renderMembers(ctx: WorkspaceRequestContext, reply: FastifyReply, o: { invite?: boolean; inviteUrl?: string; inviteRole?: string } = {}) {
    const b = ctx.base;
    const ws = ctx.workspace;
    const [members, invites] = await Promise.all([listMembers(deps.db, ws.id), listInvites(deps.db, ws.id)]);
    const owner = can(ctx.membership, 'members');
    const mods = members.filter((m) => m.role === 'moderator');
    const nameOf = (m: { display_name: string | null; username: string }) => m.display_name ?? m.username;
    const showInvite = owner && (o.invite || o.inviteUrl);

    const rowMenu = (m: (typeof members)[number]) => {
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
                    <p class="small muted">Moderators start view-only; adjust their access under Moderator access after they join. Admins can change setup, panels and settings.</p></div>
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

    const permForm = (m: (typeof members)[number], suffix: string) => html`<form id="perm-${suffix}${m.id}" method="post" action="${b}/members/${m.id}/permissions" data-async hidden>${csrfField(ctx.csrf)}</form>`;
    const permSwitch = (m: (typeof members)[number], suffix: string, field: ModField, label: string) =>
      switchInput({ name: field, checked: m[field], label: `${nameOf(m)}: ${label}`, attrs: html`form="perm-${suffix}${m.id}"` });

    const modAccess = html`<div class="card" id="moderator-access">
      <div class="card-h"><div><h2>Moderator access</h2><div class="desc">New moderators start view-only. The pages they can open, like Apps &amp; repositories and Triage, are set below in Page access. GitHub, Discord, panels and settings stay with admins.</div></div></div>
      ${mods.length
        ? html`${mods.map((m) => html`${permForm(m, '')}${permForm(m, 'm-')}`)}
            <div class="table-wrap only-desktop"><table>
              <thead><tr><th class="th-perm"><div class="l">Moderator</div></th>${PERMS.map((p) => html`<th class="th-perm"><div class="l">${p.label}</div><div class="d">${p.desc}</div></th>`)}</tr></thead>
              <tbody>${mods.map((m) => html`<tr id="mod-${m.id}" data-flash>
                <td class="perm"><span class="who-cell">${avatar(nameOf(m), 24, { src: discordAvatar(m) })}<span class="name">${nameOf(m)}</span></span></td>
                <td class="perm">${locked('Always')}</td>
                ${MOD_SWITCHES.map((x) => html`<td class="perm">${permSwitch(m, '', x.field, x.perm.label)}</td>`)}
                <td class="perm"><span class="row">${locked('Admins only')}<button type="submit" class="btn sm nojs" form="perm-${m.id}">Save</button></span></td></tr>`)}</tbody></table></div>
            <div class="only-mobile">${mods.map((m) => html`<div class="mod-block">
              <div class="line"><span class="who-cell">${avatar(nameOf(m), 24, { src: discordAvatar(m) })}<span class="name">${nameOf(m)}</span></span></div>
              ${setting(PERMS[0].label, PERMS[0].desc, locked('Always'), { switchRow: true })}
              ${MOD_SWITCHES.map((x) => setting(x.perm.label, x.perm.desc, permSwitch(m, 'm-', x.field, x.perm.label), { switchRow: true }))}
              ${setting(PERMS[6].label, PERMS[6].desc, locked('Admins only'), { switchRow: true })}
              <div class="nojs card-b tight"><button type="submit" class="btn sm" form="perm-m-${m.id}">Save</button></div></div>`)}</div>
            <div class="card-note">Changes apply right away.</div>`
        : empty('users', 'No moderators yet', 'Moderators can read the tickets inbox. Invite someone as a moderator, then choose what else they can do here.', owner ? linkBtn(`${b}/members?invite=1#invite`, 'Invite', { icon: 'user-plus' }) : null)}
    </div>`;

    const levelOptions = (levels: AccessLevel[], level: AccessLevel) => levels.map((l) => html`<option value="${l}" ${l === level ? raw('selected') : ''}>${LEVEL_NAMES[l]}</option>`);
    const levelSelect = (m: (typeof members)[number], area: TriageArea, suffix: string) => {
      const level = triageLevel(m.triage_access, area);
      const levels: AccessLevel[] = VIEW_ONLY_AREAS.has(area) ? ['none', 'view'] : ['none', 'view', 'edit'];
      return selectWrap(html`<select name="${area}" form="tri-${suffix}${m.id}" class="level-select" data-level="${level}" aria-label="${nameOf(m)}: ${TRIAGE_AREA_NAMES[area]}">${levelOptions(levels, level)}</select>`, { sm: true });
    };
    const pageSelect = (m: (typeof members)[number], area: PageArea, suffix: string) => {
      const level = pageLevel(m.page_access, area);
      return selectWrap(html`<select name="${area}" form="pg-${suffix}${m.id}" class="level-select" data-level="${level}" aria-label="${nameOf(m)}: ${PAGE_AREA_NAMES[area]}">${levelOptions(['none', 'view', 'edit'], level)}</select>`, { sm: true });
    };
    // "All Triage pages" sets every Triage page at once (Activity goes up to View); it shows Custom when they differ.
    const allSelect = (m: (typeof members)[number], suffix: string) => {
      const levels = TRIAGE_AREAS.map((a) => triageLevel(m.triage_access, a));
      const same = (l: AccessLevel) => TRIAGE_AREAS.every((a, i) => levels[i] === (l === 'edit' && VIEW_ONLY_AREAS.has(a) ? 'view' : l));
      const current = (['none', 'view', 'edit'] as const).find(same) ?? '';
      return selectWrap(html`<select data-set-levels="tri-${suffix}${m.id}" aria-label="${nameOf(m)}: every Triage page"><option value="" ${current ? '' : raw('selected')} disabled hidden>Custom</option>${(['none', 'view', 'edit'] as const).map((l) => html`<option value="${l}" ${l === current ? raw('selected') : ''}>${l === 'none' ? 'No access' : l === 'view' ? 'View all' : 'Edit all'}</option>`)}</select>`, { sm: true });
    };
    const accessForms = (m: (typeof members)[number]) => html`${['', 'm-'].map((suffix) => html`<form id="pg-${suffix}${m.id}" method="post" action="${b}/members/${m.id}/page-access" data-async hidden>${csrfField(ctx.csrf)}</form><form id="tri-${suffix}${m.id}" method="post" action="${b}/members/${m.id}/triage-access" data-async hidden>${csrfField(ctx.csrf)}</form>`)}`;
    const pageAccess = mods.length ? html`<div class="card" id="page-access">
      <div class="card-h"><div><h2>Page access</h2><div class="desc">Pages each moderator can open, and whether they can change them. <strong>View</strong> shows the page with every control turned off; <strong>Edit</strong> lets them change it. Moderators start with no access.</div></div></div>
      ${mods.map(accessForms)}
      <div class="table-wrap only-desktop"><table class="access-table">
        <thead>
          <tr class="group-h"><th class="th-perm" rowspan="2"><div class="l">Moderator</div></th><th class="th-perm grp" colspan="${String(PAGE_AREAS.length)}"><div class="g">${icon('boxes', 14)}General setup</div></th><th class="th-perm grp" colspan="${String(TRIAGE_AREAS.length + 1)}"><div class="g">${icon('ticket', 14)}Tickets › Triage</div></th></tr>
          <tr>${PAGE_AREAS.map((a) => html`<th class="th-perm"><div class="l">${PAGE_AREA_NAMES[a]}</div><div class="d">${PAGE_AREA_DESC[a]}</div></th>`)}<th class="th-perm group-start"><div class="l">All Triage pages</div><div class="d">Set them all at once.</div></th>${TRIAGE_AREAS.map((a) => html`<th class="th-perm"><div class="l">${TRIAGE_AREA_NAMES[a]}</div><div class="d">${TRIAGE_AREA_DESC[a]}</div></th>`)}</tr>
        </thead>
        <tbody>${mods.map((m) => html`<tr>
          <td class="perm"><span class="who-cell">${avatar(nameOf(m), 24, { src: discordAvatar(m) })}<span class="name">${nameOf(m)}</span></span></td>
          ${PAGE_AREAS.map((a) => html`<td class="perm">${pageSelect(m, a, '')}</td>`)}
          <td class="perm group-start all-col">${allSelect(m, '')}</td>
          ${TRIAGE_AREAS.map((a) => html`<td class="perm">${levelSelect(m, a, '')}</td>`)}
        </tr>`)}</tbody></table></div>
      <div class="only-mobile">${mods.map((m) => html`<div class="mod-block">
        <div class="line"><span class="who-cell">${avatar(nameOf(m), 24, { src: discordAvatar(m) })}<span class="name">${nameOf(m)}</span></span></div>
        <div class="sub-h">General setup</div>
        ${PAGE_AREAS.map((a) => setting(PAGE_AREA_NAMES[a], PAGE_AREA_DESC[a], pageSelect(m, a, 'm-')))}
        <div class="sub-h">Tickets › Triage</div>
        ${setting('All Triage pages', 'Set them all at once.', allSelect(m, 'm-'))}
        ${TRIAGE_AREAS.map((a) => setting(TRIAGE_AREA_NAMES[a], TRIAGE_AREA_DESC[a], levelSelect(m, a, 'm-')))}</div>`)}</div>
      <div class="card-note">Changes apply right away. Edit on Apps &amp; repositories lets them add, change and remove apps, and pick any repository the GitHub App can access; updating the panel in Discord stays with admins. “Use these settings” on a re-run also needs Edit on Actions, Label groups and Prompt. Applying suggestions on tickets is set by “Act on tickets” above.</div>
    </div>` : '';

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
      ${pageAccess}
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
          { value: 'moderator', title: 'Moderator', desc: 'Tickets inbox, view-only by default. Access is set under Moderator access.' },
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

  /** Owners and admins scope what a moderator can do. Called by the switches (JSON) or a plain form. */
  app.post('/w/:wid/members/:userId/permissions', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'manage' });
    if (!ctx) return reply;
    const userId = (req.params as { userId: string }).userId;
    const body = req.body as Partial<Record<ModField, string>>;
    const next = {
      canActTickets: body.can_act_tickets !== undefined,
      canViewContributors: body.can_view_contributors !== undefined,
      canSearchIssues: body.can_search_issues !== undefined,
      canManageFiles: body.can_manage_files !== undefined,
      canViewHealth: body.can_view_health !== undefined,
    };
    try {
      const before = (await listMembers(deps.db, ctx.workspace.id)).find((m) => m.id === userId);
      await setModeratorPermissions(deps.db, ctx.workspace.id, userId, next);
      const name = before ? before.display_name ?? before.username : 'Moderator';
      const values: Record<ModField, boolean> = { can_act_tickets: next.canActTickets, can_view_contributors: next.canViewContributors, can_search_issues: next.canSearchIssues, can_manage_files: next.canManageFiles, can_view_health: next.canViewHealth };
      const changes = MOD_SWITCHES.filter((x) => before && before[x.field] !== values[x.field]).map((x) => `${x.perm.label} ${values[x.field] ? 'on' : 'off'}`);
      const message = `${name}: ${changes.length ? changes.join(', ') : 'access saved'}`;
      if (web.wantsJson(req)) return reply.send({ ok: true, message });
      setFlash(reply, 'success', message);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      if (web.wantsJson(req)) return reply.code(err.status).send({ ok: false, error: err.message });
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/members`);
  });

  /** Owners and admins set a moderator's access to setup pages such as Apps & repositories (JSON from the selects, or a form). */
  app.post('/w/:wid/members/:userId/page-access', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'manage' });
    if (!ctx) return reply;
    const userId = (req.params as { userId: string }).userId;
    try {
      const before = (await listMembers(deps.db, ctx.workspace.id)).find((m) => m.id === userId);
      const next = await setModeratorPageAccess(deps.db, ctx.workspace.id, userId, req.body as Record<string, string>);
      const name = before ? before.display_name ?? before.username : 'Moderator';
      const changes = PAGE_AREAS.filter((a) => pageLevel(before?.page_access, a) !== pageLevel(next, a)).map((a) => `${PAGE_AREA_NAMES[a]} → ${LEVEL_NAMES[pageLevel(next, a)]}`);
      const message = `${name}: ${changes.length ? changes.join(', ') : 'Access saved'}`;
      if (web.wantsJson(req)) return reply.send({ ok: true, message });
      setFlash(reply, 'success', message);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      if (web.wantsJson(req)) return reply.code(err.status).send({ ok: false, error: err.message });
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/members#page-access`);
  });

  /** Owners and admins set a moderator's access to each Triage page (JSON from the selects, or a form). */
  app.post('/w/:wid/members/:userId/triage-access', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'manage' });
    if (!ctx) return reply;
    const userId = (req.params as { userId: string }).userId;
    try {
      const before = (await listMembers(deps.db, ctx.workspace.id)).find((m) => m.id === userId);
      const next = await setModeratorTriageAccess(deps.db, ctx.workspace.id, userId, req.body as Record<string, string>);
      const name = before ? before.display_name ?? before.username : 'Moderator';
      const changes = TRIAGE_AREAS.filter((a) => triageLevel(before?.triage_access, a) !== triageLevel(next, a)).map((a) => `${TRIAGE_AREA_NAMES[a]} → ${LEVEL_NAMES[triageLevel(next, a)]}`);
      const message = `${name}: ${changes.length ? changes.join(', ') : 'Triage access saved'}`;
      if (web.wantsJson(req)) return reply.send({ ok: true, message });
      setFlash(reply, 'success', message);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      if (web.wantsJson(req)) return reply.code(err.status).send({ ok: false, error: err.message });
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/members#page-access`);
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
