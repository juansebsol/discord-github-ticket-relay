/** Server-rendered previews of what members see in Discord. app.js keeps them in sync while typing. */
import { escapeHtml, html, raw, type SafeHtml } from '../lib/html.js';
import type { Deps } from '../domain/types.js';
import { icon } from './ui.js';

/**
 * Discord-markdown subset for previews: escapes everything first, then renders role mentions
 * (by role name, as Discord does), **bold** and #-headings. Mirrors discordHtml() in app.js.
 */
export function discordMd(text: string, roleNames: Map<string, string> = new Map()): SafeHtml {
  const lines = escapeHtml(text).split('\n').map((line) => {
    const out = line
      .replace(/&lt;@&amp;(\d+)&gt;/g, (_m, id: string) => `<span class="dp-mention">@${escapeHtml(roleNames.get(id) ?? 'unknown-role')}</span>`)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const h = /^#{1,3} (.*)$/.exec(out);
    return h ? `<span class="dp-h">${h[1]}</span>` : out;
  });
  return raw(lines.join('<br>'));
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
