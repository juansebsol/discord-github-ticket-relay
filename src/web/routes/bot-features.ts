/**
 * Bot features: extra things the bot does in Discord, one tab each. Known issues is the first: the
 * board as it is now (what's on it, what's just below, what's hidden) with pinning, hiding and a
 * title or note per issue, its settings, and a preview of the message.
 */
import type { FastifyInstance } from 'fastify';
import {
  boardApps,
  boardPayload,
  checkBoard,
  computeBoard,
  getKnownIssuesSettings,
  issueOverrides,
  LIMITS,
  publishBoard,
  refreshBoardSoon,
  reportUrl,
  saveKnownIssuesSettings,
  setIssueOverride,
  STATUS_DEFAULTS,
  STATUS_NAMES,
  STATUSES,
  statusLine,
  TEXT_DEFAULTS,
  TEXT_LIMITS,
  unpublishBoard,
  type Board,
  type BoardIssue,
  type BoardState,
  type IssueStatus,
  type KnownIssuesSettings,
} from '../../bot-features/known-issues.js';
import { inspectGuild, type GuildAccess } from '../../domain/discord-checks.js';
import { can } from '../../domain/permissions.js';
import { getDiscordConnection, listApps } from '../../domain/store.js';
import { UserFacingError } from '../../domain/types.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { PERIODS, periodOf } from '../../repo-status/reports.js';
import { botIdentity, botMessage, discordMd, previewCaption, type BotIdentity } from '../discord-preview.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { csrfField, icon, linkBtn, menu, pageHeader, pill, plural, segLinks, selectWrap, setting, submitBtn, switchInput, tag, timeAgo, type Tone } from '../ui.js';
import { checklist, textField } from './panel.js';
import { areaHref, toolHeader, toolHref } from './tool.js';
import { viewOnlyFooter } from './triage.js';

type Check = { status: 'ok' | 'warning' | 'error'; title: string; detail?: string; fix?: { label: string; href: string } };

const STATUS_TONES: Record<IssueStatus, Tone> = { open: 'neutral', working: 'warn', coming: 'ok', released: 'ok', fixed: 'ok' };

/** A GitHub issue link (or owner/repo#123) to the repository and number. */
function parseIssueRef(text: string): { owner: string; name: string; number: number } | null {
  const t = text.trim();
  const m = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/i.exec(t) ?? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(t);
  return m ? { owner: m[1]!, name: m[2]!, number: Number(m[3]) } : null;
}

function boardPreview(bot: BotIdentity, s: KnownIssuesSettings, shown: BoardIssue[], report: string | null, updatedAt: Date): SafeHtml {
  const payload = boardPayload(s, shown, { reportUrl: report, updatedAt });
  const embed = payload.embeds[0]!;
  const intro = s.introText?.trim() ?? TEXT_DEFAULTS.intro;
  const rest = embed.description.slice(intro.length).replace(/^\n\n/, '');
  const button = payload.components[0]?.components[0];
  return botMessage(bot, html`<div class="dp-embed amber"><h4 id="pv-ki-title">${embed.title}</h4>
    <p><span id="pv-ki-intro">${discordMd(intro)}</span>${intro && rest ? html`<br><br>` : ''}${shown.length ? discordMd(rest) : html`<span id="pv-ki-empty">${discordMd(rest)}</span>`}</p>
    <div class="dp-time">Updated · ${updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })} UTC</div></div>
    ${button ? html`<div class="dp-buttons"><span class="dp-button grey" id="pv-ki-button">${button.label}${icon('arrow-up-right', 14)}</span></div>` : ''}`, 'Preview of the known-issues board in Discord');
}

export function registerBotFeatureRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const base = (ctx: WorkspaceRequestContext) => `${ctx.base}/bot/known-issues`;

  app.get('/w/:wid/bot', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'known-issues.view' });
    if (!ctx) return reply;
    return reply.redirect(areaHref(ctx, 'known-issues'));
  });

  function stateStrip(s: KnownIssuesSettings, state: BoardState, edit: boolean): SafeHtml {
    if (!s.enabled) return html`${pill('Off', 'neutral')}<span class="small muted">${state.state === 'published' ? 'The board is in Discord but isn’t kept up to date.' : 'Turn it on in Settings to post the board.'}</span>`;
    if (state.state === 'published') {
      if (state.channelChanged) return html`${pill('Channel changed', 'warn')}<span class="small muted">${edit ? `Update it to move it to #${s.channelName ?? ''}.` : `It’s still in the old channel, not #${s.channelName ?? ''}.`}</span>`;
      return html`${pill('Live', 'ok')}<span class="small muted">in #${s.channelName ?? ''} · last changed ${timeAgo(state.changedAt)}${state.checkedAt ? ` · checked ${timeAgo(state.checkedAt)}` : ''}. Kept up to date every 10 minutes.</span>${state.error ? html`<span class="small" title="${state.error}">${icon('triangle-alert', 14, 'warn')}</span>` : ''}`;
    }
    if (state.state === 'missing') return html`${pill('Deleted in Discord', 'warn')}<span class="small muted">Someone deleted the board message.${edit ? ' Publish it again.' : ''}</span>`;
    return html`${pill('Not published', 'neutral')}<span class="small muted">${s.channelId ? 'Ready to post.' : 'Choose a channel in Settings first.'}</span>`;
  }

  /** A table of issues with what can be done to each. */
  function issueTable(ctx: WorkspaceRequestContext, s: KnownIssuesSettings, list: BoardIssue[], edit: boolean, where: 'shown' | 'below' | 'hidden'): SafeHtml {
    const b = base(ctx);
    const act = (i: BoardIssue, action: string) => ({ post: `${b}/issue`, fields: { repo: String(i.repoId), number: String(i.number), action } });
    return html`<div class="table-wrap"><table class="ki-table">
      <thead><tr><th class="col-main">Issue</th><th class="num">Reports</th><th>${where === 'hidden' ? 'Would show' : 'Shows'}</th>${edit ? html`<th class="actions"><span class="sr-only">Actions</span></th>` : ''}</tr></thead>
      <tbody>${list.map((i) => html`<tr>
        <td><div class="row ki-meta"><span class="small muted">${i.appName}</span>${i.pinned ? tag('Pinned', { icon: 'star' }) : ''}${i.private ? tag('Private', { title: 'Shown without a link: its repository is private' }) : ''}</div>
          <a class="cell-title" href="${i.githubUrl}" target="_blank" rel="noopener noreferrer">${i.title}</a> <span class="small muted mono">#${String(i.number)}</span>
          ${i.title !== i.githubTitle ? html`<div class="sub">On GitHub: ${i.githubTitle}</div>` : ''}
          ${i.note ? html`<div class="sub">↳ ${i.note}</div>` : ''}</td>
        <td class="num">${String(i.reports)}</td>
        <td><span class="ki-status ${STATUS_TONES[i.status]}">${statusLine(s, i)}</span>${i.pull ? html`<div class="sub"><a href="${i.pull.url}" target="_blank" rel="noopener noreferrer">PR #${String(i.pull.number)}</a></div>` : ''}</td>
        ${edit ? html`<td class="actions">${menu([
          where === 'hidden' ? { ...act(i, 'unhide'), label: 'Show again', icon: 'eye' as const } : i.pinned ? { ...act(i, 'unpin'), label: 'Unpin', icon: 'star' as const } : { ...act(i, 'pin'), label: where === 'below' ? 'Pin to the board' : 'Pin to the top', icon: 'star' as const },
          { href: `${b}/issue/${i.repoId}/${i.number}`, label: 'Title and note…', icon: 'pencil' as const },
          where === 'hidden' ? null : { ...act(i, 'hide'), label: 'Hide from the board', icon: 'eye-off' as const },
          'sep',
          { href: i.githubUrl, label: 'Open on GitHub', icon: 'arrow-up-right' as const, external: true },
        ], { csrf: ctx.csrf, label: `Actions for #${i.number}` })}</td>` : ''}
      </tr>`)}</tbody></table></div>`;
  }

  async function healthChecks(ctx: WorkspaceRequestContext, s: KnownIssuesSettings, guild: GuildAccess | null, board: Board): Promise<Check[]> {
    const conn = await getDiscordConnection(deps.db, ctx.workspace.id);
    const checks: Check[] = [];
    if (!conn) checks.push({ status: 'error', title: 'Connect a Discord server first', fix: can(ctx.membership, 'manage') ? { label: 'Connect Discord', href: `${ctx.base}/setup/discord` } : undefined });
    else if (guild && !guild.ok) checks.push({ status: 'error', title: guild.message });
    else if (guild?.ok) {
      const c = s.channelId ? guild.channels.find((x) => x.id === s.channelId) : null;
      if (!s.channelId) checks.push({ status: 'error', title: 'No channel chosen' });
      else if (!c) checks.push({ status: 'error', title: 'The chosen channel no longer exists or is hidden from the bot' });
      else if (c.missing.length) checks.push({ status: 'error', title: `The bot is missing permissions in #${c.name}`, detail: `Missing: ${c.missing.join(', ')}` });
      else checks.push({ status: 'ok', title: `The bot can post in #${c.name}` });
    }
    if (s.reportButton) checks.push(reportUrl(conn) ? { status: 'ok', title: `“${s.reportButtonLabel?.trim() || TEXT_DEFAULTS.reportButton}” opens #${conn?.tickets_channel_name ?? 'the tickets channel'}` } : { status: 'warning', title: 'There’s no ticket panel channel for the button to open', detail: 'Choose one under Discord tickets › Panel, or turn the button off.' });
    if (board.privateApps.length) checks.push({ status: 'warning', title: `Left out: ${board.privateApps.join(', ')}`, detail: 'Their repositories are private. Turn on “Private repositories” to show their issues without links.' });
    if (!s.enabled) checks.push({ status: 'warning', title: 'The board is off', detail: 'Turn it on at the top to post it and keep it up to date.' });
    return checks;
  }

  app.get('/w/:wid/bot/known-issues', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'known-issues.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = base(ctx);
    const edit = can(ctx.membership, 'known-issues.edit');
    const view = (req.query as { view?: string }).view === 'settings' ? 'settings' : 'board';
    const [s, conn, apps, bot] = await Promise.all([getKnownIssuesSettings(deps.db, wid), getDiscordConnection(deps.db, wid), listApps(deps.db, wid), botIdentity(deps)]);
    const [board, state] = await Promise.all([computeBoard(deps, wid, s), checkBoard(deps, wid, conn)]);
    const updatedAt = state.state === 'published' ? state.changedAt : new Date();
    const preview = html`<div class="panel-preview">
        ${previewCaption(s.channelName, state.state === 'published' ? state.link : null)}
        ${boardPreview(bot, s, board.shown, reportUrl(conn), updatedAt)}
        <p class="dp-note">${board.shown.length ? `${plural(board.shown.length, 'issue')} on the board.` : 'Nothing on the board right now.'} It’s edited in place when something changes, so the channel doesn’t fill up.</p>
      </div>`;
    const views = segLinks('View', [{ href: b, label: 'Board', current: view === 'board' }, { href: `${b}?view=settings`, label: 'Settings', current: view === 'settings' }]);

    let main: SafeHtml;
    if (view === 'board') {
      const publishLabel = state.state === 'published' ? (state.channelChanged ? 'Move board' : 'Update now') : state.state === 'missing' ? 'Publish again' : 'Publish board';
      const boardCard = html`<div class="card">
          <div class="card-h strip"><div class="row">${stateStrip(s, state, edit)}</div>
            ${edit ? html`<div class="row">${state.state !== 'not_published' ? html`<button type="submit" class="btn ghost danger sm" form="ki-remove"><span class="lead">${icon('trash-2', 14)}</span><span class="lbl">Remove</span></button>` : ''}
              <form method="post" action="${b}/publish" class="inline-form">${csrfField(ctx.csrf)}${submitBtn(publishLabel, { variant: state.state === 'published' ? undefined : 'primary', size: 'sm', icon: state.state === 'published' ? 'refresh-cw' : 'send', loading: 'Posting…', disabled: !s.enabled || !s.channelId, title: !s.enabled ? 'Turn the board on in Settings first' : undefined })}</form></div>` : ''}</div>
          <div class="card-b tight"><p class="small muted">The most-reported problems from Discord tickets ${s.period === 'all' ? 'of all time' : `in the last ${periodOf(s.period).label.toLowerCase()}`}, with ${s.minReports}+ reports, up to ${s.maxIssues}. Fixed ones stay ${s.fixedDays ? `${plural(s.fixedDays, 'day')} after they’re closed` : 'off'}. Pinned issues are always on, at the top.</p></div>
          ${board.shown.length ? html`<div class="card-b flush">${issueTable(ctx, s, board.shown, edit, 'shown')}</div>` : html`<div class="card-b"><p class="small muted">Nothing qualifies right now. Members see: “${s.emptyText?.trim() || TEXT_DEFAULTS.empty}”</p></div>`}
        </div>`;
      main = html`<div class="stack gap-16">
        ${boardCard}
        ${board.below.length ? html`<div class="card"><div class="card-h"><div><h2>Also reported</h2><div class="desc">Not on the board: fewer reports than ${s.minReports}, or past the ${s.maxIssues} shown. Pin one to put it on.</div></div></div><div class="card-b flush">${issueTable(ctx, s, board.below, edit, 'below')}</div></div>` : ''}
        ${board.hidden.length ? html`<div class="card" id="hidden"><div class="card-h"><div><h2>Hidden</h2><div class="desc">Never on the board, whatever their reports.</div></div></div><div class="card-b flush">${issueTable(ctx, s, board.hidden, edit, 'hidden')}</div></div>` : ''}
        ${edit ? html`<form method="post" action="${b}/add" class="card"><div class="card-h"><div><h2>Add an issue</h2><div class="desc">Put any issue of your apps on the board, pinned, even with no Discord reports.</div></div></div>
            ${csrfField(ctx.csrf)}<div class="card-b"><div class="row"><label class="sr-only" for="ki-add">GitHub issue link</label><input id="ki-add" type="text" class="full" name="issue" placeholder="https://github.com/owner/repo/issues/123" required>${submitBtn('Pin it', { icon: 'star', loading: 'Adding…' })}</div></div></form>` : ''}
      </div>`;
    } else {
      const guild = conn && deps.discord ? await inspectGuild(deps.discord, conn.guild_id) : null;
      const checks = await healthChecks(ctx, s, guild, board);
      const sorted = [...apps].sort((x, y) => x.position - y.position);
      const channelControl = guild?.ok
        ? selectWrap(html`<select id="ki-channel" name="channel_id" aria-label="Board channel">
            ${s.channelId ? '' : html`<option value="" selected disabled>Choose a channel…</option>`}
            ${guild.channels.map((c) => html`<option value="${c.id}" ${c.id === s.channelId ? raw('selected') : ''} ${c.missing.length ? raw('disabled') : ''}>#${c.name}${c.missing.length ? ` (bot missing: ${c.missing.join(', ')})` : c.category ? ` · ${c.category}` : ''}</option>`)}
          </select>`)
        : html`<span class="small muted">${conn ? 'Discord can’t be reached right now.' : 'Connect Discord first.'}</span>`;
      const num = (name: string, value: number, [min, max]: readonly [number, number], label: string) => html`<input type="number" class="wide" name="${name}" value="${String(value)}" min="${String(min)}" max="${String(max)}" aria-label="${label}">`;
      const { apps: covered } = boardApps({ ...s, appIds: null, includePrivate: true }, apps);
      const fields = html`
        <div class="card-h strip"><div class="row">${stateStrip(s, state, edit)}</div></div>
        <fieldset class="plain${edit ? '' : ' view-only'}" ${edit ? '' : raw('disabled')}>
        <div class="section">
          ${setting('Known-issues board', 'Post the board and keep it up to date (every 10 minutes, edited only when something changes).', switchInput({ name: 'enabled', checked: s.enabled, label: 'Board turned on', id: 'ki-enabled' }), { flat: true, switchRow: true })}
          ${setting('Channel', 'Where the board is posted. A channel of its own works best, so it stays easy to find.', channelControl, { for: guild?.ok ? 'ki-channel' : undefined, flat: true })}
        </div>
        <div class="section">
          <div class="section-h"><div><h3>What goes on it</h3><div class="desc">Issues ranked by their Discord tickets (a duplicate counts for its original), as in Repo status › Most reported.</div></div></div>
          ${setting('Reports counted over', null, selectWrap(html`<select name="period" aria-label="Reports counted over">${PERIODS.map((p) => html`<option value="${p.id}" ${p.id === s.period ? raw('selected') : ''}>${p.id === 'all' ? 'All time' : `The last ${p.label.toLowerCase()}`}</option>`)}</select>`), { flat: true })}
          ${setting('At least', 'Reports an issue needs to go on (pinned ones always do).', html`<div class="row">${num('min_reports', s.minReports, LIMITS.minReports, 'Reports needed')}<span class="small muted">reports</span></div>`, { flat: true })}
          ${setting('Up to', null, html`<div class="row">${num('max_issues', s.maxIssues, LIMITS.maxIssues, 'Issues shown')}<span class="small muted">issues</span></div>`, { flat: true })}
          ${setting('Fixed issues stay', 'So members see it’s fixed and update. 0 takes them off as soon as they’re closed.', html`<div class="row">${num('fixed_days', s.fixedDays, LIMITS.fixedDays, 'Days fixed issues stay')}<span class="small muted">days</span></div>`, { flat: true })}
          ${setting('Private repositories', 'Show their issues too, without links. Off: left out, so nothing private is posted.', switchInput({ name: 'include_private', checked: s.includePrivate, label: 'Include private repositories', id: 'ki-private' }), { flat: true, switchRow: true })}
          <div class="setting flat top"><div><div class="lbl">Apps</div><div class="desc">All on: apps you add later are included too.</div></div><div class="control"><input type="hidden" name="apps" value="1"><div class="stack gap-8">${sorted.map((a) => html`<label class="row small">${switchInput({ name: 'app_ids', value: a.id, checked: !s.appIds || s.appIds.includes(a.id), label: `Include ${a.name}` })}<span>${a.name}</span>${a.repo_private ? tag('Private') : ''}${covered.some((c) => c.id === a.id) ? '' : html`<span class="small muted">(shares a repository)</span>`}</label>`)}</div></div></div>
        </div>
        <div class="section">
          <div class="section-h"><div><h3>Text</h3><div class="desc">Discord formatting works: **bold**, - list, [link](https://…).</div></div>
            ${edit ? html`<button type="button" class="btn ghost sm" data-reset-fields="title_text intro_text empty_text ${STATUSES.map((k) => `status_${k}`).join(' ')} report_button_label"><span class="lead">${icon('undo-2', 14)}</span><span class="lbl">Reset to default</span></button>` : ''}</div>
          <div class="fields">
            ${textField({ id: 'title_text', label: 'Title', value: s.titleText ?? TEXT_DEFAULTS.title, max: TEXT_LIMITS.title, placeholder: TEXT_DEFAULTS.title, defaultValue: TEXT_DEFAULTS.title, preview: 'pv-ki-title' })}
            ${textField({ id: 'intro_text', label: 'Introduction', value: s.introText ?? TEXT_DEFAULTS.intro, max: TEXT_LIMITS.intro, rows: 2, placeholder: 'Nothing above the list', defaultValue: TEXT_DEFAULTS.intro, preview: 'pv-ki-intro', md: true })}
            ${textField({ id: 'empty_text', label: 'When nothing’s on it', value: s.emptyText ?? TEXT_DEFAULTS.empty, max: TEXT_LIMITS.empty, rows: 2, placeholder: TEXT_DEFAULTS.empty, defaultValue: TEXT_DEFAULTS.empty, preview: board.shown.length ? undefined : 'pv-ki-empty', md: true })}
          </div>
          ${setting('Group by app', 'Each app’s issues under its name. Off: one list, the app before each issue.', switchInput({ name: 'group_by_app', checked: s.groupByApp, label: 'Group by app', id: 'ki-group' }), { flat: true, switchRow: true })}
          ${setting('Report counts', 'Show how many reports each issue has.', switchInput({ name: 'show_counts', checked: s.showCounts, label: 'Show report counts', id: 'ki-counts' }), { flat: true, switchRow: true })}
        </div>
        <div class="section">
          <div class="section-h"><div><h3>Status</h3><div class="desc">What each issue says, from its pull requests and the releases. {version} is the release with the fix.</div></div></div>
          <div class="fields">${STATUSES.map((k) => textField({ id: `status_${k}`, label: STATUS_NAMES[k], value: s.statusText[k] ?? STATUS_DEFAULTS[k], max: TEXT_LIMITS.status, placeholder: STATUS_DEFAULTS[k], defaultValue: STATUS_DEFAULTS[k] }))}</div>
        </div>
        <div class="section">
          ${setting('“Report a problem” button', html`Opens the ticket panel’s channel${conn?.tickets_channel_name ? ` (#${conn.tickets_channel_name})` : ''}.`, switchInput({ name: 'report_button', checked: s.reportButton, label: 'Report a problem button', id: 'ki-report' }), { flat: true, switchRow: true })}
          <div class="fields ann-notes-label">${textField({ id: 'report_button_label', label: 'Its label', value: s.reportButtonLabel ?? TEXT_DEFAULTS.reportButton, max: TEXT_LIMITS.reportButton, placeholder: TEXT_DEFAULTS.reportButton, defaultValue: TEXT_DEFAULTS.reportButton, preview: 'pv-ki-button' })}</div>
        </div>
        <div class="section">
          <div class="section-h"><div><h3>Health</h3><div class="desc">Checked live against Discord when this page loads.</div></div>${linkBtn(`${b}?view=settings`, 'Check again', { variant: 'ghost', size: 'sm', icon: 'refresh-cw' })}</div>
          ${checklist(checks)}
        </div>
        </fieldset>`;
      main = edit
        ? html`<form method="post" action="${b}/settings" class="card" data-dirty>
            ${csrfField(ctx.csrf)}
            ${fields}
            <div class="card-f"><span class="small muted">${state.state === 'published' ? 'Saving updates the board in Discord.' : ''}</span><div class="end">
              <span class="row small muted" data-dirty-show hidden><span class="dot c4" aria-hidden="true"></span>Unsaved changes</span>
              <button type="button" class="btn ghost" data-discard data-dirty-show hidden>Discard</button>
              ${submitBtn('Save changes', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
            </div></div>
          </form>`
        : html`<div class="card">${fields}<div class="card-f">${viewOnlyFooter('the board')}</div></div>`;
    }

    const body = html`
      ${await toolHeader(web, ctx, 'bot', 'known-issues')}
      <div class="ki-views">${views}</div>
      <div class="panel-grid">${main}${preview}</div>
      ${edit && state.state !== 'not_published' ? html`<form method="post" action="${b}/remove" id="ki-remove" hidden data-confirm-title="Remove the board from Discord?" data-confirm-body="The message is deleted. Your settings, pins and notes are kept, so you can post it again." data-confirm-label="Remove board" data-confirm-danger>${csrfField(ctx.csrf)}</form>` : ''}`;
    return web.render(reply, ctx, view === 'settings' ? 'Settings · Known issues' : 'Known issues · Bot features', 'bot', body, { width: 'full' });
  });

  app.post('/w/:wid/bot/known-issues/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'known-issues.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
    try {
      const current = await getKnownIssuesSettings(deps.db, wid);
      let channel = { id: current.channelId, name: current.channelName };
      const chosen = str('channel_id');
      if (chosen && chosen !== current.channelId) {
        const conn = await getDiscordConnection(deps.db, wid);
        if (!conn || !deps.discord) throw new UserFacingError('Connect a Discord server first.');
        const guild = await inspectGuild(deps.discord, conn.guild_id);
        if (!guild.ok) throw new UserFacingError('Couldn’t read the server from Discord. Try again in a moment.');
        // Server-side allowlist: the channel must belong to the connected server.
        const c = guild.channels.find((x) => x.id === chosen);
        if (!c) throw new UserFacingError('Choose one of the listed channels.');
        if (c.missing.length) throw new UserFacingError(`The bot is missing permissions in #${c.name}: ${c.missing.join(', ')}.`);
        channel = { id: c.id, name: c.name };
      }
      const text = (k: string, max: number, def: string) => {
        const v = str(k);
        if (v === undefined) return undefined;
        const t = v.replace(/\r\n/g, '\n').trim().slice(0, max);
        return t === def ? null : t;
      };
      const keep = <T,>(v: T | undefined, old: T) => (v === undefined ? old : v);
      const apps = await listApps(deps.db, wid);
      const picked = body.app_ids === undefined ? [] : (Array.isArray(body.app_ids) ? body.app_ids : [body.app_ids]).map(String).filter((id) => apps.some((a) => a.id === id));
      const statusText = { ...current.statusText };
      for (const k of STATUSES) {
        const v = text(`status_${k}`, TEXT_LIMITS.status, STATUS_DEFAULTS[k]);
        if (v === null || v === '') delete statusText[k];
        else if (v !== undefined) statusText[k] = v;
      }
      const next: KnownIssuesSettings = {
        ...current,
        enabled: body.enabled !== undefined,
        channelId: channel.id,
        channelName: channel.name,
        appIds: str('apps') === '1' ? (picked.length === apps.length ? null : picked) : current.appIds,
        period: periodOf(str('period') ?? current.period).id,
        minReports: Math.min(LIMITS.minReports[1], Math.max(LIMITS.minReports[0], Math.round(Number(str('min_reports') ?? current.minReports)) || current.minReports)),
        maxIssues: Math.min(LIMITS.maxIssues[1], Math.max(LIMITS.maxIssues[0], Math.round(Number(str('max_issues') ?? current.maxIssues)) || current.maxIssues)),
        fixedDays: Math.min(LIMITS.fixedDays[1], Math.max(LIMITS.fixedDays[0], Math.round(Number(str('fixed_days') ?? current.fixedDays)) || 0)),
        includePrivate: body.include_private !== undefined,
        groupByApp: body.group_by_app !== undefined,
        showCounts: body.show_counts !== undefined,
        titleText: keep(text('title_text', TEXT_LIMITS.title, TEXT_DEFAULTS.title), current.titleText) || null,
        // An empty introduction is kept as empty (nothing above the list).
        introText: keep(text('intro_text', TEXT_LIMITS.intro, TEXT_DEFAULTS.intro), current.introText),
        emptyText: keep(text('empty_text', TEXT_LIMITS.empty, TEXT_DEFAULTS.empty), current.emptyText) || null,
        statusText,
        reportButton: body.report_button !== undefined,
        reportButtonLabel: keep(text('report_button_label', TEXT_LIMITS.reportButton, TEXT_DEFAULTS.reportButton), current.reportButtonLabel) || null,
      };
      if (next.enabled && !next.channelId) throw new UserFacingError('Choose the channel for the board, then turn it on.');
      await saveKnownIssuesSettings(deps.db, wid, next);
      await refreshBoardSoon(deps, wid);
      setFlash(reply, 'success', next.enabled && !current.enabled ? 'The board is on. Publish it from the Board view.' : 'Settings saved');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${base(ctx)}?view=settings`);
  });

  app.post('/w/:wid/bot/known-issues/publish', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'known-issues.edit' });
    if (!ctx) return reply;
    try {
      if (!(await getKnownIssuesSettings(deps.db, ctx.workspace.id)).enabled) throw new UserFacingError('Turn the board on in Settings first.');
      const result = await publishBoard(deps, ctx.workspace.id, ctx.user.id, { force: true });
      setFlash(reply, 'success', { created: 'Board posted in Discord', updated: 'Board updated', unchanged: 'Board updated', moved: 'Board moved' }[result]);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(base(ctx));
  });

  app.post('/w/:wid/bot/known-issues/remove', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'known-issues.edit' });
    if (!ctx) return reply;
    await unpublishBoard(deps, ctx.workspace.id);
    setFlash(reply, 'success', 'Board removed from Discord. Settings, pins and notes are kept.');
    return reply.redirect(base(ctx));
  });

  /** The repository of one of the workspace's apps (null when it isn't one). */
  async function appRepo(wid: string, repoId: number) {
    return (await listApps(deps.db, wid)).find((a) => a.repo_id === repoId) ?? null;
  }

  app.post('/w/:wid/bot/known-issues/issue', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'known-issues.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const body = (req.body ?? {}) as { repo?: string; number?: string; action?: string };
    const repoId = Number(body.repo);
    const number = Number(body.number);
    const changes: Record<string, [Partial<{ pinned: boolean; hidden: boolean }>, string]> = {
      pin: [{ pinned: true }, 'Pinned: always on the board, at the top'], unpin: [{ pinned: false }, 'Unpinned'],
      hide: [{ hidden: true }, 'Hidden from the board'], unhide: [{ hidden: false }, 'Shown again when it qualifies'],
    };
    const change = changes[body.action ?? ''];
    if (!change || !Number.isInteger(number) || number < 1 || !(await appRepo(wid, repoId))) {
      setFlash(reply, 'error', 'That issue isn’t in one of your apps’ repositories.');
      return reply.redirect(base(ctx));
    }
    await setIssueOverride(deps.db, wid, repoId, number, change[0]);
    await refreshBoardSoon(deps, wid);
    setFlash(reply, 'success', change[1]);
    return reply.redirect(base(ctx));
  });

  app.post('/w/:wid/bot/known-issues/add', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'known-issues.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const ref = parseIssueRef(String((req.body as { issue?: string }).issue ?? ''));
    const app = ref ? (await listApps(deps.db, wid)).find((a) => a.repo_owner.toLowerCase() === ref.owner.toLowerCase() && a.repo_name.toLowerCase() === ref.name.toLowerCase()) : null;
    if (!ref || !app) {
      setFlash(reply, 'error', ref ? `${ref.owner}/${ref.name} isn’t one of your apps’ repositories.` : 'Paste a GitHub issue link, like https://github.com/owner/repo/issues/123.');
      return reply.redirect(base(ctx));
    }
    await setIssueOverride(deps.db, wid, app.repo_id, ref.number, { pinned: true });
    await refreshBoardSoon(deps, wid);
    setFlash(reply, 'success', `#${ref.number} is pinned to the board`);
    return reply.redirect(base(ctx));
  });

  app.get('/w/:wid/bot/known-issues/issue/:repo/:number', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'known-issues.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const p = req.params as { repo: string; number: string };
    const repo = await appRepo(wid, Number(p.repo));
    if (!repo || !/^\d+$/.test(p.number)) return reply.callNotFound();
    const s = await getKnownIssuesSettings(deps.db, wid);
    const board = await computeBoard(deps, wid, s);
    const issue = [...board.shown, ...board.below, ...board.hidden].find((i) => i.repoId === repo.repo_id && i.number === Number(p.number));
    const current = (await issueOverrides(deps.db, wid)).get(`${repo.repo_id}:${p.number}`);
    const edit = can(ctx.membership, 'known-issues.edit');
    const b = base(ctx);
    const fields = html`<div class="card-b"><div class="fields">
        ${textField({ id: 'title', label: 'Shown as', value: current?.title ?? '', max: TEXT_LIMITS.issueTitle, placeholder: issue?.githubTitle ?? `Issue #${p.number}`, hint: 'Leave empty to use the title on GitHub. Write it the way members would describe the problem.' })}
        ${textField({ id: 'note', label: 'Note under it (optional)', value: current?.note ?? '', max: TEXT_LIMITS.note, rows: 2, placeholder: 'For example: until it’s fixed, export as PNG instead.', hint: 'A workaround, or what to do meanwhile. Discord formatting works.' })}
      </div></div>`;
    const body = html`
      ${pageHeader({
        crumbs: [{ href: toolHref(ctx, 'bot') ?? undefined, label: 'Bot features' }, { href: b, label: 'Known issues' }, { label: `#${p.number}` }],
        title: issue?.githubTitle ?? `Issue #${p.number}`,
        description: html`${repo.name} · <a href="${issue?.githubUrl ?? `https://github.com/${repo.repo_owner}/${repo.repo_name}/issues/${p.number}`}" target="_blank" rel="noopener noreferrer" class="mono">${repo.repo_owner}/${repo.repo_name}#${p.number}</a>${issue ? html` · ${plural(issue.reports, 'report')} · ${statusLine(s, issue)}` : ''}`,
      })}
      ${edit
        ? html`<form method="post" action="${b}/issue/${repo.repo_id}/${p.number}" class="card">${csrfField(ctx.csrf)}${fields}
            <div class="card-f"><span></span><div class="end">${linkBtn(b, 'Cancel')}${submitBtn('Save', { variant: 'primary', loading: 'Saving…' })}</div></div></form>`
        : html`<div class="card"><fieldset class="plain view-only" disabled>${fields}</fieldset><div class="card-f">${viewOnlyFooter('the board')}</div></div>`}`;
    return web.render(reply, ctx, `#${p.number} · Known issues`, 'bot', body);
  });

  app.post('/w/:wid/bot/known-issues/issue/:repo/:number', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'known-issues.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const p = req.params as { repo: string; number: string };
    const repo = await appRepo(wid, Number(p.repo));
    if (!repo || !/^\d+$/.test(p.number)) return reply.callNotFound();
    const body = (req.body ?? {}) as { title?: string; note?: string };
    const clean = (v: string | undefined, max: number) => (v ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;
    await setIssueOverride(deps.db, wid, repo.repo_id, Number(p.number), { title: clean(body.title, TEXT_LIMITS.issueTitle), note: clean(body.note, TEXT_LIMITS.note) });
    await refreshBoardSoon(deps, wid);
    setFlash(reply, 'success', 'Saved');
    return reply.redirect(base(ctx));
  });
}

