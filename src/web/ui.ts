/**
 * Server-rendered UI components for the admin console. Markup and class names follow the
 * design system in public/app.css; behaviour (menus, dialogs, copy, toasts) is in app.js.
 */
import { html, raw, type SafeHtml } from '../lib/html.js';
import type { SubmissionStatus, UserRow } from '../domain/types.js';
import { ICON_PATHS, type IconName } from './icon-data.js';

export type { IconName };
type Content = SafeHtml | string;

// ---- Icons ------------------------------------------------------------------------------------

/** A monochrome Lucide icon. `cls` adds tone classes such as "ok", "warn", "danger" or "muted". */
export function icon(name: IconName, size: 12 | 14 | 16 | 20 = 16, cls = ''): SafeHtml {
  return raw(
    `<span class="ic ic-${size}${cls ? ` ${cls}` : ''}" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg></span>`,
  );
}

/** Picks an icon for a user-defined ticket type from its name or label. */
export function typeIcon(t: { name: string; label?: string | null }): IconName {
  const s = `${t.name} ${t.label ?? ''}`.toLowerCase();
  if (/bug|error|crash|broken|defect/.test(s)) return 'bug';
  if (/feature|idea|enhancement|improve|request|suggest/.test(s)) return 'lightbulb';
  if (/question|help|support|how/.test(s)) return 'message-circle-question';
  return 'tag';
}

// ---- Forms and buttons ------------------------------------------------------------------------

export function csrfField(csrf: string): SafeHtml {
  return html`<input type="hidden" name="_csrf" value="${csrf}">`;
}

export type Variant = 'primary' | 'secondary' | 'ghost' | 'ghost muted' | 'ghost danger' | 'danger-solid';

export interface BtnOpts {
  variant?: Variant;
  size?: 'sm' | 'lg';
  icon?: IconName;
  trail?: IconName;
  disabled?: boolean;
  title?: string;
  /** Extra attributes; trusted markup only. */
  attrs?: SafeHtml;
  block?: boolean;
}

function btnClass(o: BtnOpts): string {
  return ['btn', o.variant && o.variant !== 'secondary' ? o.variant : '', o.size ?? '', o.block ? 'block' : ''].filter(Boolean).join(' ');
}

function btnInner(label: Content, o: BtnOpts, loading = false): SafeHtml {
  const small = o.size === 'sm';
  return html`${loading ? html`<span class="spin">${icon('loader-circle', small ? 14 : 16)}</span>` : ''}${o.icon ? html`<span class="lead">${icon(o.icon, small ? 14 : 16)}</span>` : ''}<span class="lbl">${label}</span>${o.trail ? html`<span class="trail">${icon(o.trail, 14)}</span>` : ''}`;
}

/** A link styled as a button. External links open in a new tab. */
export function linkBtn(href: string, label: Content, o: BtnOpts & { external?: boolean } = {}): SafeHtml {
  return html`<a class="${btnClass(o)}" href="${href}" ${o.external ? raw('target="_blank" rel="noopener noreferrer"') : ''} ${o.title ? html`title="${o.title}"` : ''} ${o.disabled ? raw('aria-disabled="true" tabindex="-1"') : ''} ${o.attrs ?? ''}>${btnInner(label, o)}</a>`;
}

/** A submit button. `loading` swaps the label while the form is being sent. */
export function submitBtn(label: Content, o: BtnOpts & { loading?: string; name?: string; value?: string; form?: string } = {}): SafeHtml {
  return html`<button type="submit" class="${btnClass(o)}" ${o.name ? html`name="${o.name}"` : ''} ${o.value !== undefined ? html`value="${o.value}"` : ''} ${o.form ? html`form="${o.form}"` : ''} ${o.disabled ? raw('disabled') : ''} ${o.loading ? html`data-loading-text="${o.loading}"` : ''} ${o.title ? html`title="${o.title}"` : ''} ${o.attrs ?? ''}>${btnInner(label, o, true)}</button>`;
}

/** A plain button for client-side behaviour (dialogs, menus, copy). */
export function btn(label: Content, o: BtnOpts = {}): SafeHtml {
  return html`<button type="button" class="${btnClass(o)}" ${o.disabled ? raw('disabled') : ''} ${o.title ? html`title="${o.title}"` : ''} ${o.attrs ?? ''}>${btnInner(label, o)}</button>`;
}

export function iconBtn(name: IconName, label: string, o: { size?: 'sm' | 'xs'; href?: string; external?: boolean; attrs?: SafeHtml; secondary?: boolean; submit?: boolean; disabled?: boolean; cls?: string } = {}): SafeHtml {
  const cls = ['icon-btn', o.size ?? '', o.secondary ? 'secondary' : '', o.cls ?? ''].filter(Boolean).join(' ');
  if (o.href) {
    return html`<a class="${cls}" href="${o.href}" aria-label="${label}" title="${label}" ${o.external ? raw('target="_blank" rel="noopener noreferrer"') : ''} ${o.attrs ?? ''}>${icon(name, o.size === 'xs' ? 14 : 16)}</a>`;
  }
  return html`<button type="${o.submit ? 'submit' : 'button'}" class="${cls}" aria-label="${label}" title="${label}" ${o.disabled ? raw('disabled') : ''} ${o.attrs ?? ''}>${icon(name, o.size === 'xs' ? 14 : 16)}</button>`;
}

/** Confirmation shown in an in-page dialog before a form is sent (needs app.js; without it the form submits directly). */
export interface Confirm {
  title: string;
  body: string;
  label: string;
  danger?: boolean;
}

function confirmAttrs(c?: Confirm): SafeHtml {
  return c ? html`data-confirm-title="${c.title}" data-confirm-body="${c.body}" data-confirm-label="${c.label}" ${c.danger ? raw('data-confirm-danger') : ''}` : html``;
}

/** A one-button POST form (all state-changing actions are POSTs protected by CSRF tokens). */
export function postBtn(action: string, label: Content, csrf: string, o: BtnOpts & { confirm?: Confirm; loading?: string; fields?: Record<string, string> } = {}): SafeHtml {
  return html`<form method="post" action="${action}" class="inline-form" ${confirmAttrs(o.confirm)}>${csrfField(csrf)}${hiddenFields(o.fields)}${submitBtn(label, o)}</form>`;
}

function hiddenFields(fields?: Record<string, string>): SafeHtml {
  return html`${Object.entries(fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}`;
}

// ---- Menus ------------------------------------------------------------------------------------

export type MenuItem =
  | { href: string; label: string; icon?: IconName; danger?: boolean; external?: boolean; current?: boolean }
  | { post: string; label: string; icon?: IconName; danger?: boolean; confirm?: Confirm; fields?: Record<string, string> }
  | { dialog: string; label: string; icon?: IconName; danger?: boolean }
  | { copy: string; label: string; icon?: IconName; danger?: boolean }
  | 'sep';

let menuCounter = 0;

/**
 * An overflow menu: a trigger plus a popover panel that app.js positions in a fixed layer,
 * so it is never clipped by its card. Items are links, POST forms, dialog openers or copy actions.
 */
export function menu(items: (MenuItem | false | null | undefined)[], o: { csrf?: string; label?: string; button?: { label: Content; opts?: BtnOpts }; trigger?: (id: string) => SafeHtml; size?: 'sm' | 'md' } = {}): SafeHtml {
  const list = items.filter(Boolean) as MenuItem[];
  // Drop leading, trailing and doubled separators left by conditional items.
  const clean = list.filter((it, i) => it !== 'sep' || (i > 0 && i < list.length - 1 && list[i - 1] !== 'sep'));
  if (!clean.length) return html``;
  const id = `menu-${++menuCounter}`;
  const label = o.label ?? 'More actions';
  const trigger = o.trigger
    ? o.trigger(id)
    : o.button
    ? btn(o.button.label, { ...o.button.opts, trail: o.button.opts?.trail ?? 'chevron-down', attrs: html`aria-haspopup="menu" aria-expanded="false" aria-controls="${id}" data-menu="${id}"` })
    : html`<button type="button" class="icon-btn${o.size === 'md' ? '' : ' sm'}" aria-label="${label}" title="${label}" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}" data-menu="${id}">${icon('ellipsis')}</button>`;
  return html`<div class="menu-wrap">${trigger}<div class="menu" id="${id}" role="menu">${clean.map((it) => menuItem(it, o.csrf))}</div></div>`;
}

function menuItem(it: MenuItem, csrf?: string): SafeHtml {
  if (it === 'sep') return html`<div class="menu-sep" role="separator"></div>`;
  const cls = `menu-item${it.danger ? ' danger' : ''}${'current' in it && it.current ? ' current' : ''}`;
  const lead = it.icon ? icon(it.icon) : '';
  if ('href' in it) {
    return html`<a class="${cls}" role="menuitem" href="${it.href}" ${it.external ? raw('target="_blank" rel="noopener noreferrer"') : ''}>${lead}<span>${it.label}</span>${it.current ? html`<span class="trail">${icon('check', 14)}</span>` : ''}</a>`;
  }
  if ('post' in it) {
    return html`<form method="post" action="${it.post}" ${confirmAttrs(it.confirm)}>${csrfField(csrf ?? '')}${hiddenFields(it.fields)}<button type="submit" class="${cls}" role="menuitem">${lead}<span>${it.label}</span></button></form>`;
  }
  if ('dialog' in it) {
    return html`<button type="button" class="${cls}" role="menuitem" data-dialog="${it.dialog}">${lead}<span>${it.label}</span></button>`;
  }
  return html`<button type="button" class="${cls}" role="menuitem" data-copy-value="${it.copy}">${lead}<span>${it.label}</span></button>`;
}

// ---- Dialogs ----------------------------------------------------------------------------------

/** A modal dialog containing a POST form. Open it with any element carrying `data-dialog="<id>"`. */
export function dialog(id: string, o: { title: string; body: SafeHtml; action: string; csrf: string; submit: SafeHtml; fields?: Record<string, string> }): SafeHtml {
  return html`<dialog class="dialog" id="${id}" aria-labelledby="${id}-title">
    <form method="post" action="${o.action}">${csrfField(o.csrf)}${hiddenFields(o.fields)}
      <div class="dlg-h"><h2 id="${id}-title">${o.title}</h2>${iconBtn('x', 'Close', { size: 'sm', attrs: raw('data-dialog-close') })}</div>
      <div class="dlg-b">${o.body}</div>
      <div class="dlg-f">${btn('Cancel', { attrs: raw('data-dialog-close') })}${o.submit}</div>
    </form></dialog>`;
}

/** Radio cards for dialogs (Change role, Close ticket). */
export function choices(name: string, options: { value: string; title: string; desc?: string }[], checked: string, o: { attrs?: SafeHtml } = {}): SafeHtml {
  return html`<div class="choices" role="radiogroup">${options.map((c) => html`<label class="choice"><input type="radio" name="${name}" value="${c.value}" ${c.value === checked ? raw('checked') : ''} ${o.attrs ?? ''}><span><span class="t">${c.title}</span>${c.desc ? html`<span class="d">${c.desc}</span>` : ''}</span></label>`)}</div>`;
}

// ---- Page structure ---------------------------------------------------------------------------

export function pageHeader(o: {
  title: Content;
  eyebrow?: string;
  crumbs?: { href?: string; label: Content }[];
  after?: SafeHtml | string | (SafeHtml | string | false | null | undefined)[];
  description?: Content;
  actions?: SafeHtml | (SafeHtml | false | null | undefined)[];
}): SafeHtml {
  const actions = Array.isArray(o.actions) ? o.actions.filter(Boolean) as SafeHtml[] : o.actions ? [o.actions] : [];
  return html`<header class="ph">
    ${o.eyebrow ? html`<div class="ph-eyebrow">${o.eyebrow}</div>` : ''}
    ${o.crumbs?.length ? html`<nav class="crumbs" aria-label="Breadcrumb">${o.crumbs.map((c, i) => html`${i ? icon('chevron-right', 14) : ''}${c.href ? html`<a href="${c.href}">${c.label}</a>` : html`<span class="current" aria-current="page">${c.label}</span>`}`)}</nav>` : ''}
    <div class="ph-title"><h1>${o.title}</h1>${o.after ?? ''}</div>
    ${actions.length ? html`<div class="ph-actions">${actions}</div>` : ''}
    ${o.description ? html`<p class="ph-desc">${o.description}</p>` : ''}
  </header>`;
}

/**
 * Link tabs under a page header; hidden when only one tab would show. A `locked` tab is shown
 * greyed out with a lock, not as a link; its text says why. `tone` colors the count.
 */
export function tabs(label: string, items: { href: string; label: string; current: boolean; count?: number; tone?: BadgeTone; locked?: string }[]): SafeHtml {
  if (items.length < 2) return html``;
  return html`<nav class="tabs" aria-label="${label}">${items.map((t) => (t.locked
    ? html`<span class="tab locked" aria-disabled="true" title="${t.locked}">${icon('lock', 12)}${t.label}<span class="sr-only"> (no access)</span></span>`
    : html`<a class="tab" href="${t.href}" ${t.current ? raw('aria-current="page"') : ''}>${t.label}${t.count ? badge(t.count, t.tone) : ''}</a>`))}</nav>`;
}

/** A settings row: label and description on the left, a control on the right. */
export function setting(label: Content, desc: Content | null, control: SafeHtml | string, o: { for?: string; switchRow?: boolean; top?: boolean; flat?: boolean; stacked?: boolean } = {}): SafeHtml {
  const cls = ['setting', o.switchRow ? 'switch-row' : '', o.top ? 'top' : '', o.flat ? 'flat' : '', o.stacked ? 'stacked' : ''].filter(Boolean).join(' ');
  return html`<div class="${cls}"><div>${o.for ? html`<label class="lbl" for="${o.for}">${label}</label>` : html`<div class="lbl">${label}</div>`}${desc ? html`<div class="desc">${desc}</div>` : ''}</div><div class="control">${control}</div></div>`;
}

export function notice(tone: 'warn' | 'danger' | 'info' | 'ok', title: Content | null, text?: Content | null, o: { icon?: IconName; action?: SafeHtml | null; id?: string } = {}): SafeHtml {
  const name: IconName = o.icon ?? (tone === 'warn' ? 'triangle-alert' : tone === 'danger' ? 'circle-x' : tone === 'ok' ? 'circle-check' : 'info');
  return html`<div class="notice ${tone}" role="${tone === 'danger' ? 'alert' : 'status'}" ${o.id ? html`id="${o.id}"` : ''}>${icon(name)}<div>${title ? html`<div class="n-title">${title}</div>` : ''}${text ? html`<div class="n-text">${text}</div>` : ''}</div>${o.action ? html`<div class="n-action">${o.action}</div>` : html`<span></span>`}</div>`;
}

export function empty(name: IconName, title: string, text: Content, actions?: SafeHtml | null, tone = 'muted'): SafeHtml {
  return html`<div class="empty"><span class="circle">${icon(name, 20, tone)}</span><h3>${title}</h3><p>${text}</p>${actions ? html`<div class="actions">${actions}</div>` : ''}</div>`;
}

// ---- Atoms ------------------------------------------------------------------------------------

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral' | 'closed';

export function pill(text: string, tone: Tone): SafeHtml {
  return html`<span class="pill ${tone}">${text}</span>`;
}

export function tag(text: Content, o: { icon?: IconName; cls?: string; title?: string } = {}): SafeHtml {
  return html`<span class="tag${o.cls ? ` ${o.cls}` : ''}" ${o.title ? html`title="${o.title}"` : ''}>${o.icon ? icon(o.icon, 14) : ''}${text}</span>`;
}

export function viewOnlyTag(why: string): SafeHtml {
  return tag('View only', { icon: 'eye', title: why });
}

/** Warn: something needs attention. Accent: something waits for someone (suggestions to review). */
export type BadgeTone = '' | 'warn' | 'accent';

export function badge(n: number | string, tone: BadgeTone = ''): SafeHtml {
  return html`<span class="badge${tone ? ` ${tone}` : ''}">${String(n)}</span>`;
}

/** A small status chip for page headers: a colored dot and a short line ("3 repositories · synced 2 min ago"). */
export function chip(text: Content, o: { tone?: 'ok' | 'warn' | null; title?: string; href?: string } = {}): SafeHtml {
  const inner = html`<span class="dot${o.tone ? ` ${o.tone}` : ''}" aria-hidden="true"></span><span class="t">${text}</span>`;
  return o.href
    ? html`<a class="chip" href="${o.href}" ${o.title ? html`title="${o.title}"` : ''}>${inner}</a>`
    : html`<span class="chip" ${o.title ? html`title="${o.title}"` : ''}>${inner}</span>`;
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

const KNOWN_LABELS: Record<string, number> = { bug: 0, enhancement: 1, feature: 1, question: 2, documentation: 5, docs: 5, 'good first issue': 2, help: 3, 'help wanted': 3, test: 7, support: 4 };

/** A GitHub label: a colored dot and the label name in mono. */
export function labelTag(name: string): SafeHtml {
  const c = KNOWN_LABELS[name.toLowerCase()] ?? hash(name.toLowerCase()) % 8;
  return html`<span class="tag label"><span class="dot c${String(c)}"></span>${name}</span>`;
}

/** A Discord role chip; `index` picks a stable color from the role palette. */
export function roleTag(name: string, index: number): SafeHtml {
  return html`<span class="tag role"><span class="dot r${String(index % 6)}"></span>@${name}</span>`;
}

export function initials(name: string, n = 1): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (n === 1) return words[0]!.slice(0, 1).toUpperCase();
  return (words.length > 1 ? words[0]!.slice(0, 1) + words[1]!.slice(0, 1) : words[0]!.slice(0, 2)).toUpperCase();
}

export function avatar(name: string, size: 20 | 24 | 28 | 32, o: { src?: string | null; square?: boolean; letters?: number } = {}): SafeHtml {
  const cls = `av av-${size}${o.square ? ' sq' : ''}`;
  return o.src
    ? html`<img class="${cls}" src="${o.src}" alt="" width="${String(size)}" height="${String(size)}" loading="lazy">`
    : html`<span class="${cls}" aria-hidden="true">${initials(name, o.letters ?? 1)}</span>`;
}

export function discordAvatar(user: Pick<UserRow, 'discord_user_id' | 'avatar'>): string | null {
  return user.avatar ? `https://cdn.discordapp.com/avatars/${user.discord_user_id}/${user.avatar}.png?size=64` : null;
}

/** On/off switch backed by a real checkbox. */
export function switchInput(o: { name: string; checked: boolean; label: string; value?: string; disabled?: boolean; attrs?: SafeHtml; id?: string }): SafeHtml {
  return html`<span class="switch"><input type="checkbox" role="switch" name="${o.name}" value="${o.value ?? '1'}" aria-label="${o.label}" ${o.id ? html`id="${o.id}"` : ''} ${o.checked ? raw('checked') : ''} ${o.disabled ? raw('disabled') : ''} ${o.attrs ?? ''}><span class="track" aria-hidden="true"></span></span>`;
}

/** Locked value used instead of a disabled "always on" switch. */
export function locked(text: string): SafeHtml {
  return html`<span class="locked">${icon('lock', 14)}${text}</span>`;
}

/** Wraps a native select with the chevron icon. */
export function selectWrap(selectMarkup: SafeHtml, o: { sm?: boolean; cls?: string } = {}): SafeHtml {
  return html`<span class="select${o.sm ? ' sm' : ''}${o.cls ? ` ${o.cls}` : ''}">${selectMarkup}${icon('chevron-down', 14)}</span>`;
}

/** Segmented control made of links (filters). A `locked` item is shown greyed out with a lock, not as a link; its text says why. */
export function segLinks(label: string, items: { href: string; label: string; count?: number; current: boolean; locked?: string }[]): SafeHtml {
  return html`<nav class="seg" aria-label="${label}">${items.map((s) => (s.locked
    ? html`<span class="seg-item locked" aria-disabled="true" title="${s.locked}">${icon('lock', 12)}${s.label}</span>`
    : html`<a class="seg-item" href="${s.href}" ${s.current ? raw('aria-current="true"') : ''}>${s.label}${s.count !== undefined ? html`<span class="n">${String(s.count)}</span>` : ''}</a>`))}</nav>`;
}

/** Segmented control made of radio buttons (form values). */
export function segRadios(name: string, options: { value: string; label: string }[], checked: string, label: string): SafeHtml {
  return html`<div class="seg" role="radiogroup" aria-label="${label}">${options.map((o) => html`<label><input type="radio" name="${name}" value="${o.value}" ${o.value === checked ? raw('checked') : ''}><span class="seg-item">${o.label}</span></label>`)}</div>`;
}

export function copyField(id: string, value: string, label: string): SafeHtml {
  return html`<div class="copy-field"><input id="${id}" type="text" readonly value="${value}" aria-label="${label}">${iconBtn('copy', `Copy ${label.toLowerCase()}`, { secondary: true, attrs: html`data-copy="${id}"` })}</div>`;
}

export function copyBtn(value: string, label: string): SafeHtml {
  return iconBtn('copy', label, { size: 'xs', attrs: html`data-copy-value="${value}"` });
}

// ---- Time -------------------------------------------------------------------------------------

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
    if (f < 86400) return `in ${Math.round(f / 3600)} h`;
    return `in ${Math.round(f / 86400)} days`;
  }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** A relative time with the full date as a tooltip. */
export function when(d: Date | null | undefined): SafeHtml {
  if (!d) return html`<span class="em">—</span>`;
  return html`<time datetime="${d.toISOString()}" title="${formatDate(d)}">${timeAgo(d)}</time>`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---- Ticket status ----------------------------------------------------------------------------

export const TICKET_STATUS: Record<SubmissionStatus, { label: string; tone: Tone; icon: IconName; iconTone: string }> = {
  uncertain: { label: 'Needs check', tone: 'warn', icon: 'circle-help', iconTone: 'warn' },
  failed: { label: 'Failed', tone: 'danger', icon: 'circle-x', iconTone: 'danger' },
  pending: { label: 'Queued', tone: 'neutral', icon: 'clock', iconTone: 'muted' },
  processing: { label: 'Filing', tone: 'neutral', icon: 'clock', iconTone: 'muted' },
  created: { label: 'Filed', tone: 'ok', icon: 'circle-check', iconTone: 'ok' },
  dismissed: { label: 'Closed', tone: 'closed', icon: 'circle-slash', iconTone: 'muted' },
};

export function statusPill(status: SubmissionStatus): SafeHtml {
  const s = TICKET_STATUS[status];
  return pill(s.label, s.tone);
}
