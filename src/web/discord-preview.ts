/** Server-rendered previews of what members see in Discord. app.js keeps them in sync while typing. */
import { escapeHtml, html, raw, type SafeHtml } from '../lib/html.js';
import { formIntro, truncate, visibilityNotice } from '../discord/messages.js';
import type { FormSection } from '../domain/forms.js';
import type { Deps } from '../domain/types.js';
import { icon } from './ui.js';

/**
 * Discord-markdown subset for previews: escapes everything first, then renders role mentions
 * (by role name, as Discord does), **bold**, [links](…), #-headings and - lists. Mirrors
 * discordHtml() in app.js.
 */
export function discordMd(text: string, roleNames: Map<string, string> = new Map()): SafeHtml {
  const parts = escapeHtml(text).split('\n').map((line) => {
    const out = line
      .replace(/&lt;@&amp;(\d+)&gt;/g, (_m, id: string) => `<span class="dp-mention">@${escapeHtml(roleNames.get(id) ?? 'unknown-role')}</span>`)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<span class="dp-a">$1</span>');
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

/**
 * A ticket form as members see it in Discord. app.js redraws the sections while the form
 * builder is edited, from the same data attributes.
 */
export function formPreview(app: { name: string; repoPrivate: boolean }, type: { name: string } | undefined, sections: FormSection[], o: { id?: string } = {}): SafeHtml {
  return html`<div class="dp dp-form" ${o.id ? html`id="${o.id}"` : ''} aria-label="Preview of the form in Discord" data-app="${app.name}" data-type="${type?.name ?? ''}" data-notice="${visibilityNotice(app.repoPrivate)}">
    <p class="dp-modal-title">${truncate(type ? `${type.name}: ${app.name}` : `New ticket: ${app.name}`, 45)}</p>
    <div data-pv-sections>${sections.map((s) => formPreviewSection(app, type, s))}</div>
    <div class="dp-actions"><span class="dp-btn link">Cancel</span><span class="dp-btn">Submit</span></div>
  </div>`;
}

function formPreviewSection(app: { name: string; repoPrivate: boolean }, type: { name: string } | undefined, s: FormSection): SafeHtml {
  if (s.kind === 'intro') return html`<p class="dp-text">${discordMd(formIntro(app, type, s.text, false))}</p>`;
  const required = s.kind === 'title' || s.kind === 'description' || s.required;
  const field = s.kind === 'files'
    ? html`<div class="dp-drop">${icon('upload', 16)}<span>Drag and drop or click to upload</span></div>`
    : html`<div class="dp-input${s.kind === 'description' || s.kind === 'paragraph' ? ' tall' : ''}">${s.placeholder ? html`<span class="dp-ph">${s.placeholder}</span>` : ''}</div>`;
  return html`<div class="dp-field"><div class="dp-l">${s.label || 'Question'}${required ? html`<span class="dp-req"> *</span>` : ''}</div>${s.hint ? html`<div class="dp-d">${s.hint}</div>` : ''}${field}</div>`;
}
