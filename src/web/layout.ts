import { html, raw, type SafeHtml } from '../lib/html.js';
import type { Membership } from '../domain/workspaces.js';
import type { Role, SubmissionStatus, UserRow, WorkspaceRow } from '../domain/types.js';

export interface SetupProgress {
  github: 'done' | 'todo' | 'problem';
  discord: 'done' | 'todo' | 'problem';
  apps: 'done' | 'todo' | 'problem';
  panel: 'done' | 'todo' | 'problem';
  attention: number;
}

export interface PageContext {
  user: UserRow;
  csrf: string;
  flash: { type: string; message: string } | null;
  workspace?: WorkspaceRow;
  role?: Role;
  memberships?: Membership[];
  progress?: SetupProgress;
}

export function csrfField(csrf: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${csrf}">`;
}

export function button(label: string, opts: { variant?: string; loading?: string; name?: string; value?: string; disabled?: boolean } = {}): SafeHtml {
  return html`<button type="submit" class="btn ${opts.variant ?? ''}" ${opts.name ? raw(`name="${opts.name}"`) : ''} ${opts.value !== undefined ? html`value="${opts.value}"` : ''} ${opts.disabled ? raw('disabled') : ''} ${opts.loading ? html`data-loading-text="${opts.loading}"` : ''}><span class="spinner" aria-hidden="true"></span> ${label}</button>`;
}

/** A one-button POST form (all state-changing actions are POSTs protected by CSRF tokens). */
export function postButton(
  action: string,
  label: string,
  csrf: string,
  opts: { variant?: string; confirm?: string; loading?: string; fields?: Record<string, string>; disabled?: boolean } = {},
): SafeHtml {
  return html`<form method="post" action="${action}" class="inline-form" ${opts.confirm ? html`data-confirm="${opts.confirm}"` : ''}>
    ${csrfField(csrf)}
    ${Object.entries(opts.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    ${button(label, { variant: opts.variant, loading: opts.loading, disabled: opts.disabled })}
  </form>`;
}

export function badge(text: string, tone: 'ok' | 'warn' | 'danger' | 'info' | 'plain' | '' = ''): SafeHtml {
  return html`<span class="badge ${tone}">${text}</span>`;
}

export const STATUS_LABELS: Record<SubmissionStatus, [string, 'ok' | 'warn' | 'danger' | 'info' | '']> = {
  pending: ['Queued', 'info'],
  processing: ['Filing…', 'info'],
  created: ['Created', 'ok'],
  failed: ['Failed', 'danger'],
  uncertain: ['Needs check', 'warn'],
  dismissed: ['Closed', ''],
};

export function statusBadge(status: SubmissionStatus): SafeHtml {
  const [text, tone] = STATUS_LABELS[status];
  return badge(text, tone);
}

export function alert(type: 'success' | 'error' | 'info' | 'warn', content: SafeHtml | string): SafeHtml {
  return html`<div class="alert ${type}" role="${type === 'error' ? 'alert' : 'status'}">${content}</div>`;
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function timeAgo(d: Date, now = Date.now()): string {
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 60) return `in ${f}s`;
    if (f < 3600) return `in ${Math.round(f / 60)} min`;
    return `in ${Math.round(f / 3600)} h`;
  }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function discordAvatar(user: Pick<UserRow, 'discord_user_id' | 'avatar'>): string | null {
  return user.avatar ? `https://cdn.discordapp.com/avatars/${user.discord_user_id}/${user.avatar}.png?size=64` : null;
}

function stepDot(state: 'done' | 'todo' | 'problem', n: number): SafeHtml {
  return html`<span class="step-dot ${state === 'done' ? 'done' : state === 'problem' ? 'problem' : ''}" aria-hidden="true">${state === 'done' ? '✓' : state === 'problem' ? '!' : String(n)}</span>`;
}

function navLink(href: string, label: string, active: boolean, lead: SafeHtml | string = '', trail: SafeHtml | string = ''): SafeHtml {
  return html`<a href="${href}" class="${active ? 'active' : ''}" ${active ? raw('aria-current="page"') : ''}>${lead}${label}${trail}</a>`;
}

const ICONS = {
  overview: '◎',
  submissions: '☰',
  settings: '⚙',
  guide: '?',
};

function icon(name: keyof typeof ICONS): SafeHtml {
  return html`<span class="step-dot" aria-hidden="true">${ICONS[name]}</span>`;
}

export function layout(ctx: PageContext, opts: { title: string; active: string; body: SafeHtml }): string {
  const ws = ctx.workspace;
  const base = ws ? `/w/${ws.id}` : '';
  const p = ctx.progress;
  const sidebar = ws
    ? html`
      <nav class="nav" aria-label="Main">
        ${navLink(base, 'Overview', opts.active === 'overview', icon('overview'))}
        <div class="nav-label">Setup</div>
        ${navLink(`${base}/setup/github`, 'Connect GitHub', opts.active === 'github', stepDot(p?.github ?? 'todo', 1))}
        ${navLink(`${base}/setup/discord`, 'Connect Discord', opts.active === 'discord', stepDot(p?.discord ?? 'todo', 2))}
        ${navLink(`${base}/apps`, 'Apps', opts.active === 'apps', stepDot(p?.apps ?? 'todo', 3))}
        ${navLink(`${base}/panel`, 'Validate & publish', opts.active === 'panel', stepDot(p?.panel ?? 'todo', 4))}
        <div class="nav-label">Manage</div>
        ${navLink(`${base}/submissions`, 'Submissions', opts.active === 'submissions', icon('submissions'), p?.attention ? html`<span class="count" title="${p.attention} need attention">${String(p.attention)}</span>` : '')}
        ${navLink(`${base}/settings`, 'Settings & admins', opts.active === 'settings', icon('settings'))}
        ${navLink(`${base}/provider-setup`, 'Deployment setup', opts.active === 'provider', icon('guide'))}
      </nav>`
    : html``;

  const switcher =
    ws && ctx.memberships && ctx.memberships.length > 1
      ? html`<div class="ws-switch"><label class="small muted" for="workspace-switch">Workspace</label>
          <select id="workspace-switch">${ctx.memberships.map((m) => html`<option value="/w/${m.workspace.id}" ${m.workspace.id === ws.id ? raw('selected') : ''}>${m.workspace.name}</option>`)}</select></div>`
      : ws
        ? html`<div class="ws-switch small muted">${ws.name}</div>`
        : html``;

  const avatar = discordAvatar(ctx.user);
  const page = html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${opts.title} · Ticket Relay</title>
  <link rel="stylesheet" href="/static/app.css">
  <script src="/static/app.js" defer></script>
</head>
<body>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><span class="brand-mark" aria-hidden="true">✉</span> Ticket Relay</div>
    ${switcher}
    ${sidebar}
    <div class="sidebar-footer">
      <div class="identity compact">
        ${avatar ? html`<img class="avatar sm" src="${avatar}" alt="">` : ''}
        <span>${ctx.user.display_name ?? ctx.user.username}</span>
      </div>
      <a href="/workspaces">All workspaces</a> ·
      <form method="post" action="/logout">${csrfField(ctx.csrf)}<button class="link-button">Sign out</button></form>
    </div>
  </aside>
  <main class="main" id="main">
    ${ctx.flash ? alert(ctx.flash.type === 'error' ? 'error' : ctx.flash.type === 'success' ? 'success' : 'info', ctx.flash.message) : ''}
    ${opts.body}
  </main>
</div>
</body>
</html>`;
  return page.value;
}

/** Standalone pages (sign-in, invitations, errors) without the app shell. */
export function simplePage(title: string, body: SafeHtml): string {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Ticket Relay</title>
  <link rel="stylesheet" href="/static/app.css">
  <script src="/static/app.js" defer></script>
</head>
<body>
  <div class="center-page"><div class="auth-card">
    <div class="brand"><span class="brand-mark" aria-hidden="true">✉</span> Ticket Relay</div>
    <div class="card">${body}</div>
  </div></div>
</body>
</html>`.value;
}

export function pageHead(title: string, description?: string, actions?: SafeHtml): SafeHtml {
  return html`<div class="page-head"><div><h1>${title}</h1>${description ? html`<p>${description}</p>` : ''}</div>${actions ? html`<div class="row">${actions}</div>` : ''}</div>`;
}
