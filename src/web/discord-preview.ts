/** Server-rendered previews of what members see in Discord. app.js keeps them in sync while typing. */
import { escapeHtml, html, raw, type SafeHtml } from '../lib/html.js';
import { formLead, truncate, visibilityNotice } from '../discord/messages.js';
import type { FormSection } from '../domain/forms.js';
import type { myTicketDetail, myTicketsPage } from '../domain/my-tickets.js';
import type { Deps } from '../domain/types.js';
import { icon } from './ui.js';

/** A Discord timestamp (<t:…:R>) as members read it: "3 days ago". Mirrors relativeTime() in app.js. */
export function relativeTime(seconds: number, now = Date.now()): string {
  const diff = Math.round(now / 1000 - seconds);
  const units: [number, string][] = [[31_536_000, 'year'], [2_592_000, 'month'], [86_400, 'day'], [3_600, 'hour'], [60, 'minute']];
  for (const [size, name] of units) {
    const n = Math.floor(Math.abs(diff) / size);
    if (n >= 1) return diff >= 0 ? `${n} ${name}${n === 1 ? '' : 's'} ago` : `in ${n} ${name}${n === 1 ? '' : 's'}`;
  }
  return 'just now';
}

/**
 * Discord-markdown subset for previews: escapes everything first, then renders role mentions
 * (by role name, as Discord does), timestamps, **bold**, [links](…), #-headings and - lists.
 * Mirrors discordHtml() in app.js.
 */
export function discordMd(text: string, roleNames: Map<string, string> = new Map()): SafeHtml {
  const parts = escapeHtml(text).split('\n').map((line) => {
    const out = line
      .replace(/&lt;@&amp;(\d+)&gt;/g, (_m, id: string) => `<span class="dp-mention">@${escapeHtml(roleNames.get(id) ?? 'unknown-role')}</span>`)
      .replace(/&lt;t:(\d+)(?::[tTdDfFR])?&gt;/g, (_m, s: string) => `<span class="dp-ts">${relativeTime(Number(s))}</span>`)
      .replace(/`([^`]+)`/g, '<code class="dp-code">$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\][]+)\]\((https?:[^)\s]+)\)/g, '<span class="dp-a">$1</span>');
    const h = /^#{1,3} (.*)$/.exec(out);
    if (h) return { html: `<span class="dp-h">${h[1]}</span>`, block: true };
    const li = /^\s*[-*] (.*)$/.exec(out);
    return li ? { html: `<span class="dp-li">${li[1]}</span>`, block: true } : { html: out, block: false };
  });
  // Headings and list items are blocks: a line break only between two lines of text.
  return raw(parts.map((p, i) => (i > 0 && !p.block && !parts[i - 1]!.block ? '<br>' : '') + p.html).join(''));
}

export interface BotIdentity {
  name: string;
  avatarUrl: string | null;
}

/** The bot's name and avatar for previews (the Discord client caches the lookup). */
export async function botIdentity(deps: Deps): Promise<BotIdentity> {
  if (!deps.discord) return { name: 'Ticket Relay', avatarUrl: null };
  try {
    const bot = await deps.discord.getBotUser();
    return {
      name: bot.global_name ?? bot.username,
      avatarUrl: bot.avatar ? `https://cdn.discordapp.com/avatars/${bot.id}/${bot.avatar}.png?size=64` : null,
    };
  } catch {
    return { name: 'Ticket Relay', avatarUrl: null };
  }
}

/** A Discord message from the bot, wrapping embed/component markup. */
export function botMessage(bot: BotIdentity, inner: SafeHtml, label: string): SafeHtml {
  return html`<div class="dp" aria-label="${label}"><div class="dp-msg">
    <div class="dp-avatar" aria-hidden="true"><img src="${bot.avatarUrl ?? '/static/logo.png'}" alt="" width="40" height="40"></div>
    <div><div><span class="dp-name">${bot.name}</span><span class="dp-tag">APP</span></div>${inner}</div>
  </div></div>`;
}

/** Caption row above a preview: channel, "Preview" and an optional link to the live message. */
export function previewCaption(channel: string | null, link: string | null, prefix = ''): SafeHtml {
  return html`<div class="dp-cap">${channel ? html`${icon('hash', 14)}<span>${channel}</span><span>·</span>` : ''}<span>${prefix}Preview</span>${link
    ? html`<a class="btn ghost sm" href="${link}" target="_blank" rel="noopener noreferrer"><span class="lbl">View in Discord</span><span class="trail">${icon('arrow-up-right', 14)}</span></a>`
    : ''}</div>`;
}

export function selectPreview(placeholder: string): SafeHtml {
  return html`<div class="dp-select"><span>${placeholder}</span>${icon('chevron-down', 16)}</div>`;
}

/** The My tickets reply as a member sees it, from the same payload the bot sends. */
export function myTicketsPreview(bot: BotIdentity, payload: ReturnType<typeof myTicketsPage>): SafeHtml {
  const e = payload.embeds[0]!;
  const first = payload.components[0]?.components[0];
  const menu = first && 'placeholder' in first ? first.placeholder : null;
  return botMessage(bot, html`<div class="dp-embed"><h4>${e.title}</h4><p>${discordMd(e.description)}</p>${'footer' in e && e.footer ? html`<div class="dp-time">${e.footer.text}</div>` : ''}</div>
    ${menu ? selectPreview(menu) : ''}
    <div class="dp-ephemeral">${icon('eye', 14)}<span>Only you can see this</span></div>`, 'Preview of My tickets in Discord');
}

type PreviewButton = { style: number; label: string; custom_id?: string; url?: string };
const EMBED_TONES: Record<number, string> = { 0xd99a1e: 'amber', 0x2e9e5b: 'green' };

/**
 * One ticket's page in My tickets, with its buttons. `attrs` adds attributes to a button (the
 * Panel ties each action button to its switch).
 */
export function myTicketPreview(bot: BotIdentity, payload: ReturnType<typeof myTicketDetail>, attrs: (b: PreviewButton) => SafeHtml | '' = () => ''): SafeHtml {
  const e = payload.embeds[0]!;
  const rows = payload.components.map((r) => r.components as PreviewButton[]);
  const cls = (b: PreviewButton) => (b.style === 1 ? 'blurple' : b.style === 3 ? '' : 'grey');
  return botMessage(bot, html`<div class="dp-embed ${EMBED_TONES[e.color] ?? ''}"><h4>${e.title}</h4><p>${discordMd(e.description)}</p></div>
    ${rows.map((r) => html`<div class="dp-buttons">${r.map((b) => html`<span class="dp-button ${cls(b)}" ${attrs(b)}>${b.label}${b.style === 5 ? icon('arrow-up-right', 14) : ''}</span>`)}</div>`)}
    <div class="dp-ephemeral">${icon('eye', 14)}<span>Only you can see this</span></div>`, 'Preview of a ticket’s page in My tickets');
}

type PreviewApp = { name: string; repoPrivate: boolean; notice?: string };

/**
 * A ticket form as members see it in Discord. app.js redraws the sections while the form
 * builder is edited, from the same data attributes. noticeId names the notice's element, for
 * the notice fields' live preview (Discord tickets › Panel).
 */
export function formPreview(app: PreviewApp, type: { name: string } | undefined, sections: FormSection[], o: { id?: string; noticeId?: string } = {}): SafeHtml {
  const notice = app.notice ?? visibilityNotice(app.repoPrivate);
  return html`<div class="dp dp-form" ${o.id ? html`id="${o.id}"` : ''} aria-label="Preview of the form in Discord" data-app="${app.name}" data-type="${type?.name ?? ''}" data-notice="${notice}">
    <p class="dp-modal-title">${truncate(type ? `${type.name}: ${app.name}` : `New ticket: ${app.name}`, 45)}</p>
    <div data-pv-sections>${sections.map((s) => formPreviewSection(app, type, s, notice, o.noticeId))}</div>
    <div class="dp-actions"><span class="dp-btn link">Cancel</span><span class="dp-btn">Submit</span></div>
  </div>`;
}

function formPreviewSection(app: PreviewApp, type: { name: string } | undefined, s: FormSection, notice: string, noticeId?: string): SafeHtml {
  if (s.kind === 'intro') return html`<p class="dp-text">${discordMd(formLead(app, type, s.text, false))}<br><br><span ${noticeId ? html`id="${noticeId}"` : ''}>${discordMd(notice)}</span></p>`;
  const required = s.kind === 'title' || s.kind === 'description' || s.required;
  const field = s.kind === 'files'
    ? html`<div class="dp-drop">${icon('upload', 16)}<span>Drag and drop or click to upload</span></div>`
    : html`<div class="dp-input${s.kind === 'description' || s.kind === 'paragraph' ? ' tall' : ''}">${s.placeholder ? html`<span class="dp-ph">${s.placeholder}</span>` : ''}</div>`;
  return html`<div class="dp-field"><div class="dp-l">${s.label || 'Question'}${required ? html`<span class="dp-req"> *</span>` : ''}</div>${s.hint ? html`<div class="dp-d">${s.hint}</div>` : ''}${field}</div>`;
}
