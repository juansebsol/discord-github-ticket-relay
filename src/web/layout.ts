import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { html, raw, type SafeHtml } from '../lib/html.js';
import type { Membership } from '../domain/workspaces.js';
import { AREA_KEYS, can, canUseMcp, ROLE_LABELS, TOOL_NAMES, type MemberAccess } from '../domain/permissions.js';
import { areaHref, firstPage, TOOL_ICONS, type ToolName } from './routes/tool.js';
import type { Role, UserRow, WorkspaceRow } from '../domain/types.js';
import { avatar, csrfField, discordAvatar, icon, iconBtn, initials, menu, notice, type IconName } from './ui.js';
import { knowledgeLive } from './knowledge-live.js';

export type StepState = 'done' | 'todo' | 'problem';

export interface SetupProgress {
  github: StepState;
  discord: StepState;
  apps: StepState;
  panel: StepState;
  attention: number;
  /** Tickets and issues with triage suggestions waiting for someone (the AI triage badge). */
  review?: number;
  /** Dev mode is on (the whole server): the sidebar shows it next to Server health. */
  devMode?: boolean;
  /** Claude is writing TRIAGE.md files (AI triage › Knowledge), or just finished: pages carry the Live studio. */
  knowledgeRun?: boolean;
}

export interface PageContext {
  user: UserRow;
  csrf: string;
  flash: { type: string; message: string } | null;
  workspace?: WorkspaceRow;
  role?: Role;
  memberships?: Membership[];
  progress?: SetupProgress;
  /** The viewer's role and permissions in this workspace (filters the navigation). */
  membership?: MemberAccess;
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

/** Content hash for cache busting, so a deploy never serves stale CSS or JS. */
function assetVersion(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(path.join(PUBLIC_DIR, file))).digest('hex').slice(0, 10);
  } catch {
    return '0';
  }
}
const CSS_VERSION = assetVersion('app.css');
const JS_VERSION = assetVersion('app.js');

function head(title: string): SafeHtml {
  return html`<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${title} · Ticket Relay</title>
  <link rel="icon" type="image/png" href="/static/logo.png">
  <link rel="stylesheet" href="/static/app.css?v=${CSS_VERSION}">
  <script src="/static/app.js?v=${JS_VERSION}" defer></script>`;
}

/** Icons that app.js clones for toasts and copy feedback. */
const ICON_TEMPLATES = html`<template id="icon-templates">
  <span data-i="ok">${icon('circle-check', 16, 'ok lead')}</span><span data-i="warn">${icon('triangle-alert', 16, 'warn lead')}</span>
  <span data-i="danger">${icon('circle-x', 16, 'danger lead')}</span><span data-i="info">${icon('info', 16, 'muted lead')}</span>
  <span data-i="check">${icon('check', 14, 'ok')}</span><span data-i="check-16">${icon('check', 16, 'ok')}</span><span data-i="x">${icon('x', 16)}</span>
  <span data-i="upload">${icon('upload', 16)}</span>
</template>`;

/** The generic confirmation dialog filled in by app.js from a form's data-confirm-* attributes. */
const CONFIRM_DIALOG = html`<dialog class="dialog" id="confirm-dialog" aria-labelledby="confirm-title">
  <div class="dlg-h"><h2 id="confirm-title"></h2>${iconBtn('x', 'Close', { size: 'sm', attrs: raw('data-dialog-close') })}</div>
  <div class="dlg-b"><p id="confirm-body"></p></div>
  <div class="dlg-f"><button type="button" class="btn" data-dialog-close>Cancel</button><button type="button" class="btn primary" id="confirm-ok"></button></div>
</dialog>`;

function navItem(href: string, label: string, name: IconName, active: boolean, trail: SafeHtml | string = ''): SafeHtml {
  return html`<a href="${href}" class="nav-item" ${active ? raw('aria-current="page"') : ''}>${icon(name)}<span>${label}</span>${trail ? html`<span class="trail">${trail}</span>` : ''}</a>`;
}

/** A page this person can't open: greyed out with a lock. `grantable` pages can be opened to moderators by an admin. */
function lockedNavItem(label: string, name: IconName, o: { grantable?: boolean } = {}): SafeHtml {
  const why = o.grantable ? `You don’t have access to ${label}. Ask an admin if you need it.` : `Only admins can open ${label}. Ask an admin if you need access.`;
  return html`<span class="nav-item locked" aria-disabled="true" title="${why}">${icon(name)}<span>${label}</span><span class="trail">${icon('lock', 14)}<span class="sr-only"> (${o.grantable ? 'no access' : 'admins only'})</span></span></span>`;
}

function stepMark(state: StepState): SafeHtml {
  if (state === 'done') return html`${icon('circle-check', 14, 'ok')}<span class="sr-only"> (done)</span>`;
  if (state === 'problem') return html`${icon('triangle-alert', 14, 'warn')}<span class="sr-only"> (needs attention)</span>`;
  return html`${icon('circle-dashed', 14, 'faint')}<span class="sr-only"> (not done)</span>`;
}

export function roleLabel(access: MemberAccess): string {
  // View only: a moderator who can't change anything anywhere.
  if (access.role === 'moderator' && !AREA_KEYS.some((a) => can(access, `${a}.edit`))) return 'Moderator · View only';
  return ROLE_LABELS[access.role];
}

function toastsFor(flash: PageContext['flash']): SafeHtml {
  const kind = flash?.type === 'success' ? 'ok' : flash?.type === 'warn' ? 'warn' : 'info';
  return html`<div class="toasts" id="toasts" role="status" aria-live="polite">${flash && flash.type !== 'error'
    ? html`<div class="toast" data-auto>${icon(kind === 'ok' ? 'circle-check' : kind === 'warn' ? 'triangle-alert' : 'info', 16, `${kind === 'info' ? 'muted' : kind} lead`)}<span>${flash.message}</span>${iconBtn('x', 'Dismiss', { size: 'xs', attrs: raw('data-toast-close') })}</div>`
    : ''}</div>`;
}

/** "full": the page uses the whole window (tables and lists). "readable" (the default): content keeps a comfortable width. */
export type PageWidth = 'full' | 'readable';

export function layout(ctx: PageContext, opts: { title: string; active: string; body: SafeHtml; width?: PageWidth }): string {
  const ws = ctx.workspace;
  const base = ws ? `/w/${ws.id}` : '';
  const p = ctx.progress;
  const access = ctx.membership;
  const a = opts.active;
  const attention = p?.attention ? badge(p.attention) : '';
  const manage = access ? can(access, 'manage') : false;
  /** A tool opens on the first of its pages this person can see (Bot features: its list); with none, it's locked. */
  const tool = (m: MemberAccess, name: ToolName, trail: SafeHtml | string = '') => {
    const first = firstPage(m, name);
    return first ? navItem(name === 'bot' ? `${base}/bot` : areaHref(base, first), TOOL_NAMES[name], TOOL_ICONS[name], a === name, trail) : lockedNavItem(TOOL_NAMES[name], TOOL_ICONS[name], { grantable: true });
  };
  const review = access && p?.review && can(access, 'triage.review.view') ? badge(p.review, 'accent', `${String(p.review)} to review`) : '';

  const nav = ws && access
    ? html`<nav class="nav" aria-label="Main">
        ${navItem(base, 'Overview', 'layout-dashboard', a === 'overview')}
        <div class="nav-label">Setup</div>
        ${manage ? navItem(`${base}/setup/github`, 'GitHub', 'github', a === 'github', stepMark(p?.github ?? 'todo')) : lockedNavItem('GitHub', 'github')}
        ${manage ? navItem(`${base}/setup/discord`, 'Discord', 'message-circle', a === 'discord', stepMark(p?.discord ?? 'todo')) : lockedNavItem('Discord', 'message-circle')}
        ${can(access, 'apps.view') ? navItem(`${base}/apps`, 'Apps & repositories', 'boxes', a === 'apps', stepMark(p?.apps ?? 'todo')) : lockedNavItem('Apps & repositories', 'boxes', { grantable: true })}
        <div class="nav-label">Tools</div>
        ${tool(access, 'analytics')}
        ${tool(access, 'repos')}
        ${tool(access, 'tickets', attention)}
        ${tool(access, 'issues')}
        ${tool(access, 'triage', review)}
        ${tool(access, 'moderation')}
        ${tool(access, 'contributors')}
        ${tool(access, 'announcements')}
        ${tool(access, 'bot')}
        ${canUseMcp(access) ? navItem(`${base}/mcp`, 'MCP', 'plug', a === 'mcp') : lockedNavItem('MCP', 'plug', { grantable: true })}
        <div class="nav-label">Workspace</div>
        ${manage ? navItem(`${base}/members`, 'Members & permissions', 'users', a === 'members') : lockedNavItem('Members & permissions', 'users')}
        ${manage ? navItem(`${base}/settings`, 'Settings', 'settings', a === 'settings') : lockedNavItem('Settings', 'settings')}
        ${manage ? navItem(`${base}/deployment`, 'Deployment', 'server', a === 'deployment') : lockedNavItem('Deployment', 'server')}
        ${can(access, 'health.view') ? navItem(`${base}/health`, 'Server health', 'activity', a === 'health', html`<span class="nav-tag" data-dev-tag title="Dev mode is on: restarts aren’t counted" ${p?.devMode ? '' : raw('hidden')}>Dev mode</span>`) : lockedNavItem('Server health', 'activity', { grantable: true })}
      </nav>`
    : html``;

  const wsButton = ws
    ? menu(
        [
          ...(ctx.memberships ?? []).map((m) => ({ href: `/w/${m.workspace.id}`, label: m.workspace.name, current: m.workspace.id === ws.id })),
          'sep',
          { href: '/workspaces', label: 'All workspaces' },
        ],
        {
          trigger: (id) => html`<button type="button" class="ws" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}" data-menu="${id}" title="Switch workspace"><span class="ws-tile" aria-hidden="true">${initials(ws.name, 2)}</span><span class="ws-name">${ws.name}</span>${icon('chevrons-up-down', 14)}</button>`,
        },
      )
    : html``;

  const name = ctx.user.display_name ?? ctx.user.username;
  const page = html`<!doctype html>
<html lang="en">
<head>
  ${head(opts.title)}
</head>
<body>
<div class="topbar">
  <button type="button" class="icon-btn" id="menu-btn" aria-label="Open menu" aria-controls="sidebar" aria-expanded="false">${icon('menu')}${p?.attention ? raw('<span class="dot" aria-hidden="true"></span>') : ''}</button>
  <div class="brand"><img src="/static/logo.png" alt="" width="24" height="24"><span>Ticket Relay</span></div>
</div>
<div class="shell">
  <aside class="sidebar" id="sidebar" aria-label="Sidebar">
    <div class="brand"><img src="/static/logo.png" alt="" width="24" height="24"><span>Ticket Relay</span>${iconBtn('x', 'Close menu', { size: 'sm', cls: 'drawer-only', attrs: raw('id="drawer-close"') })}</div>
    ${wsButton}
    ${nav}
    <div class="side-foot">
      ${avatar(name, 28, { src: discordAvatar(ctx.user) })}
      <div class="who"><div class="who-name">${name}</div>${access ? html`<div class="who-role">${roleLabel(access)}</div>` : ''}</div>
      <form method="post" action="/logout" class="inline-form">${csrfField(ctx.csrf)}${iconBtn('log-out', 'Sign out', { size: 'sm', submit: true })}</form>
    </div>
  </aside>
  <main class="main" id="main">
    <div class="page${opts.width === 'full' ? ' full' : ''}">
      ${ctx.flash?.type === 'error' ? notice('danger', null, ctx.flash.message) : ''}
      ${opts.body}
    </div>
  </main>
</div>
${ws && access ? html`<div id="alert-dock" data-dock-src="${base}/alerts" data-dock-ws="${ws.id}" hidden></div>` : ''}
${ws && access && p?.knowledgeRun && can(access, 'triage.knowledge.view') ? knowledgeLive({ base, csrf: ctx.csrf, wid: ws.id, edit: can(access, 'triage.knowledge.edit') }) : ''}
${toastsFor(ctx.flash)}
${CONFIRM_DIALOG}
${ICON_TEMPLATES}
</body>
</html>`;
  return page.value;
}

function badge(n: number, tone: 'warn' | 'accent' = 'warn', title = `${String(n)} need attention`): SafeHtml {
  return html`<span class="badge ${tone}" title="${title}">${String(n)}</span>`;
}

/** Standalone pages (sign-in, invitations, errors) without the app shell. */
export function simplePage(title: string, body: SafeHtml, opts: { flash?: PageContext['flash'] } = {}): string {
  return html`<!doctype html>
<html lang="en">
<head>
  ${head(title)}
</head>
<body>
  <main class="center-page"><div class="auth">
    <div class="brand"><img src="/static/logo.png" alt="" width="24" height="24"><span>Ticket Relay</span></div>
    <div class="card"><div class="card-b">${body}</div></div>
    ${LEGAL_LINKS}
  </div></main>
  ${toastsFor(opts.flash ?? null)}
  ${CONFIRM_DIALOG}
  ${ICON_TEMPLATES}
</body>
</html>`.value;
}

const LEGAL_LINKS = html`<nav class="legal-links" aria-label="Legal"><a href="/terms">Terms of Service</a><span aria-hidden="true">·</span><a href="/privacy">Privacy Policy</a></nav>`;

/** Public legal documents (Terms of Service, Privacy Policy): readable without signing in. */
export function legalPage(o: { title: string; updated: string; intro: SafeHtml; body: SafeHtml }): string {
  return html`<!doctype html>
<html lang="en">
<head>
  ${head(o.title)}
</head>
<body>
  <main class="legal">
    <a class="brand" href="/"><img src="/static/logo.png" alt="" width="24" height="24"><span>Ticket Relay</span></a>
    <article class="prose">
      <header><h1>${o.title}</h1><p class="meta">Last updated ${o.updated}</p>${o.intro}</header>
      ${o.body}
    </article>
    ${LEGAL_LINKS}
  </main>
</body>
</html>`.value;
}
