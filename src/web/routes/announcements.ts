/**
 * Announcements: write a message, pick the channels, and the bot posts it there. The list has the
 * drafts and what was posted where; each one opens in the editor beside a preview, to post it,
 * change it everywhere at once, or delete it from Discord (it becomes a draft again).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CARD_COLOR_IDS,
  CARD_COLORS,
  deleteDraft,
  getPost,
  hasBody,
  listPosts,
  POST_BUTTONS_MAX,
  POST_CHANNELS_MAX,
  POST_LIMITS,
  postCounts,
  publishPost,
  savePost,
  unpublishPost,
  updatePosted,
  type CardColor,
  type PostButton,
  type PostInput,
  type PostRow,
} from '../../announcements/posts.js';
import { getAnnouncement } from '../../announcements/settings.js';
import { inspectRoles, type RoleInspection } from '../../domain/contributors.js';
import { inspectGuild, type GuildAccess } from '../../domain/discord-checks.js';
import { can } from '../../domain/permissions.js';
import { getDiscordConnection } from '../../domain/store.js';
import { UserFacingError } from '../../domain/types.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { botIdentity, botMessage, discordMd, previewCaption } from '../discord-preview.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { csrfField, empty, icon, linkBtn, notice, pageHeader, pill, plural, segLinks, segRadios, selectWrap, submitBtn, tag, timeAgo, viewOnlyTag } from '../ui.js';
import { textField } from './panel.js';
import { landOn, toolHeader, toolHref, viewOnlyText } from './tool.js';
import { viewOnlyFooter } from './triage.js';

const SHOWS = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'posted', label: 'Posted' },
] as const;

/** JSON for app.js (role id → name), safe to embed in a non-executed script element. */
function roleNamesJson(names: Map<string, string>): SafeHtml {
  return raw(`<script type="application/json" id="role-names">${JSON.stringify(Object.fromEntries(names)).replace(/</g, '\\u003c')}</script>`);
}

/** What the list shows for it: the message's first line, or else the card's title. */
function headline(p: Pick<PostRow, 'content' | 'card_title' | 'card_text'>): string {
  const first = (t: string | null | undefined) => (t ?? '').split('\n').map((l) => l.replace(/^#+\s*|[*_`~>]/g, '').trim()).find(Boolean) ?? '';
  return first(p.content) || first(p.card_title) || first(p.card_text) || 'Empty announcement';
}

const discordLink = (guildId: string | null | undefined, channelId: string, messageId: string | null) => (guildId && messageId ? `https://discord.com/channels/${guildId}/${channelId}/${messageId}` : null);

export function registerAnnouncementRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const base = (ctx: WorkspaceRequestContext) => `${ctx.base}/announcements`;

  // ---- The list -------------------------------------------------------------------------------

  app.get('/w/:wid/announcements', async (req, reply) => {
    const ctx = await landOn(web, req, reply, 'announcements');
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = base(ctx);
    const edit = can(ctx.membership, 'announcements.edit');
    const [all, counts, conn] = await Promise.all([listPosts(deps.db, wid), postCounts(deps.db, wid), getDiscordConnection(deps.db, wid)]);
    const show = SHOWS.find((s) => s.key === (req.query as { show?: string }).show) ?? SHOWS[0];
    const rows = all.filter((p) => show.key === 'all' || (show.key === 'draft' ? p.status !== 'posted' : p.status === 'posted'));
    const n = { all: all.length, draft: counts.drafts, posted: counts.posted };
    const newBtn = edit ? linkBtn(`${b}/new`, 'New announcement', { variant: 'primary', icon: 'plus' }) : null;

    const row = (p: PostRow) => {
      const posted = p.status === 'posted';
      const when = posted && p.posted_at ? `${p.posted_by_name ? `Posted by ${p.posted_by_name}` : 'Posted'} ${timeAgo(p.posted_at)}` : `Draft · changed ${timeAgo(p.updated_at)}`;
      return html`<a class="pc-row" href="${b}/${p.id}">
        <span class="ki-ico" aria-hidden="true">${icon(posted ? 'megaphone' : 'pencil', 14)}</span>
        <span class="ki-main">
          <span class="ki-title">${headline(p)}</span>
          <span class="pc-where">${p.targets.length ? p.targets.map((t) => html`<span class="ki-chip mono">#${t.channelName}</span>`) : html`<span class="small muted">No channel yet</span>`}${p.role_name ? tag(`@${p.role_name}`, { cls: 'role' }) : ''}</span>
        </span>
        <span class="ki-side"><span class="pc-when small muted">${when}</span>${posted ? pill('Posted', 'ok') : pill('Draft', 'neutral')}${icon('chevron-right', 16, 'muted')}</span>
      </a>`;
    };

    const body = html`
      ${await toolHeader(web, ctx, 'announcements', 'announcements', { actions: [newBtn] })}
      ${!conn ? notice('warn', 'Connect Discord first', 'Announcements are posted by the bot in your server’s channels.') : ''}
      ${all.length
        ? html`<div class="pc-top">${segLinks('Show', SHOWS.map((s) => ({ href: s.key === 'all' ? b : `${b}?show=${s.key}`, label: s.label, count: n[s.key], current: s.key === show.key })))}
            <span class="small muted">${counts.posted30 ? `${plural(counts.posted30, 'announcement')} posted in the last 30 days` : ''}</span></div>
          <div class="ki-list">${rows.length ? rows.map(row) : html`<p class="ki-empty">Nothing here.</p>`}</div>`
        : html`<div class="card">${empty('megaphone', 'No announcements yet', 'Write a message, pick the channels, and the bot posts it there. You can change it or delete it later, everywhere at once.', newBtn)}</div>`}`;
    return web.render(reply, ctx, 'Announcements', 'announcements', body, { width: 'full' });
  });

  // ---- The editor -----------------------------------------------------------------------------

  async function editor(reply: FastifyReply, ctx: WorkspaceRequestContext, post: PostRow | null) {
    const wid = ctx.workspace.id;
    const b = base(ctx);
    const edit = can(ctx.membership, 'announcements.edit');
    const [conn, bot] = await Promise.all([getDiscordConnection(deps.db, wid), botIdentity(deps)]);
    const [guild, roles]: [GuildAccess | null, RoleInspection | null] = conn && deps.discord ? await Promise.all([inspectGuild(deps.discord, conn.guild_id), inspectRoles(deps.discord, conn.guild_id)]) : [null, null];
    const posted = post?.status === 'posted';
    const p = post ?? { content: '', card_title: null, card_text: null, card_color: 'blurple' as CardColor, role_id: null, role_name: null, buttons: [] as PostButton[], targets: [] };
    const chosen = new Set(p.targets.map((t) => t.channelId));
    const roleList = roles?.ok ? roles.roles.filter((r) => !r.reason?.startsWith('Managed')) : [];
    const roleNames = new Map<string, string>(roleList.map((r) => [r.id, r.name]));
    if (p.role_id && !roleNames.has(p.role_id)) roleNames.set(p.role_id, p.role_name ?? 'role');
    const disabled = edit ? '' : raw('disabled');

    // Where: a box per channel (once posted, the channels it's in).
    const channels = guild?.ok
      ? html`${guild.channels.length > 8 ? html`<input type="search" class="pc-filter" placeholder="Find a channel" aria-label="Find a channel" data-filter-rows="#pc-channels">` : ''}
          <div class="pc-channels" id="pc-channels">${guild.channels.map((c) => html`<label class="pc-ch${c.missing.length ? ' off' : ''}" data-search="${`${c.name} ${c.category ?? ''}`.toLowerCase()}" ${c.missing.length ? html`title="${`The bot is missing: ${c.missing.join(', ')}`}"` : ''}>
            <input type="checkbox" name="channel_ids" value="${c.id}" ${chosen.has(c.id) ? raw('checked') : ''} ${c.missing.length && !chosen.has(c.id) ? raw('disabled') : ''} ${disabled}>
            <span class="mono">#${c.name}</span>${c.category ? html`<span class="xs muted">${c.category}</span>` : ''}${c.missing.length ? html`<span class="xs muted">· bot can’t post</span>` : ''}</label>`)}</div>
          <p class="xs muted pc-note">Up to ${String(POST_CHANNELS_MAX)}. In an announcement channel, it’s also published to the servers that follow it.</p>`
      : html`<p class="small muted">${conn ? 'Discord can’t be reached right now, so the channels can’t be listed.' : 'Connect Discord first.'}</p>`;
    const where = posted
      ? html`<div class="pc-where">${post!.targets.map((t) => {
          const link = discordLink(conn?.guild_id, t.channelId, t.messageId);
          return link ? html`<a class="ki-chip mono" href="${link}" target="_blank" rel="noopener noreferrer">#${t.channelName} ${icon('arrow-up-right', 12)}</a>` : html`<span class="ki-chip mono">#${t.channelName}</span>`;
        })}</div><p class="xs muted pc-note">To post it somewhere else, delete it from Discord first: it becomes a draft again.</p>`
      : channels;

    const ping = roles?.ok
      ? selectWrap(html`<select id="pc-role" name="role_id" aria-label="Role to ping" ${disabled}>
          <option value="" ${p.role_id ? '' : raw('selected')}>No ping</option>
          ${roleList.map((r) => html`<option value="${r.id}" ${r.id === p.role_id ? raw('selected') : ''}>@${r.name}${!r.mentionable && !roles.canMentionAll ? ' (can’t be pinged yet)' : ''}</option>`)}
          ${p.role_id && !roleList.some((r) => r.id === p.role_id) ? html`<option value="${p.role_id}" selected>@${p.role_name ?? 'role'}</option>` : ''}
        </select>`)
      : html`<span class="small muted">${p.role_name ? `@${p.role_name}` : 'No ping'}</span>`;

    const buttonRow = (x: PostButton | null) => html`<div class="pc-btn" data-row>
      <input type="text" name="btn_label" value="${x?.label ?? ''}" maxlength="${String(POST_LIMITS.buttonLabel)}" placeholder="Label" aria-label="Button label" ${disabled}>
      <input type="url" name="btn_url" value="${x?.url ?? ''}" maxlength="${String(POST_LIMITS.buttonUrl)}" placeholder="https://…" pattern="https?://.+" aria-label="Button link" class="mono" spellcheck="false" ${disabled}>
      ${edit ? html`<button type="button" class="icon-btn sm" data-row-remove aria-label="Remove button" title="Remove button">${icon('x', 16)}</button>` : html`<span></span>`}
    </div>`;
    const hasCard = Boolean(p.card_title || p.card_text);

    const form = html`
      <div class="section">
        <div class="section-h"><div><h3>Where</h3><div class="desc">${posted ? 'Posted in these channels.' : 'The channels the bot posts it in.'}</div></div></div>
        ${where}
      </div>
      <div class="section">
        <div class="fields">
          ${textField({ id: 'pc-content', name: 'content', label: 'Message', value: p.content, max: POST_LIMITS.content, rows: 6, placeholder: 'What do you want to tell everyone?', hint: 'Discord formatting works: **bold**, - list, ## heading, [link](https://…).' })}
          <div class="field"><label for="pc-role">Ping</label>${ping}<div class="hint">Above the message. Only this role is pinged, never @everyone.${posted ? ' Changing it after posting doesn’t ping anyone.' : ''}</div></div>
        </div>
      </div>
      <details class="section pc-more" ${hasCard ? raw('open') : ''}>
        <summary><span class="cl-chev" aria-hidden="true">${icon('chevron-right', 14)}</span><span><b>Card</b><span class="small muted"> · optional: a box under the message with a title and a coloured edge</span></span></summary>
        <div class="fields">
          ${textField({ id: 'pc-title', name: 'card_title', label: 'Title', value: p.card_title ?? '', max: POST_LIMITS.title, placeholder: 'For example: Version 2.0 is out' })}
          ${textField({ id: 'pc-text', name: 'card_text', label: 'Text', value: p.card_text ?? '', max: POST_LIMITS.text, rows: 4, placeholder: 'More detail. Discord formatting works.' })}
          <div class="field"><span class="lbl">Colour</span><div class="pc-colors">${segRadios('card_color', CARD_COLOR_IDS.map((c) => ({ value: c, label: CARD_COLORS[c].name })), p.card_color, 'Card colour')}</div></div>
        </div>
      </details>
      <details class="section pc-more" ${p.buttons.length ? raw('open') : ''}>
        <summary><span class="cl-chev" aria-hidden="true">${icon('chevron-right', 14)}</span><span><b>Buttons</b><span class="small muted"> · optional: links under it, up to ${String(POST_BUTTONS_MAX)}</span></span></summary>
        <div class="pc-btns" data-rows data-rows-max="${String(POST_BUTTONS_MAX)}">
          <input type="hidden" name="buttons" value="1">
          ${p.buttons.map(buttonRow)}
          ${edit ? html`<template data-row-template>${buttonRow(null)}</template>` : ''}
        </div>
        ${edit ? html`<div class="row cl-add"><button type="button" class="btn sm" data-row-add>${icon('plus', 14)}Add button</button></div>` : p.buttons.length ? '' : html`<p class="small muted">No buttons.</p>`}
      </details>`;

    const confirmPost = 'data-confirm-title="Post this announcement?" data-confirm-body="The bot posts it in every channel you ticked, and pings the role if you chose one. You can change or delete it afterwards." data-confirm-label="Post now"';
    const footer = !edit
      ? viewOnlyFooter('announcements')
      : posted
        ? html`<button type="submit" class="btn ghost danger" form="pc-unpost"><span class="lead">${icon('trash-2')}</span><span class="lbl">Delete from Discord</span></button>
            <div class="end">${submitBtn('Update in Discord', { variant: 'primary', icon: 'refresh-cw', loading: 'Updating…', name: 'intent', value: 'update', attrs: raw('data-dirty-enable') })}</div>`
        : html`${post ? html`<button type="submit" class="btn ghost danger" form="pc-delete"><span class="lead">${icon('trash-2')}</span><span class="lbl">Delete draft</span></button>` : html`<span></span>`}
            <div class="end">
              <span class="row small muted" data-dirty-show hidden><span class="dot c4" aria-hidden="true"></span>Unsaved changes</span>
              ${submitBtn('Save draft', { name: 'intent', value: 'save', loading: 'Saving…' })}
              ${submitBtn('Post now', { variant: 'primary', icon: 'send', name: 'intent', value: 'post', loading: 'Posting…', disabled: !guild?.ok, title: guild?.ok ? undefined : 'Connect Discord first', attrs: raw(confirmPost) })}
            </div>`;

    const preview = html`<div class="panel-preview" data-pc-preview>
      ${previewCaption(posted && post!.targets[0] ? post!.targets[0].channelName : null, posted ? discordLink(conn?.guild_id, post!.targets[0]!.channelId, post!.targets[0]!.messageId) : null)}
      ${botMessage(bot, html`
        <div class="dp-content" id="pc-pv-content" ${p.content.trim() || p.role_id ? '' : raw('hidden')}>${discordMd(p.role_id ? `<@&${p.role_id}>${p.content.trim() ? `\n${p.content.trim()}` : ''}` : p.content.trim(), roleNames)}</div>
        <div class="dp-embed pc-${p.card_color}" id="pc-pv-card" ${hasCard ? '' : raw('hidden')}><h4 id="pc-pv-title" ${p.card_title ? '' : raw('hidden')}>${p.card_title ?? ''}</h4><p id="pc-pv-text">${discordMd(p.card_text ?? '', roleNames)}</p></div>
        <div class="dp-buttons" id="pc-pv-buttons" data-arrow="${icon('arrow-up-right', 14).toString()}" ${p.buttons.length ? '' : raw('hidden')}>${p.buttons.map((x) => html`<span class="dp-button grey">${x.label}${icon('arrow-up-right', 14)}</span>`)}</div>
        <p class="pc-pv-empty" id="pc-pv-empty" ${hasBody(p) || p.role_id ? raw('hidden') : ''}>Your message shows up here as you write it.</p>`, 'Preview of the announcement in Discord')}
      <p class="dp-note">${posted ? 'Updating edits the messages in place; no one is pinged again.' : 'Members see it like this in every channel it’s posted in.'}</p>
    </div>`;

    const title = post ? headline(post) : 'New announcement';
    const body = html`
      ${pageHeader({
        crumbs: [{ href: toolHref(ctx, 'announcements') ?? undefined, label: 'Announcements' }, { label: post ? (posted ? 'Posted' : 'Draft') : 'New' }],
        title,
        after: [post ? (posted ? pill('Posted', 'ok') : pill('Draft', 'neutral')) : '', edit ? '' : viewOnlyTag(viewOnlyText('announcements'))],
        description: posted && post!.posted_at
          ? `${post!.posted_by_name ? `Posted by ${post!.posted_by_name}` : 'Posted'} ${timeAgo(post!.posted_at)} in ${plural(post!.targets.length, 'channel')}.`
          : post ? `Draft${post.created_by_name ? ` by ${post.created_by_name}` : ''} · changed ${timeAgo(post.updated_at)}.` : 'Write it, pick the channels, and post it. Save it as a draft to finish later.',
      })}
      ${roleNamesJson(roleNames)}
      <div class="panel-grid">
        <form method="post" action="${post ? `${b}/${post.id}` : `${b}/new`}" class="card" data-composer ${edit ? raw('data-dirty') : ''}>
          ${csrfField(ctx.csrf)}
          ${edit ? form : html`<fieldset class="plain view-only" disabled>${form}</fieldset>`}
          <div class="card-f">${footer}</div>
        </form>
        ${preview}
      </div>
      ${edit && post && !posted ? html`<form method="post" action="${b}/${post.id}" id="pc-delete" hidden data-confirm-title="Delete this draft?" data-confirm-body="It was never posted, so nothing changes in Discord." data-confirm-label="Delete draft" data-confirm-danger>${csrfField(ctx.csrf)}<input type="hidden" name="intent" value="delete"></form>` : ''}
      ${edit && posted ? html`<form method="post" action="${b}/${post!.id}" id="pc-unpost" hidden data-confirm-title="Delete it from Discord?" data-confirm-body="${`The bot deletes its message in ${plural(post!.targets.length, 'channel')}. It stays here as a draft, so you can post it again.`}" data-confirm-label="Delete from Discord" data-confirm-danger>${csrfField(ctx.csrf)}<input type="hidden" name="intent" value="unpost"></form>` : ''}`;
    return web.render(reply, ctx, `${title} · Announcements`, 'announcements', body, { width: 'full' });
  }

  app.get('/w/:wid/announcements/new', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'announcements.edit' });
    if (!ctx) return reply;
    return editor(reply, ctx, null);
  });

  app.get('/w/:wid/announcements/:id', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'view' });
    if (!ctx) return reply;
    const id = (req.params as { id: string }).id;
    const post = await getPost(deps.db, ctx.workspace.id, id);
    // A release's post from before GitHub releases moved to Bot features.
    if (!post && (await getAnnouncement(deps.db, ctx.workspace.id, id))) return reply.redirect(`${ctx.base}/bot/releases/${encodeURIComponent(id)}`, 301);
    const allowed = await web.requireWorkspace(req, reply, { permission: 'announcements.view' });
    if (!allowed) return reply;
    if (!post) return reply.callNotFound();
    return editor(reply, allowed, post);
  });

  /** What the editor sent, checked: channels and the role must belong to the connected server. */
  async function inputFrom(ctx: WorkspaceRequestContext, body: Record<string, unknown>, current: PostRow | null): Promise<PostInput> {
    const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
    const text = (k: string, max: number) => (typeof body[k] === 'string' ? (body[k] as string).replace(/\r\n/g, '\n').trim().slice(0, max) : '');
    const conn = await getDiscordConnection(deps.db, ctx.workspace.id);
    const discord = () => {
      if (!conn || !deps.discord) throw new UserFacingError('Connect a Discord server first.');
      return { discord: deps.discord, guildId: conn.guild_id };
    };
    // Channels (not once it's posted: it stays where it is).
    let channels = current?.targets.map((t) => ({ id: t.channelId, name: t.channelName })) ?? [];
    const ids = [...new Set(list(body.channel_ids))];
    if (current?.status !== 'posted' && (ids.length || channels.length)) {
      if (ids.length > POST_CHANNELS_MAX) throw new UserFacingError(`Up to ${POST_CHANNELS_MAX} channels.`);
      const known = new Map(channels.map((c) => [c.id, c.name]));
      const guild = ids.some((id) => !known.has(id)) ? await inspectGuild(discord().discord, discord().guildId) : null;
      if (guild && !guild.ok) throw new UserFacingError('Couldn’t read the server from Discord. Try again in a moment.');
      channels = ids.map((id) => {
        const c = guild?.ok ? guild.channels.find((x) => x.id === id) : null;
        if (c?.missing.length) throw new UserFacingError(`The bot is missing permissions in #${c.name}: ${c.missing.join(', ')}.`);
        const name = c?.name ?? known.get(id);
        if (!name) throw new UserFacingError('Choose one of the listed channels.');
        return { id, name };
      });
    }
    // The role.
    let role = current?.role_id ? { id: current.role_id, name: current.role_name ?? 'role' } : null;
    const roleId = typeof body.role_id === 'string' ? body.role_id : undefined;
    if (roleId !== undefined && roleId !== (role?.id ?? '')) {
      if (!roleId) role = null;
      else {
        const roles = await inspectRoles(discord().discord, discord().guildId);
        const r = roles.ok ? roles.roles.find((x) => x.id === roleId && !x.reason?.startsWith('Managed')) : undefined;
        if (!r) throw new UserFacingError('Choose one of the listed roles.');
        role = { id: r.id, name: r.name };
      }
    }
    // Buttons: rows left empty are dropped.
    let buttons = current?.buttons ?? [];
    if (body.buttons === '1') {
      const urls = list(body.btn_url);
      buttons = list(body.btn_label).map((label, i) => ({ label: label.trim().slice(0, POST_LIMITS.buttonLabel), url: (urls[i] ?? '').trim().slice(0, POST_LIMITS.buttonUrl) })).filter((x) => x.label || x.url);
      for (const x of buttons) {
        if (!x.label) throw new UserFacingError('Give every button a label.');
        if (!/^https?:\/\/\S+$/i.test(x.url)) throw new UserFacingError(`The “${x.label}” button needs a link starting with https://.`);
      }
      if (buttons.length > POST_BUTTONS_MAX) throw new UserFacingError(`Up to ${POST_BUTTONS_MAX} buttons.`);
    }
    const color = CARD_COLOR_IDS.find((c) => c === body.card_color) ?? current?.card_color ?? 'blurple';
    return { content: text('content', POST_LIMITS.content), cardTitle: text('card_title', POST_LIMITS.title) || null, cardText: text('card_text', POST_LIMITS.text) || null, cardColor: color, role, buttons, channels };
  }

  async function save(req: FastifyRequest, reply: FastifyReply, id: string | null) {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'announcements.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const intent = typeof body.intent === 'string' ? body.intent : 'save';
    const current = id ? await getPost(deps.db, wid, id) : null;
    if (id && !current) return reply.callNotFound();
    let at = id ? `${base(ctx)}/${id}` : `${base(ctx)}/new`;
    try {
      if (intent === 'delete') {
        await deleteDraft(deps.db, wid, id!);
        setFlash(reply, 'success', 'Draft deleted');
        return reply.redirect(base(ctx));
      }
      if (intent === 'unpost') {
        await unpublishPost(deps, current!);
        setFlash(reply, 'success', 'Deleted from Discord. It’s a draft again, so you can post it later.');
        return reply.redirect(at);
      }
      if (current?.status === 'posting') throw new UserFacingError('It’s being posted right now. Reload in a moment.');
      const input = await inputFrom(ctx, body, current);
      const saved = await savePost(deps.db, wid, ctx.user.id, id, input);
      at = `${base(ctx)}/${saved}`;
      if (intent === 'post') {
        const r = await publishPost(deps, wid, saved, ctx.user.id);
        setFlash(reply, r.failed.length ? 'error' : 'success', r.failed.length
          ? `Posted in ${r.posted.map((c) => `#${c}`).join(', ')}, but not in ${r.failed.join(', ')}.`
          : `Posted in ${r.posted.map((c) => `#${c}`).join(', ')}`);
      } else if (intent === 'update' && current?.status === 'posted') {
        const r = await updatePosted(deps, (await getPost(deps.db, wid, saved))!);
        setFlash(reply, 'success', r.missing.length ? `Updated. Deleted in Discord, so dropped: ${r.missing.map((c) => `#${c}`).join(', ')}.` : 'Updated in Discord. No one was pinged again.');
      } else setFlash(reply, 'success', 'Draft saved');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
      // A new one that couldn't be saved as it is: its text is kept as a draft, so nothing typed is lost.
      if (!id && at.endsWith('/new')) {
        const text = (k: string, max: number) => (typeof body[k] === 'string' ? (body[k] as string).replace(/\r\n/g, '\n').trim().slice(0, max) : '');
        const draft = { content: text('content', POST_LIMITS.content), cardTitle: text('card_title', POST_LIMITS.title) || null, cardText: text('card_text', POST_LIMITS.text) || null, cardColor: 'blurple' as CardColor, role: null, buttons: [], channels: [] };
        if (hasBody({ content: draft.content, card_title: draft.cardTitle, card_text: draft.cardText })) at = `${base(ctx)}/${await savePost(deps.db, wid, ctx.user.id, null, draft)}`;
      }
    }
    return reply.redirect(at);
  }

  app.post('/w/:wid/announcements/new', (req, reply) => save(req, reply, null));
  app.post('/w/:wid/announcements/:id', (req, reply) => save(req, reply, (req.params as { id: string }).id));
}
