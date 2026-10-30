import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  AREA_KEYS,
  AREAS,
  areaLabel,
  areasOf,
  can,
  levelOf,
  MCP_GROUPS,
  MCP_SWITCH_KEYS,
  MCP_SWITCHES,
  mcpSwitches,
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
import { createInvite, listInvites, listMembers, removeMember, revokeInvite, setMcpAccess, setMemberRole, setModeratorAccess } from '../../domain/workspaces.js';
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
  switchInput,
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
  ['Moderation: close, reopen and sort out tickets on GitHub', 'yes', 'yes', 'maybe'],
  ['Contributor roles', 'yes', 'yes', 'maybe'],
  ['Announcements: write and post messages in Discord', 'yes', 'yes', 'maybe'],
  ['Bot features: the known-issues board and GitHub releases', 'yes', 'yes', 'maybe'],
  ['Apps & repositories', 'yes', 'yes', 'maybe'],
  ['Server health', 'yes', 'yes', 'maybe'],
  ['File cleanup rules and storage limit', 'yes', 'yes', 'no'],
  ['GitHub and Discord connections', 'yes', 'yes', 'no'],
  ['Workspace settings, Claude key and deployment', 'yes', 'yes', 'no'],
  ['Invite people and change roles', 'yes', 'no', 'no'],
];

/** Short tool names for the access tags in the members table. */
const TOOL_TAGS: Record<Tool, string> = { tickets: 'Tickets', issues: 'Issues', repos: 'Repos', analytics: 'Analytics', triage: 'Triage', moderation: 'Mod', contributors: 'Roles', announcements: 'Announce', bot: 'Bot', setup: 'Apps', workspace: 'Health' };
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
  const mcp = mcpSwitches(m);
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
  })}${mcp.length ? tag(`MCP · ${mcp.length}`, { title: `MCP tools: ${mcp.map((k) => MCP_SWITCHES[k].name).join(', ')}` }) : ''}`;
}

/** "No tools", "4 of 17 tools · read only", "9 of 17 tools · 3 actions" (app.js writes the same after a change). */
function mcpSummary(m: MemberAccess): string {
  const on = mcpSwitches(m);
  if (!on.length) return 'No tools';
  const acts = on.filter((k) => MCP_SWITCHES[k].group === 'act').length;
  return `${on.length} of ${MCP_SWITCH_KEYS.length} tools · ${acts ? `${acts} ${acts === 1 ? 'action' : 'actions'}` : 'read only'}`;
}

/** Pages a moderator can open (the Inbox included). */
const openCount = (m: MemberAccess) => AREA_KEYS.filter((a) => levelOf(m.access, a) !== 'none').length;

/** "6 of 20 pages open · 2 editable" (app.js writes the same after a change). */
function accessCount(m: MemberAccess): string {
  const edit = AREA_KEYS.filter((a) => levelOf(m.access, a) === 'edit').length;
  return `${openCount(m)} of ${plural(AREA_KEYS.length, 'page')} open${edit ? ` · ${edit} editable` : ' · view only'}`;
}

/** For the moderator list's filters: can edit something, view only, or just the inbox. */
function accessKind(m: MemberAccess): 'edit' | 'view' | 'inbox' {
  if (AREA_KEYS.some((a) => levelOf(m.access, a) === 'edit')) return 'edit';
  return openCount(m) <= 1 ? 'inbox' : 'view';
}

/** "3 pages · 2 edit", "6 pages · view only", "Inbox only" (app.js writes the same after a change). */
function pickSummary(m: MemberAccess): string {
  const kind = accessKind(m);
  if (kind === 'inbox') return 'Inbox only';
  const edit = AREA_KEYS.filter((a) => levelOf(m.access, a) === 'edit').length;
  return `${openCount(m)} pages · ${edit ? `${edit} edit` : 'view only'}`;
}

/** A tool is open when it gives more than the minimum (the Inbox is always visible, so it doesn't count). */
function toolOpen(m: MemberAccess, tool: Tool): boolean {
  return areasOf(tool).some((a) => levelOf(m.access, a) !== levelsFor(a)[0]);
}

/** "3 of 5 pages · 1 editable", "Edit", "No access" (app.js writes the same after a change). */
function toolSummary(m: MemberAccess, tool: Tool): string {
  const areas = areasOf(tool);
  if (!toolOpen(m, tool)) return tool === 'tickets' ? 'Only the inbox, view only' : 'No access';
  const open = areas.filter((a) => levelOf(m.access, a) !== 'none').length;
  const edit = areas.filter((a) => levelOf(m.access, a) === 'edit').length;
  if (areas.length === 1) return edit ? 'Edit' : 'View';
  return `${open} of ${areas.length} pages${edit ? ` · ${edit} editable` : ' · view only'}`;
}

export function registerMemberRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const nameOf = (m: { display_name: string | null; username: string }) => m.display_name ?? m.username;

  async function renderMembers(ctx: WorkspaceRequestContext, reply: FastifyReply, o: { invite?: boolean; inviteUrl?: string; inviteRole?: string; mod?: string } = {}) {
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
        m.role === 'moderator' ? { href: `${b}/members?mod=${m.id}#moderator-access`, label: 'Edit access', icon: 'sliders-horizontal' } : null,
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

    // ---- Moderator access: one moderator at a time, tool by tool --------------------------------

    // The moderator being edited: picked in the floating bar (?mod=), else the first.
    const selected = mods.find((m) => m.id === o.mod) ?? mods[0];
    // Each moderator's levels belong to a hidden form that saves on every change (JSON reply).
    const formId = (m: Member) => `acc-${m.id}`;
    const accessForm = (m: Member) => html`<form id="${formId(m)}" method="post" action="${b}/members/${m.id}/access" data-async hidden>${csrfField(ctx.csrf)}</form>`;
    // The Inbox can't be turned off: say so next to its name.
    const always = (a: Area) => ((AREAS[a] as AreaDef).min ? tag('Always visible', { cls: 'subtle', title: 'Moderators can always see the tickets inbox.' }) : '');
    // One page: No access / View / Edit, one click.
    const levelSeg = (m: Member, a: Area) => {
      const level = levelOf(m.access, a);
      return html`<div class="lvl-seg" role="radiogroup" aria-label="${nameOf(m)}: ${areaLabel(a)}">${levelsFor(a).map((l) => html`<label><input type="radio" name="${a}" value="${l}" form="${formId(m)}" data-tool="${AREAS[a].tool}" ${l === level ? raw('checked') : ''}><span>${LEVEL_NAMES[l]}</span></label>`)}</div>`;
    };
    const toolSection = (m: Member, tool: Tool) => {
      const open = toolOpen(m, tool);
      const id = `acc-${m.id}-${tool}`;
      // Every tool starts folded: its summary line says what it gives; open it to change pages.
      return html`<section class="acc-tool${open ? ' on' : ''}" data-tool="${tool}">
        <div class="acc-tool-h">
          <button type="button" class="acc-expand" aria-expanded="false" aria-controls="${id}" data-acc-expand>
            <span class="acc-tile">${icon(TOOL_ICONS[tool], 16)}</span>
            <span class="acc-tool-t"><span class="n">${TOOL_NAMES[tool]}</span><span class="s" data-tool-summary>${toolSummary(m, tool)}</span></span>
            ${icon('chevron-down', 16, 'chev')}
          </button>
          <span class="js-only">${switchInput({ name: '', checked: open, label: `${nameOf(m)}: ${tool === 'tickets' ? 'open every Discord tickets page' : `open ${TOOL_NAMES[tool]}`}`, attrs: html`data-tool-switch` })}</span>
        </div>
        <div class="acc-pages" id="${id}">${areasOf(tool).map((a) => html`<div class="acc-page">
          <div class="acc-page-t"><div class="l">${AREAS[a].name}${always(a)}</div><div class="d">${AREAS[a].desc}</div></div>
          ${levelSeg(m, a)}</div>`)}</div>
      </section>`;
    };
    // MCP: what this moderator's coding agents can do, a switch per tool (apart from the pages).
    const mcpSection = (m: Member) => {
      const on = mcpSwitches(m);
      const id = `acc-${m.id}-mcp`;
      return html`<section class="acc-tool acc-mcp${on.length ? ' on' : ''}" data-mcp-section>
        <div class="acc-tool-h">
          <button type="button" class="acc-expand" aria-expanded="false" aria-controls="${id}" data-acc-expand>
            <span class="acc-tile">${icon('plug', 16)}</span>
            <span class="acc-tool-t"><span class="n">MCP · coding agents</span><span class="s" data-mcp-summary>${mcpSummary(m)}</span></span>
            ${icon('chevron-down', 16, 'chev')}
          </button>
          <span class="js-only">${switchInput({ name: '', checked: on.length > 0, label: `${nameOf(m)}: MCP tools that only read`, attrs: html`data-mcp-switch` })}</span>
        </div>
        <div class="acc-pages" id="${id}">
          <input type="hidden" name="mcp_sent" value="1" form="${formId(m)}">
          <p class="acc-mcp-note">Separate from the pages above: seeing Ticket management doesn’t let their agent find tickets. Their agent acts as them, and what it changes is in the Mod log.</p>
          ${MCP_GROUPS.map((g) => html`<div class="acc-mcp-g"><span class="n">${g.name}</span><span class="d">${g.desc}</span></div>
            ${MCP_SWITCH_KEYS.filter((k) => MCP_SWITCHES[k].group === g.key).map((k) => html`<div class="acc-page">
              <div class="acc-page-t"><div class="l">${MCP_SWITCHES[k].name}</div><div class="d">${MCP_SWITCHES[k].desc}</div></div>
              ${switchInput({ name: 'mcp', value: k, checked: on.includes(k), label: `${nameOf(m)}: ${MCP_SWITCHES[k].name}`, attrs: html`form="${formId(m)}" data-mcp="${k}" data-mcp-group="${g.key}"` })}</div>`)}`)}
        </div>
      </section>`;
    };
    // Moderators in order, for "‹ 7 of 50 ›".
    const position = (m: Member) => mods.findIndex((x) => x.id === m.id);
    const pickHref = (m: Member) => `${b}/members?mod=${m.id}#moderator-access`;
    const stepper = (m: Member) => {
      const i = position(m);
      const prev = mods[(i - 1 + mods.length) % mods.length]!;
      const next = mods[(i + 1) % mods.length]!;
      const arrow = (to: Member, dir: 'prev' | 'next') => html`<a class="acc-step-btn" href="${pickHref(to)}" data-mod-step="${to.id}" aria-label="${dir === 'prev' ? 'Previous' : 'Next'} moderator: ${nameOf(to)}" title="${dir === 'prev' ? 'Previous' : 'Next'}: ${nameOf(to)}">${icon(dir === 'prev' ? 'chevron-left' : 'chevron-right', 14)}</a>`;
      return html`<div class="acc-step">${arrow(prev, 'prev')}<span>${String(i + 1)} of ${String(mods.length)}</span>${arrow(next, 'next')}</div>`;
    };
    const editor = (m: Member) => html`<section class="acc-editor" id="mod-${m.id}" data-mod="${m.id}" aria-labelledby="acc-name-${m.id}" ${m.id === selected?.id ? '' : raw('hidden')}>
      <div class="acc-who">
        ${mods.length > 1
          ? html`<button type="button" class="acc-name" data-acc-open aria-haspopup="dialog" aria-expanded="false" aria-controls="acc-picker" title="Choose another moderator (⌘K)">
              ${avatar(nameOf(m), 32, { src: discordAvatar(m) })}<span class="acc-name-t"><span class="nm" id="acc-name-${m.id}">${nameOf(m)}</span><span class="hd">@${m.username}</span></span>${icon('chevron-down', 16, 'chev')}</button>`
          : html`<div class="acc-name static">${avatar(nameOf(m), 32, { src: discordAvatar(m) })}<span class="acc-name-t"><span class="nm" id="acc-name-${m.id}">${nameOf(m)}</span><span class="hd">@${m.username}</span></span></div>`}
        <span class="acc-who-sum" data-acc-summary>${accessCount(m)}</span>
        <div class="acc-quick">
          ${mods.length > 1 ? stepper(m) : ''}
          <div class="seg js-only" role="group" aria-label="Quick set for ${nameOf(m)}">
            <button type="button" class="seg-item" data-preset="none" title="Only the tickets inbox, view only">Inbox only</button>
            <button type="button" class="seg-item" data-preset="view" title="View on every page">View all</button>
            <button type="button" class="seg-item" data-preset="edit" title="Edit on every page">Edit all</button>
          </div>
          ${mods.length > 1 ? html`<span class="js-only">${selectWrap(html`<select data-copy-from aria-label="Copy another moderator’s access to ${nameOf(m)}"><option value="">Copy from…</option>${mods.filter((x) => x.id !== m.id).map((x) => html`<option value="${x.id}">${nameOf(x)}</option>`)}</select>`, { sm: true })}</span>` : ''}
        </div>
      </div>
      ${TOOLS.map((tool) => toolSection(m, tool))}
      ${mcpSection(m)}
      <div class="nojs acc-save"><button type="submit" class="btn sm" form="${formId(m)}">Save ${nameOf(m)}’s access</button></div>
    </section>`;
    // Choosing a moderator: opened from the name (or ⌘K). Search, filter, keyboard; one list for everyone.
    const kinds = { all: mods.length, edit: 0, view: 0, inbox: 0 };
    for (const m of mods) kinds[accessKind(m)]++;
    const filterBtn = (k: keyof typeof kinds, label: string) => html`<button type="button" class="acc-filter" data-mod-filter="${k}" aria-pressed="${k === 'all' ? 'true' : 'false'}">${label} <span data-kind-count="${k}">${String(kinds[k])}</span></button>`;
    const picker = html`<div class="acc-picker" id="acc-picker" role="dialog" aria-label="Choose a moderator" hidden>
      <label class="acc-picker-search">${icon('search', 16)}<input type="search" placeholder="Find a moderator by name or @handle" aria-label="Find a moderator" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="acc-options" aria-autocomplete="list" data-mod-search><kbd>⌘K</kbd></label>
      <div class="acc-filters" role="group" aria-label="Show">${filterBtn('all', 'All')}${filterBtn('edit', 'Can edit')}${filterBtn('view', 'View only')}${filterBtn('inbox', 'Inbox only')}</div>
      <div class="acc-options-wrap">
        <div class="acc-options-h">All moderators</div>
        <div class="acc-options" id="acc-options" role="listbox" aria-label="Moderators">${mods.map((m) => html`<a class="acc-opt" id="acc-opt-${m.id}" role="option" href="${pickHref(m)}" data-mod-pick="${m.id}" data-kind="${accessKind(m)}" data-find="${`${nameOf(m)} ${m.username}`.toLowerCase()}" aria-selected="${m.id === selected?.id ? 'true' : 'false'}" tabindex="-1">
          ${avatar(nameOf(m), 28, { src: discordAvatar(m) })}<span class="acc-opt-t"><span class="nm">${nameOf(m)}</span><span class="hd">@${m.username}</span></span><span class="acc-opt-sum" data-opt-summary>${pickSummary(m)}</span>${icon('check', 14, 'tick')}</a>`)}</div>
        <p class="acc-none" data-mod-none hidden>No moderator matches.</p>
      </div>
      <div class="acc-keys" aria-hidden="true"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> choose</span><span><kbd>esc</kbd> close</span></div>
    </div>`;
    // Without JavaScript: a plain list of links to each moderator.
    const fallback = html`<nav class="nojs acc-fallback" aria-label="Moderators"><span class="small muted">Moderators:</span> ${mods.map((m) => html`<a href="${pickHref(m)}" ${m.id === selected?.id ? raw('aria-current="true"') : ''}>${nameOf(m)}</a>`)}</nav>`;

    const modAccess = html`<div class="card access-card readable" id="moderator-access" data-access-editor>
      <div class="card-h"><div><h2>Moderator access</h2><div class="desc">${mods.length > 1 ? 'Click a moderator’s name (or press ⌘K) to choose another, then open the tools they need. ' : ''}<strong>View</strong> shows a page with its controls turned off; <strong>Edit</strong> lets them change it. GitHub and Discord connections, workspace settings, deployment and members stay with admins.</div></div></div>
      ${mods.length
        ? html`${mods.map(accessForm)}
            ${mods.length > 1 ? html`${picker}${fallback}` : ''}
            ${mods.map(editor)}
            <div class="card-note">Changes save right away. Applying or dismissing AI suggestions, on Review, tickets or issues, needs Edit on Review. “Use these settings” on a re-run also needs Edit on Actions, Custom labels and Prompt. Updating the panel in Discord needs Edit on Discord tickets › Panel.</div>
`
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
    const q = req.query as { invite?: string; mod?: string };
    return renderMembers(ctx, reply, { invite: q.invite === '1', mod: q.mod });
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
      const body = (req.body ?? {}) as Record<string, unknown>;
      const next = await setModeratorAccess(deps.db, ctx.workspace.id, userId, body);
      // MCP tools: the form sends the switches that are on (mcp_sent tells "all off" from "not sent").
      const mcpBefore = before ? mcpSwitches(before) : [];
      const mcpAfter = body.mcp_sent === '1' ? await setMcpAccess(deps.db, ctx.workspace.id, userId, [body.mcp ?? []].flat()) : mcpBefore;
      const mcpChanged = MCP_SWITCH_KEYS.filter((k) => mcpBefore.includes(k) !== mcpAfter.includes(k));
      const mcpWhat = !mcpChanged.length ? '' : mcpChanged.length <= 3
        ? mcpChanged.map((k) => `MCP ${MCP_SWITCHES[k].name} → ${mcpAfter.includes(k) ? 'On' : 'Off'}`).join(', ')
        : `MCP → ${mcpAfter.length} of ${MCP_SWITCH_KEYS.length} tools`;
      const changed = AREA_KEYS.filter((a) => levelOf(before?.access, a) !== levelOf(next, a));
      // A few changes are listed. More come from a tool's select or All pages: "AI triage → Edit all".
      const after: MemberAccess = { role: 'moderator', access: next };
      const tools = [...new Set(changed.map((a) => AREAS[a].tool))];
      const all = uniformLevel(after, AREA_KEYS);
      const tool = tools.length === 1 ? uniformLevel(after, areasOf(tools[0]!)) : null;
      const what = !changed.length
        ? mcpWhat || 'access saved'
        : mcpWhat ? `${changed.length} ${changed.length === 1 ? 'page' : 'pages'} and ${mcpWhat}`
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
    return reply.redirect(`${ctx.base}/members?mod=${encodeURIComponent(userId)}#moderator-access`);
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
