import type { FastifyInstance } from 'fastify';
import { DEFAULT_NOTICE, DEFAULT_PANEL_INTRO, DEFAULT_PANEL_INTRO_BUTTONS, DEFAULT_PANEL_INTRO_GROUPS, DEFAULT_PANEL_TITLE, defaultPanelIntro, GROUP_TITLE_MAX, MORE_APPS_VALUE, visibilityNotice } from '../../discord/messages.js';
import { DEFAULT_MEMBER_TEXT, MAX_NEW_FILES, MEMBER_CLOSE, MEMBER_LIMITS, MEMBER_TEXT_KEYS, memberActions, memberActionsToStore, type MemberTextKey } from '../../domain/member-actions.js';
import { myTicketDetail, myTicketsPage, statusWords, type MemberTicket } from '../../domain/my-tickets.js';
import { formFor } from '../../domain/forms.js';
import { inspectGuild } from '../../domain/discord-checks.js';
import { listLinked, mainOf, setGroupTitles, setOnMainPanel } from '../../domain/linked.js';
import { checkPanel, linkedGroupTitle, mainGroupTitle, panelContent, panelGroupsOf, panelPayloadFor, publishPanel, unpublishPanel } from '../../domain/panel.js';
import { can, type MemberAccess } from '../../domain/permissions.js';
import { getApp, getDiscordConnection, getGitHubConnection, getPanel, listApps, setTicketsChannel } from '../../domain/store.js';
import { acceptSubmission } from '../../domain/submissions.js';
import { enabledTicketTypes, getTicketType } from '../../domain/ticket-types.js';
import { UserFacingError } from '../../domain/types.js';
import { validateWorkspace, type Check } from '../../domain/validation.js';
import { setMemberActions, setMyTickets, updateNotices, updatePanelText } from '../../domain/workspaces.js';
import { escapeHtml, html, raw, type SafeHtml } from '../../lib/html.js';
import { botIdentity, botMessage, discordMd, formPreview, myTicketPreview, myTicketsPreview, previewCaption, selectPreview } from '../discord-preview.js';
import { setFlash } from '../session.js';
import type { Web } from '../server.js';
import { csrfField, icon, linkBtn, pill, selectWrap, setting, submitBtn, switchInput, timeAgo, type IconName } from '../ui.js';
import { toolHeader } from './tool.js';
import { viewOnlyFooter } from './triage.js';

const LIMITS = { panel_title: 200, panel_intro: 1500, notice: 500 } as const;

/** "For PhotoCraft and DesignCraft." under a notice field: the apps it's shown for. */
function usedBy(names: string[], none: string): string {
  if (!names.length) return none;
  const shown = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names;
  return `For ${shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)!}` : shown[0]!}.`;
}

const CHECK_ICONS: Record<Check['status'], [IconName, string]> = { ok: ['circle-check', 'ok'], warning: ['triangle-alert', 'warn'], error: ['circle-x', 'danger'] };

/** Health checklist rows (Discord tickets › Panel, Contributor roles › Panel). */
export function checklist(checks: { status: Check['status']; title: string; detail?: string; fix?: { label: string; href: string } }[]): SafeHtml {
  return html`<ul class="checklist">${checks.map((c) => {
    const [name, tone] = CHECK_ICONS[c.status];
    return html`<li class="check-row">${icon(name, 16, tone)}<span>${c.title}${c.detail ? html`<span class="detail"> · ${c.detail}</span>` : ''}</span>${c.fix && c.status !== 'ok' ? linkBtn(c.fix.href, c.fix.label, { variant: 'ghost', size: 'sm', trail: 'arrow-right' }) : html`<span></span>`}</li>`;
  })}</ul>`;
}

/** A labelled text field with a live character counter. */
export function textField(o: { id: string; name?: string; label: string; value: string; max: number; rows?: number; placeholder?: string; preview?: string; md?: boolean; hint?: SafeHtml | string; defaultValue?: string; attrs?: SafeHtml }): SafeHtml {
  const attrs = html`id="${o.id}" name="${o.name ?? o.id}" maxlength="${String(o.max)}" ${o.placeholder ? html`placeholder="${o.placeholder}"` : ''} ${o.defaultValue !== undefined ? html`data-default="${o.defaultValue}"` : ''} ${o.preview ? html`data-preview="${o.preview}"` : ''} ${o.md ? raw('data-preview-md') : ''} ${o.attrs ?? ''}`;
  return html`<div class="field"><div class="field-head"><label for="${o.id}">${o.label}</label><span class="counter" data-counter-for="${o.id}">${String(o.value.length)} / ${String(o.max)}</span></div>
    ${o.rows ? html`<textarea ${attrs} rows="${String(o.rows)}">${o.value}</textarea>` : html`<input type="text" class="full" ${attrs} value="${o.value}">`}
    ${o.hint ? html`<div class="hint">${o.hint}</div>` : ''}</div>`;
}

/**
 * A health check's fix link, when this person can follow it: setup and deployment stay with
 * admins, apps need Edit on Apps, and choosing the channel needs Edit on the Panel. "Check
 * again" only reloads the page; links outside the workspace are kept.
 */
function fixFor(m: MemberAccess, base: string, fix: { label: string; href: string } | undefined): { label: string; href: string } | undefined {
  if (!fix || !fix.href.startsWith(`${base}/`)) return fix;
  const path = fix.href.slice(base.length);
  if (path === '/tickets/panel') return fix;
  if (path.startsWith('/tickets/panel')) return can(m, 'panel.edit') ? fix : undefined;
  if (path === '/apps' || path.startsWith('/apps/')) return can(m, 'apps.edit') ? fix : undefined;
  return can(m, 'manage') ? fix : undefined;
}

/** Saved panel text, or null when it matches a built-in default (the intro has one for the menu and one for the buttons). */
function cleanText(value: unknown, max: number, fallback: string | string[]): string | null {
  const v = String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
  return v && ![fallback].flat().includes(v) ? v : null;
}

/** A group button's name; null when it's empty or the default, so it follows a renamed workspace. */
function cleanGroupTitle(value: unknown, fallback: string): string | null {
  const v = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, GROUP_TITLE_MAX);
  return v && v !== fallback ? v : null;
}

/** Example tickets for the My tickets preview, for the first app (or "Your app"). */
function exampleTickets(app: { name: string; repo_owner: string; repo_name: string } | undefined): MemberTicket[] {
  const day = 86_400_000;
  const now = Date.now();
  const url = (n: number) => (app ? `https://github.com/${app.repo_owner}/${app.repo_name}/issues/${n}` : null);
  const t = (n: number, title: string, daysAgo: number, status: MemberTicket['status'], more: Partial<MemberTicket> = {}): MemberTicket => ({
    ref: `TR-EXAMPLE${n}`, workspaceId: '', app: app?.name ?? 'Your app', type: null, title, at: new Date(now - daysAgo * day), filedAt: new Date(now - daysAgo * day),
    status, version: null, releaseAt: null, issue: { number: n, url: url(n) }, sameAs: null, pull: null, closedAt: null, done: status === 'released',
    repoPrivate: false, issueOpen: status !== 'released', shared: false, updates: [], ...more,
  });
  return [
    t(128, 'Export crashes on large files', 2, 'working', { updates: [{ kind: 'details', at: new Date(now - day) }] }),
    t(131, 'Dark mode for the editor', 5, 'open'),
    t(97, 'Login loop after the update', 23, 'released', { version: 'v1.4' }),
  ];
}

export function registerPanelRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  app.get('/w/:wid/panel', async (req, reply) => reply.redirect(`/w/${(req.params as { wid: string }).wid}/tickets/panel`));

  app.get('/w/:wid/tickets/panel', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'panel.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    const ws = ctx.workspace;
    const m = ctx.membership;
    // Without Edit the page shows the same settings and preview, with its controls turned off.
    const edit = can(m, 'panel.edit');
    const [report, apps, panel, conn, types, bot] = await Promise.all([
      validateWorkspace(deps, wid, b),
      listApps(deps.db, wid),
      getPanel(deps.db, wid),
      getDiscordConnection(deps.db, wid),
      enabledTicketTypes(deps.db, wid),
      botIdentity(deps),
    ]);
    const state = await checkPanel(deps, wid, { live: false });
    const guild = deps.discord && conn && conn.status === 'active' ? await inspectGuild(deps.discord, conn.guild_id) : null;
    // A linked workspace's apps are on its main's panel, or on one of its own. A main's panel also
    // lists the apps of its linked workspaces that are on it.
    const main = await mainOf(deps.db, ws);
    const onMain = Boolean(main && ws.on_main_panel);
    const panelWs = onMain ? main! : ws;
    const [content, mainState, mainPanel, mainConn, others] = await Promise.all([
      panelContent(deps, panelWs),
      onMain ? checkPanel(deps, main!.id, { live: false }) : Promise.resolve(null),
      onMain ? getPanel(deps.db, main!.id) : Promise.resolve(null),
      onMain ? getDiscordConnection(deps.db, main!.id) : Promise.resolve(null),
      main ? Promise.resolve([]) : listLinked(deps.db, ws.id).then((l) => l.filter((x) => x.on_main_panel)),
    ]);
    const ownEnabled = apps.filter((a) => a.enabled);
    const enabledApps = content.apps.filter((a) => a.enabled);
    const otherApps = enabledApps.filter((a) => a.workspace_id !== panelWs.id);
    // A main's apps and its linked workspaces': a button each, named in Buttons, that opens its list.
    const groups = panelGroupsOf(content.family, content.apps);
    const title = panelWs.panel_title?.trim() || DEFAULT_PANEL_TITLE;
    const intro = panelWs.panel_intro?.trim() || defaultPanelIntro(panelWs.my_tickets, Boolean(groups));
    // The preview has the menu and the buttons, so the My tickets switch can show either while it's changed.
    const layout = (on: boolean) => {
      const { payload } = panelPayloadFor({ ...panelWs, my_tickets: on }, content.apps, content.hasTypes, content.family);
      const own = panelWs.panel_intro?.trim() || defaultPanelIntro(on, Boolean(groups));
      type Option = { label: string; value: string; description?: string };
      const selects: Option[][] = [];
      for (const row of payload.components) for (const c of row.components as { options?: Option[] }[]) if (c.options) selects.push(c.options);
      return { rest: payload.embeds[0]!.description.slice(own.length).replace(/^\n+/, ''), selects };
    };
    const menu = layout(false);
    const buttons = layout(true);
    const shows = (on: boolean) => html`data-layout="${on ? 'buttons' : 'menu'}" ${panelWs.my_tickets === on ? '' : raw('hidden')}`;
    const words = await statusWords(deps, panelWs.id);
    const shownPanel = onMain ? mainPanel : panel;
    const shownConn = onMain ? mainConn : conn;
    const messageLink = shownPanel && shownConn && (onMain ? mainState : state)?.state === 'published' ? `https://discord.com/channels/${shownConn.guild_id}/${shownPanel.channel_id}/${shownPanel.message_id}` : null;
    const channelName = shownConn?.tickets_channel_name ?? null;

    const strip =
      state.state === 'published'
        ? state.channelChanged
          ? html`${pill('Channel changed', 'warn')}<span class="small muted">${edit ? `Still posted in the old channel. Update the panel to move it to #${channelName ?? ''}.` : `Still posted in the old channel, not #${channelName ?? ''} yet.`}</span>`
          : state.outdated
            ? html`${pill('Out of date', 'warn')}<span class="small muted">The apps or text changed since it was posted ${timeAgo(panel!.published_at)}.</span>`
            : html`${pill('Published', 'ok')}<span class="small muted">in #${channelName ?? ''} · updated ${timeAgo(panel!.published_at)}</span>`
        : state.state === 'missing'
          ? html`${pill('Deleted in Discord', 'warn')}<span class="small muted">${edit ? 'Someone deleted the panel message. Publish it again.' : 'Someone deleted the panel message.'}</span>`
          : html`${pill('Not published', 'neutral')}<span class="small muted">${report.canPublish ? 'Ready to post.' : edit ? 'Fix the health checks below to publish.' : 'The health checks below need fixing first.'}</span>`;
    // On the main's panel: that panel's state, which the main's admins publish.
    const mainStrip = onMain && main
      ? mainState?.state === 'published'
        ? html`${pill(`On ${main.name}’s panel`, 'ok')}<span class="small muted">in #${channelName ?? ''}${mainState.outdated && !panelWs.my_tickets ? ` · ${main.name}’s panel needs publishing to show changes` : ''}</span>`
        : html`${pill(`On ${main.name}’s panel`, 'neutral')}<span class="small muted">${main.name}’s panel isn’t published yet.</span>`
      : null;
    const publishLabel = state.state === 'published' ? (state.channelChanged ? 'Move panel' : 'Update panel') : state.state === 'missing' ? 'Publish again' : 'Publish panel';

    const channelControl = !conn
      ? can(m, 'manage')
        ? html`<span class="small muted">Connect Discord first.</span> ${linkBtn(`${b}/setup/discord`, 'Connect', { size: 'sm', trail: 'arrow-right', variant: 'ghost' })}`
        : html`<span class="small muted">Discord isn’t connected yet. An admin can connect it.</span>`
      : guild?.ok
        ? selectWrap(html`<select id="channel" name="channel_id" aria-label="Tickets channel">
            ${conn.tickets_channel_id && !guild.channels.some((c) => c.id === conn.tickets_channel_id) ? html`<option value="" selected disabled>#${conn.tickets_channel_name ?? 'deleted channel'} (no longer available)</option>` : ''}
            ${conn.tickets_channel_id ? '' : html`<option value="" selected disabled>${edit ? 'Choose a channel…' : 'No channel chosen yet'}</option>`}
            ${guild.channels.map((c) => html`<option value="${c.id}" ${c.id === conn.tickets_channel_id ? raw('selected') : ''} ${c.missing.length ? raw('disabled') : ''}>#${c.name}${c.missing.length ? ` (bot missing: ${c.missing.join(', ')})` : c.category ? ` · ${c.category}` : ''}</option>`)}
          </select>`)
        : html`<span class="small muted">${guild && !guild.ok ? guild.message : 'Discord can’t be reached right now.'}</span>`;

    const firstType = types[0];
    // Previews of the form and My tickets: this workspace's own first app (the panel may list others' too).
    const sample = ownEnabled[0];
    // Fix links only for pages this person can use; the rest stay as text.
    const checks = report.checks.filter((c) => c.area !== 'panel').map((c) => ({ ...c, fix: fixFor(m, b, c.fix) }));
    // The notice: a field for each kind of repository the apps use (public while there are none).
    const publicApps = apps.filter((a) => !a.repo_private).map((a) => a.name);
    const privateApps = apps.filter((a) => a.repo_private).map((a) => a.name);
    const showPublic = publicApps.length > 0 || !privateApps.length || Boolean(ws.notice_public);
    const showPrivate = privateApps.length > 0 || Boolean(ws.notice_private);
    // The previews show the sample app's notice, so its field updates them while typing.
    const sampleNotice = sample ? visibilityNotice(sample.repo_private, ws) : '';
    const noticePreview = (repoPrivate: boolean) => (sample?.repo_private === repoPrivate ? 'pv-notice pv-notice-form' : undefined);

    // What members can do on an open ticket: a switch each, and the comments it posts when it's on.
    const actions = memberActions(ws);
    const commentField = (key: MemberTextKey, label: string, hint?: SafeHtml | string) => textField({
      id: `member_text_${key}`, label, value: actions.text[key], max: MEMBER_LIMITS.comment, rows: key === 'details' ? 3 : 2,
      placeholder: key === 'details' ? DEFAULT_MEMBER_TEXT.details : 'No comment', defaultValue: DEFAULT_MEMBER_TEXT[key], hint,
    });
    const memberAction = (key: 'details' | 'files' | 'close', label: string, desc: SafeHtml | string, on: boolean, fields: SafeHtml[]) => html`<div class="member-action">
      ${setting(label, desc, switchInput({ name: `member_${key}`, id: `member_${key}`, checked: on, label }), { switchRow: true, flat: true, for: `member_${key}` })}
      <div class="fields" data-follows="member_${key}" ${on ? '' : raw('hidden')}>${fields}</div>
    </div>`;
    // The example ticket's buttons follow their switches while they're changed.
    const follows = (b: { custom_id?: string }) => {
      const key = /^tr:mine:([dfc]):/.exec(b.custom_id ?? '')?.[1];
      const name = key === 'd' ? 'details' : key === 'f' ? 'files' : key === 'c' ? 'close' : null;
      return name ? html`data-follows="member_${name}" ${actions[name] ? '' : raw('hidden')}` : '';
    };
    const examples = exampleTickets(sample);

    // A linked workspace: on its main's panel, or a panel of its own (the parts below are for that one).
    const homeChoice = (value: 'main' | 'own', t: string, d: string) => html`<label class="choice"><input type="radio" name="panel_home" value="${value}" id="home-${value}" ${(value === 'main') === onMain ? raw('checked') : ''}><span><span class="t">${t}</span><span class="d">${d}</span></span></label>`;
    const where = main
      ? html`<div class="section" id="where">
          <div class="section-h"><div><h3>Where members open tickets</h3><div class="desc">${ws.name} uses ${main.name}’s Discord server.</div></div></div>
          <input type="hidden" name="panel_home_sent" value="1">
          <div class="choices" role="radiogroup" aria-label="Where members open tickets">
            ${homeChoice('main', `On ${main.name}’s panel`, `Members find its apps behind the linked workspaces’ button there, next to ${main.name}’s own. The panel’s channel, text, button names and My tickets switch are set on ${main.name}’s Panel page.`)}
            ${homeChoice('own', 'Its own panel', `A panel just for ${ws.name}’s apps, in a channel of ${main.name}’s server.`)}
          </div>
        </div>`
      : '';
    // A main with linked workspaces on its panel: a button for its apps and one for theirs, named here.
    const appNames = (ids: string[]) => {
      const names = enabledApps.filter((a) => ids.includes(a.workspace_id)).map((a) => a.name);
      if (!names.length) return 'No enabled apps yet.';
      return `${names.length} app${names.length === 1 ? '' : 's'}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}`;
    };
    const othersWithApps = others.filter((l) => otherApps.some((a) => a.workspace_id === l.id));
    const linkedDefault = linkedGroupTitle({ panel_linked_title: null }, othersWithApps.length ? othersWithApps : others);
    const alsoHere = others.length
      ? html`<div class="section" id="buttons">
          <div class="section-h"><div><h3>Buttons</h3><div class="desc">Apps from linked workspaces are on this panel too. Members press the button for ${ws.name}’s apps or the linked workspaces’, then pick the app from its list. Each app files tickets in its own workspace.${groups ? '' : ' Until both have enabled apps, the panel keeps one menu.'}</div></div>
            ${edit ? html`<button type="button" class="btn ghost sm" data-reset-fields="group_main group_linked"><span class="lead">${icon('undo-2', 14)}</span><span class="lbl">Reset names</span></button>` : ''}</div>
          <div class="fields">
            ${textField({ id: 'group_main', label: `Button for ${ws.name}’s apps`, value: mainGroupTitle(ws), max: GROUP_TITLE_MAX, placeholder: ws.name, defaultValue: ws.name, preview: 'pv-grp-main pv-step-main', hint: appNames([ws.id]) })}
            ${textField({ id: 'group_linked', label: 'Button for linked workspaces’ apps', value: ws.panel_linked_title?.trim() || linkedDefault, max: GROUP_TITLE_MAX, placeholder: linkedDefault, defaultValue: linkedDefault, preview: 'pv-grp-linked pv-step-linked',
              hint: html`${appNames(others.map((l) => l.id))} · ${others.map((l, i) => html`${i ? ', ' : ''}<a href="/w/${l.id}/tickets/panel">${l.name}’s Panel page</a>`)}` })}
          </div>
        </div>`
      : '';
    const ownOnly = (inner: SafeHtml) => (main ? html`<div data-follows="home-own" ${onMain ? raw('hidden') : ''}>${inner}</div>` : inner);

    const sections = html`
          ${where}
          ${ownOnly(html`<div class="section" id="channel">
            ${setting('Channel', 'Where members open tickets. The bot needs to post there.', channelControl, { for: guild?.ok ? 'channel' : undefined, flat: true })}
          </div>
          ${alsoHere}
          <div class="section">
            <div class="section-h"><div><h3>Content</h3><div class="desc">The heading and introduction at the top of the panel.</div></div>
              ${edit ? html`<button type="button" class="btn ghost sm" data-reset-fields="panel_title panel_intro"><span class="lead">${icon('undo-2', 14)}</span><span class="lbl">Reset to default</span></button>` : ''}</div>
            <div class="fields">
              ${textField({ id: 'panel_title', label: 'Heading', value: title, max: LIMITS.panel_title, placeholder: DEFAULT_PANEL_TITLE, preview: 'pv-title' })}
              ${textField({ id: 'panel_intro', label: 'Introduction', value: intro, max: LIMITS.panel_intro, rows: 3, placeholder: defaultPanelIntro(ws.my_tickets, Boolean(groups)), preview: 'pv-intro', md: true, hint: edit ? 'Discord formatting works, for example **bold**.' : undefined, attrs: html`data-default-menu="${groups ? DEFAULT_PANEL_INTRO_GROUPS : DEFAULT_PANEL_INTRO}" data-default-buttons="${DEFAULT_PANEL_INTRO_BUTTONS}"` })}
            </div>
          </div>
          `)}
          <div class="section" id="my-tickets">
            ${ownOnly(setting('My tickets', html`The panel shows two buttons instead of the app menu: <strong>Open a ticket</strong>, and <strong>My tickets</strong>, where members see the tickets they’ve sent here and what’s happening with each. Each member sees only their own. Publish the panel to show the change.`,
              html`<input type="hidden" name="my_tickets_sent" value="1">${switchInput({ name: 'my_tickets', id: 'my_tickets', checked: ws.my_tickets, label: 'My tickets', attrs: raw('data-layout-switch') })}`,
              { switchRow: true, flat: true, for: 'my_tickets' }))}
            <div class="member-actions" ${main ? '' : html`data-follows="my_tickets" ${ws.my_tickets ? '' : raw('hidden')}`}>
              <input type="hidden" name="member_actions_sent" value="1">
              <div class="section-h"><div><h4>On each open ticket</h4><div class="desc">${main
                ? `Buttons members can use on one of their ${ws.name} tickets while it’s open on GitHub, from My tickets on the panel it’s on. Changes show right away.`
                : 'Buttons members can use on one of their tickets while it’s open on GitHub. Changes show right away, without publishing the panel.'}</div></div>
                ${edit ? html`<button type="button" class="btn ghost sm" data-reset-fields="${MEMBER_TEXT_KEYS.map((k) => `member_text_${k}`).join(' ')}"><span class="lead">${icon('undo-2', 14)}</span><span class="lbl">Reset comments</span></button>` : ''}</div>
              ${memberAction('details', 'Add details', html`Members write more about the problem. It’s posted on the issue as a comment, inside your text below.`, actions.details,
                [commentField('details', 'Comment on GitHub', html`<code>{details}</code> is what they wrote and has to stay in. <code>{app}</code> is the app’s name.`)])}
              ${memberAction('files', 'Add screenshots', `Up to ${MAX_NEW_FILES} PNG or JPG images at a time, added to the issue’s Attachments section. A ticket’s files stay within 10 MB.`, actions.files,
                [commentField('files', 'Comment on GitHub', html`Lets the team know. <code>{screenshots}</code> is “2 screenshots”. Leave it empty to post no comment.`)])}
              ${memberAction('close', 'Close their ticket', `Members choose “${MEMBER_CLOSE.works.label}” (closed as completed) or “${MEMBER_CLOSE.notNeeded.label}” (closed as not planned). It’s in the Mod log as theirs, where moderators can undo it for 15 minutes. A ticket other reports are marked the same as is left for the team to close.`, actions.close,
                [commentField('works', `Comment for “${MEMBER_CLOSE.works.label}”`), commentField('notNeeded', `Comment for “${MEMBER_CLOSE.notNeeded.label}”`, 'Leave one empty to close without a comment.')])}
            </div>
          </div>
          <div class="section" id="notice">
            <div class="section-h"><div><h3>Privacy notice</h3><div class="desc">Shown when members choose a ticket type and at the top of the form, so they know who can read their report. Changes show right away, without publishing the panel.</div></div>
              ${edit ? html`<button type="button" class="btn ghost sm" data-reset-fields="notice_public notice_private"><span class="lead">${icon('undo-2', 14)}</span><span class="lbl">Reset to default</span></button>` : ''}</div>
            <div class="fields">
              ${showPublic ? textField({ id: 'notice_public', label: 'Public repositories', value: visibilityNotice(false, ws), max: LIMITS.notice, rows: 3, placeholder: DEFAULT_NOTICE.public, preview: noticePreview(false), md: true, hint: usedBy(publicApps, 'No app has a public repository yet.') }) : ''}
              ${showPrivate ? textField({ id: 'notice_private', label: 'Private repositories', value: visibilityNotice(true, ws), max: LIMITS.notice, rows: 3, placeholder: DEFAULT_NOTICE.private, preview: noticePreview(true), md: true, hint: usedBy(privateApps, 'No app has a private repository yet.') }) : ''}
            </div>
          </div>
          <div class="section">
            <div class="section-h"><div><h3>Health</h3><div class="desc">Checked live against GitHub and Discord when this page loads.</div></div>${linkBtn(`${b}/tickets/panel`, 'Check again', { variant: 'ghost', size: 'sm', icon: 'refresh-cw' })}</div>
            ${checklist(checks)}
          </div>`;

    const settingsCard = edit
      ? html`<form method="post" action="${b}/tickets/panel" class="card" data-dirty>
          ${csrfField(ctx.csrf)}
          <div class="card-h strip"><div class="row">${mainStrip ?? strip}</div></div>
          ${sections}
          <div class="section">
            <div class="section-h"><div><h3>Test ticket</h3><div class="desc">Files a real GitHub issue through the whole pipeline, marked as a test and attributed to you.</div></div></div>
            ${ownEnabled.length
              ? html`<div class="row">
                  ${selectWrap(html`<select name="app_id" form="test-form" aria-label="App for the test ticket">${ownEnabled.map((a) => html`<option value="${a.id}">${a.name} · ${a.repo_owner}/${a.repo_name}</option>`)}</select>`)}
                  ${types.length ? selectWrap(html`<select name="type_id" form="test-form" aria-label="Ticket type">${types.map((t) => html`<option value="${t.id}">${t.name}</option>`)}</select>`) : ''}
                  ${submitBtn('Send test', { icon: 'send', loading: 'Creating issue…', form: 'test-form' })}</div>`
              : html`<p class="small muted">Add an app first.</p>`}
          </div>
          <div class="card-f">
            ${panel ? html`<button type="submit" class="btn ghost danger" form="remove-form"><span class="lead">${icon('trash-2')}</span><span class="lbl">Remove panel</span></button>` : html`<span></span>`}
            <div class="end">
              ${report.canPublish || onMain ? '' : html`<span class="small muted" data-clean-show>Fix the problems under Health to publish.</span>`}
              <span class="row small muted" data-dirty-show hidden><span class="dot c4" aria-hidden="true"></span>Unsaved changes</span>
              <button type="button" class="btn ghost" data-discard data-dirty-show hidden>Discard</button>
              ${report.canPublish && !onMain
                ? submitBtn(publishLabel, { variant: 'primary', icon: 'send', loading: 'Publishing…', name: 'intent', value: 'publish' })
                : html`${submitBtn('Save changes', { variant: 'primary', loading: 'Saving…', name: 'intent', value: 'save', attrs: raw('data-dirty-enable') })}`}
            </div>
          </div>
        </form>`
      : html`<div class="card">
          <div class="card-h strip"><div class="row">${mainStrip ?? strip}</div></div>
          <fieldset class="plain view-only" disabled>${sections}</fieldset>
          <div class="card-f">${viewOnlyFooter('the panel')}</div>
        </div>`;

    // "your 3 enabled apps, then 1 from Mailcraft", or on the main's panel "Main’s 3 enabled apps, then 1 from Mailcraft".
    const countOf = (n: number) => `${n} enabled app${n === 1 ? '' : 's'}`;
    const ownOnPanel = enabledApps.length - otherApps.length;
    const othersText = [...new Set(otherApps.map((a) => a.workspace_id))].map((id) => {
      const n = otherApps.filter((a) => a.workspace_id === id).length;
      const name = id === ws.id ? ws.name : others.find((l) => l.id === id)?.name ?? 'a linked workspace';
      return `${n} from ${name}`;
    });
    // The steps name the two buttons; their names follow the fields while typing.
    let menuSteps = discordMd(menu.rest);
    if (groups) {
      const first = `<strong>${escapeHtml(groups[0].title)}</strong> or <strong>${escapeHtml(groups[1].title)}</strong>`;
      menuSteps = raw(menuSteps.value.replace(first, `<strong id="pv-step-main">${escapeHtml(groups[0].title)}</strong> or <strong id="pv-step-linked">${escapeHtml(groups[1].title)}</strong>`));
    }
    const perGroup = (groups ?? []).map((g) => `${g.title} (${g.apps.length} app${g.apps.length === 1 ? '' : 's'})`).join(' and ');
    const optionList = (options: { label: string; value: string; description?: string }[]) => options.length
      ? html`<div class="dp-options">${options.map((o) => html`<div class="dp-option"><strong>${o.label}</strong>${o.description ? html`<span>${o.description}</span>` : ''}${o.value === MORE_APPS_VALUE || o.value.startsWith(`${MORE_APPS_VALUE}:`) ? html`<span>Opens a private, page-by-page list</span>` : ''}</div>`)}</div>`
      : '';
    const appCount = onMain
      ? `${main!.name}’s ${countOf(ownOnPanel)}, then ${othersText.join(' and ')}`
      : othersText.length ? `your ${countOf(ownOnPanel)}, then ${othersText.join(' and ')}` : `your ${countOf(enabledApps.length)}`;
    const body = html`
      ${await toolHeader(web, ctx, 'tickets', 'panel')}
      <div class="panel-grid">
        ${settingsCard}

        <div class="panel-preview">
          ${previewCaption(channelName, messageLink)}
          ${botMessage(bot, html`
            <div class="dp-embed"><h4 id="pv-title">${title}</h4><p><span id="pv-intro">${discordMd(intro)}</span><br><br><span ${shows(false)}>${menuSteps}</span><span ${shows(true)}>${discordMd(buttons.rest)}</span></p></div>
            <div ${shows(false)}>
              ${groups
                ? html`<div class="dp-buttons"><span class="dp-button blurple" id="pv-grp-main">${groups[0].title}</span><span class="dp-button blurple" id="pv-grp-linked">${groups[1].title}</span></div>`
                : html`${selectPreview('Choose an app…')}${optionList(menu.selects[0] ?? [])}`}
            </div>
            <div class="dp-buttons" ${shows(true)}><span class="dp-button blurple">Open a ticket</span><span class="dp-button grey">My tickets</span></div>`, 'Preview of the ticket panel in Discord')}
          <p class="dp-note" ${shows(false)}>${enabledApps.length ? `${groups ? `Each button opens its list privately: ${perGroup}.` : `The menu lists ${appCount}.`}${content.hasTypes ? ' Members pick a ticket type next.' : ''}` : 'No enabled apps yet, so the menu is empty.'}</p>
          <p class="dp-note" ${shows(true)}>${enabledApps.length > 1 ? (groups ? `Open a ticket shows the two buttons privately, then the list: ${perGroup}.` : `Open a ticket shows a private menu of ${appCount}.`) : enabledApps.length ? 'Open a ticket goes straight on: there’s one enabled app.' : 'No enabled apps yet.'}${content.hasTypes ? ' Members pick a ticket type next.' : ''}</p>
          <div ${shows(true)}>
            ${previewCaption(null, null, 'My tickets · ')}
            ${myTicketsPreview(bot, myTicketsPage(examples, 0, words))}
            <p class="dp-note">An example: each member sees only the tickets they sent here, open ones first, and can pick one to see what happened with it.
              Statuses use the Known issues board’s words${can(m, 'known-issues.view') ? html`, which you can change on <a href="${b}/bot/known-issues">Known issues</a>` : ''}.</p>
            ${previewCaption(null, null, 'A ticket’s page · ')}
            ${myTicketPreview(bot, myTicketDetail(examples[0]!, 0, words, { actions: { details: true, files: true, close: true } }), follows)}
            <p class="dp-note">The buttons under it are the ones turned on above. They show while the ticket is open on GitHub.</p>
          </div>
          ${sample ? html`
            ${previewCaption(null, null, types.length ? 'Next steps · ' : 'Form · ')}
            ${types.length ? html`<div class="dp"><p class="dp-modal-title">What kind of ticket is this?</p>
                <p class="dp-text">Choose a type for your <strong>${sample.name}</strong> ticket.<br><br><span id="pv-notice">${discordMd(sampleNotice)}</span></p>
                <div class="dp-options">${types.map((t) => html`<div class="dp-option"><strong>${t.name}</strong>${t.description ? html`<span>${t.description}</span>` : ''}</div>`)}</div></div><div class="mt-8"></div>` : ''}
            ${formPreview({ name: sample.name, repoPrivate: sample.repo_private, notice: sampleNotice }, firstType ? { name: firstType.name } : undefined, formFor(firstType ?? null), { noticeId: 'pv-notice-form' })}
            <p class="dp-note">${firstType ? html`Form for “${firstType.name}”. ${can(m, 'types.edit') ? html`Change the questions on <a href="${b}/tickets/types/${firstType.id}/form">its form page</a>. ` : ''}` : ''}After submitting, the member gets a private confirmation with the ticket number and a link to the issue.</p>` : ''}
        </div>
      </div>
      ${edit ? html`<form method="post" action="${b}/tickets/panel/test" id="test-form" hidden data-confirm-title="Send a test ticket?" data-confirm-body="This creates a real issue on GitHub, labelled as a test. You can close it afterwards." data-confirm-label="Send test">${csrfField(ctx.csrf)}</form>` : ''}
      ${edit && panel ? html`<form method="post" action="${b}/tickets/panel/remove" id="remove-form" hidden data-confirm-title="Remove the panel from #${channelName ?? 'the channel'}?" data-confirm-body="Members can’t open new tickets until you post it again. Existing tickets are kept." data-confirm-label="Remove panel" data-confirm-danger>${csrfField(ctx.csrf)}</form>` : ''}`;
    return web.render(reply, ctx, 'Panel · Discord tickets', 'tickets', body);
  });

  /** Saves the channel and text (fields left out stay unchanged), then publishes when asked to. */
  app.post('/w/:wid/tickets/panel', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'panel.edit' });
    if (!ctx) return reply;
    const back = `${ctx.base}/tickets/panel`;
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const wid = ctx.workspace.id;
    const ws = ctx.workspace;
    try {
      // Checked before anything is saved: the details comment has to keep {details}.
      const current = memberActions(ws);
      const nextActions = body.member_actions_sent !== undefined
        ? memberActionsToStore({
            details: body.member_details === '1', files: body.member_files === '1', close: body.member_close === '1',
            text: Object.fromEntries(MEMBER_TEXT_KEYS.map((k) => [k, body[`member_text_${k}`]]).filter(([, v]) => v !== undefined)),
          }, current)
        : null;
      // A linked workspace: on its main's panel, or a panel of its own.
      const main = await mainOf(deps.db, ws);
      let moved: 'main' | 'own' | null = null;
      let removedOwn = false;
      if (main && body.panel_home_sent !== undefined && (body.panel_home === 'main' || body.panel_home === 'own') && (body.panel_home === 'main') !== ws.on_main_panel) {
        moved = body.panel_home;
        await setOnMainPanel(deps.db, wid, moved === 'main');
        // Its own panel comes down: its apps are on the main's now.
        if (moved === 'main' && (await getPanel(deps.db, wid))) {
          await unpublishPanel(deps, wid);
          removedOwn = true;
        }
      }
      let textChanged = false;
      if (body.panel_title !== undefined || body.panel_intro !== undefined) {
        const text = {
          panelTitle: body.panel_title !== undefined ? cleanText(body.panel_title, LIMITS.panel_title, DEFAULT_PANEL_TITLE) : ws.panel_title,
          // Either default stays the default, so it follows the menu or the buttons.
          panelIntro: body.panel_intro !== undefined ? cleanText(body.panel_intro, LIMITS.panel_intro, [DEFAULT_PANEL_INTRO, DEFAULT_PANEL_INTRO_GROUPS, DEFAULT_PANEL_INTRO_BUTTONS]) : ws.panel_intro,
        };
        textChanged = text.panelTitle !== ws.panel_title || text.panelIntro !== ws.panel_intro;
        await updatePanelText(deps.db, wid, text);
      }
      // My tickets changes the panel itself (buttons instead of the menu), so it's published like the text.
      if (body.my_tickets_sent !== undefined && (body.my_tickets === '1') !== ws.my_tickets) {
        await setMyTickets(deps.db, wid, body.my_tickets === '1');
        textChanged = true;
      }
      // The group buttons' names (a main with linked workspaces on its panel).
      let namesChanged = false;
      if (!ws.parent_id && (body.group_main !== undefined || body.group_linked !== undefined)) {
        const content = await panelContent(deps, ws);
        const linked = content.family.slice(1);
        const withApps = linked.filter((l) => content.apps.some((a) => a.enabled && a.workspace_id === l.id));
        const next = {
          main: body.group_main !== undefined ? cleanGroupTitle(body.group_main, ws.name) : ws.panel_section_title?.trim() || null,
          linked: body.group_linked !== undefined ? cleanGroupTitle(body.group_linked, linkedGroupTitle({ panel_linked_title: null }, withApps.length ? withApps : linked)) : ws.panel_linked_title?.trim() || null,
        };
        namesChanged = next.main !== (ws.panel_section_title?.trim() || null) || next.linked !== (ws.panel_linked_title?.trim() || null);
        if (namesChanged) await setGroupTitles(deps.db, wid, next);
      }
      // They're on the panel message, or in the private Open a ticket message (right away) while My tickets is on.
      const namesLive = namesChanged && ws.my_tickets;
      if (namesChanged && !namesLive) textChanged = true;
      // The notice isn't part of the panel message: it's used from the next ticket on.
      let noticeChanged = false;
      if (body.notice_public !== undefined || body.notice_private !== undefined) {
        const notices = {
          public: body.notice_public !== undefined ? cleanText(body.notice_public, LIMITS.notice, DEFAULT_NOTICE.public) : ws.notice_public,
          private: body.notice_private !== undefined ? cleanText(body.notice_private, LIMITS.notice, DEFAULT_NOTICE.private) : ws.notice_private,
        };
        noticeChanged = notices.public !== ws.notice_public || notices.private !== ws.notice_private;
        if (noticeChanged) await updateNotices(deps.db, wid, notices);
      }
      // Like the notice, what members can do on their tickets is live right away.
      let actionsChanged = false;
      if (nextActions) {
        actionsChanged = JSON.stringify(nextActions) !== JSON.stringify(memberActionsToStore(current, current));
        if (actionsChanged) await setMemberActions(deps.db, wid, nextActions);
      }
      if (body.channel_id) {
        const conn = await getDiscordConnection(deps.db, wid);
        if (!deps.discord || !conn) throw new UserFacingError('Connect Discord first.');
        if (body.channel_id !== conn.tickets_channel_id) {
          const access = await inspectGuild(deps.discord, conn.guild_id);
          if (!access.ok) throw new UserFacingError(access.message);
          // Allowlist: the channel must belong to the connected server and be usable by the bot.
          const channel = access.channels.find((c) => c.id === body.channel_id);
          if (!channel) throw new UserFacingError('Choose one of the listed channels.');
          if (channel.missing.length) throw new UserFacingError(`The bot is missing permissions in #${channel.name}: ${channel.missing.join(', ')}.`);
          await setTicketsChannel(deps.db, wid, channel);
        }
      }
      if (moved && main) {
        // The main's menu is built when Open a ticket is pressed; a menu in the panel message needs publishing.
        const live = main.my_tickets;
        setFlash(reply, 'success', moved === 'main'
          ? `${ws.name}’s apps are on ${main.name}’s panel now.${removedOwn ? ' Its own panel was removed from Discord.' : ''} ${live ? `They’re in ${main.name}’s Open a ticket menu already.` : `Publish ${main.name}’s panel to add them to its menu.`}`
          : `${ws.name} has its own panel now. Choose its channel and publish it. ${live ? `Its apps left ${main.name}’s Open a ticket menu.` : `Publish ${main.name}’s panel to take its apps off that menu.`}`);
      } else if (body.intent === 'publish') {
        const result = await publishPanel(deps, wid, ctx.user.id);
        const conn = await getDiscordConnection(deps.db, wid);
        const where = conn?.tickets_channel_name ? ` in #${conn.tickets_channel_name}` : '';
        setFlash(reply, 'success', {
          created: `Panel posted${where}`,
          updated: `Panel updated${where}`,
          recreated: `The old panel was deleted, so a new one was posted${where}`,
          moved: `Panel moved${where}`,
        }[result]);
      } else if (!textChanged && namesLive && !noticeChanged && !actionsChanged) {
        setFlash(reply, 'success', 'Saved. Members see the new names when they press Open a ticket.');
      } else if (!textChanged && (noticeChanged || actionsChanged)) {
        setFlash(reply, 'success', !actionsChanged
          ? 'Notice saved. Members see it the next time they open a ticket.'
          : !noticeChanged
            ? 'Saved. Members see it the next time they open one of their tickets.'
            : 'Changes saved. They’re live in Discord now.');
      } else {
        setFlash(reply, 'success', noticeChanged || actionsChanged
          ? `Changes saved. ${noticeChanged && actionsChanged ? 'The notice and the ticket buttons are' : noticeChanged ? 'The notice is' : 'The ticket buttons are'} live now; publish the panel to show the rest.`
          : 'Changes saved. Publish the panel to show them in Discord.');
      }
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(back);
  });

  app.post('/w/:wid/tickets/panel/remove', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'panel.edit' });
    if (!ctx) return reply;
    await unpublishPanel(deps, ctx.workspace.id);
    setFlash(reply, 'success', 'Panel removed from Discord');
    return reply.redirect(`${ctx.base}/tickets/panel`);
  });

  /** Files a real test ticket, attributed to whoever sends it. */
  app.post('/w/:wid/tickets/panel/test', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'panel.edit' });
    if (!ctx) return reply;
    const target = await getApp(deps.db, ctx.workspace.id, String((req.body as { app_id?: string }).app_id ?? ''));
    const gh = await getGitHubConnection(deps.db, ctx.workspace.id);
    if (!target || !gh || gh.status !== 'active' || !deps.github) {
      setFlash(reply, 'error', !target ? 'Choose an app.' : 'Connect GitHub first.');
      return reply.redirect(`${ctx.base}/tickets/panel`);
    }
    const conn = await getDiscordConnection(deps.db, ctx.workspace.id);
    const typeId = String((req.body as { type_id?: string }).type_id ?? '');
    const testType = typeId ? await getTicketType(deps.db, ctx.workspace.id, typeId) : null;
    const result = await acceptSubmission(deps, {
      workspace: ctx.workspace,
      app: target,
      installationId: gh.installation_id,
      source: 'admin_test',
      interactionId: null,
      interactionToken: null,
      guildId: conn?.guild_id ?? null,
      guildName: conn?.guild_name ?? null,
      channelId: null,
      reporter: { id: ctx.user.discord_user_id, displayName: ctx.user.display_name ?? ctx.user.username, username: ctx.user.username },
      ticketType: testType ? { name: testType.name, label: testType.label, titlePrefix: testType.title_prefix || testType.name } : null,
      title: 'Ticket Relay connection test',
      description: `This test ticket was sent by ${ctx.user.display_name ?? ctx.user.username} from the Ticket Relay admin interface to confirm that tickets for “${target.name}” reach this repository. You can close it.`,
    });
    if (result.kind !== 'accepted') throw new Error('unexpected test submission result');
    await web.processor.processNow(result.submission.id);
    setFlash(reply, 'info', 'Test ticket sent. Here’s how it went.');
    return reply.redirect(`${ctx.base}/tickets/${result.submission.id}`);
  });
}
