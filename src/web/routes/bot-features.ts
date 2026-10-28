/**
 * Bot features › Known-issues board: under a header with its switch and publishing, a
 * card with where the board is and what needs a look, then the issues on it, just below it and
 * hidden, and its settings, each a closed row that opens to change it, beside a preview of the
 * message.
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
import { UserFacingError, type DiscordConnectionRow } from '../../domain/types.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { PERIODS, periodOf } from '../../repo-status/reports.js';
import { botIdentity, botMessage, discordMd, previewCaption, type BotIdentity } from '../discord-preview.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { csrfField, icon, linkBtn, menu, pageHeader, pill, plural, postBtn, selectWrap, setting, submitBtn, switchInput, tag, timeAgo, type IconName, type Tone } from '../ui.js';
import { checklist, textField } from './panel.js';
import { backTo, featureHeader } from './bot.js';
import { viewOnlyFooter } from './triage.js';

type Check = { key?: 'channel' | 'button' | 'private'; status: 'ok' | 'warning' | 'error'; title: string; detail?: string; fix?: { label: string; href: string } };
type Content = SafeHtml | string;

/** The parts of the settings, each saved from its own row (a form with every field saves them all). */
const SECTIONS = ['power', 'channel', 'content', 'message', 'status', 'button'] as const;
type Section = (typeof SECTIONS)[number];

const STATUS_TONES: Record<IssueStatus, Tone> = { open: 'neutral', working: 'warn', coming: 'ok', released: 'ok', fixed: 'ok' };

/** The Edit (or Details) button of a closed row; the whole row opens it, then it says Close. */
function openBtn(edit: boolean): SafeHtml {
  return html`<span class="btn sm cl-open" aria-hidden="true"><span class="o">${edit ? 'Edit' : 'Details'}</span><span class="c">Close</span></span>`;
}

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

  /** Where the board is now, in a line. */
  function stateLine(s: KnownIssuesSettings, state: BoardState, edit: boolean): SafeHtml {
    const channel = `#${s.channelName ?? ''}`;
    if (!s.enabled) {
      if (state.state === 'published') return html`Off: the board is still in Discord, but isn’t kept up to date.`;
      return s.channelId ? html`Off. Turn it on, then publish it in ${channel}.` : html`Off. Choose its channel in Settings below, then turn it on.`;
    }
    if (state.state === 'published') {
      if (state.channelChanged) return html`It’s still in the old channel, not ${channel}.${edit ? ' Move it to post it there.' : ''}`;
      return html`In ${channel} · changed ${timeAgo(state.changedAt)}${state.checkedAt ? ` · checked ${timeAgo(state.checkedAt)}` : ''}${state.error ? html` <span title="${state.error}">${icon('triangle-alert', 14, 'warn')}</span>` : ''}`;
    }
    if (state.state === 'missing') return html`Someone deleted the board message in Discord.${edit ? ' Publish it again.' : ''}`;
    return html`On. Publish it to post it in ${channel}.`;
  }

  /** The header's controls (after its switch): publishing, and the board's menu. */
  function boardActions(ctx: WorkspaceRequestContext, s: KnownIssuesSettings, state: BoardState): SafeHtml[] {
    const b = base(ctx);
    const published = state.state === 'published';
    const publishLabel = published ? (state.channelChanged ? 'Move board' : 'Update now') : state.state === 'missing' ? 'Publish again' : 'Publish board';
    return [
      s.enabled ? html`<form method="post" action="${b}/publish" class="inline-form">${csrfField(ctx.csrf)}${submitBtn(publishLabel, { variant: published && !state.channelChanged ? undefined : 'primary', icon: published ? 'refresh-cw' : 'send', loading: 'Posting…' })}</form>` : html``,
      menu([
        published && state.link ? { href: state.link, label: 'View in Discord', icon: 'arrow-up-right' as const, external: true } : null,
        state.state !== 'not_published' ? { post: `${b}/remove`, label: 'Remove from Discord', icon: 'trash-2' as const, danger: true, confirm: { title: 'Remove the board from Discord?', body: 'The message is deleted. Your settings, pins and notes are kept, so you can post it again.', label: 'Remove board', danger: true } } : null,
      ], { csrf: ctx.csrf, label: 'More for the board' }),
    ];
  }

  /** Where the board is, how many issues it has, and what needs a look. */
  function statusCard(s: KnownIssuesSettings, state: BoardState, board: Board, checks: Check[], edit: boolean): SafeHtml {
    const problems = checks.filter((c) => c.status !== 'ok');
    const live = s.enabled && state.state === 'published';
    const stat = (n: number, label: string, href: string) => html`<a class="chip-stat" href="${href}"><b>${String(n)}</b> ${label}</a>`;
    return html`<section class="card ki-hero" aria-label="The board now">
      <div class="ki-now">
        <div class="ki-state">${stateLine(s, state, edit)}</div>
        <div class="ki-stats">
          ${stat(board.shown.length, live ? 'on the board' : 'would be on it', '#on')}
          ${board.below.length ? stat(board.below.length, 'also reported', '#below') : ''}
          ${board.hidden.length ? stat(board.hidden.length, 'hidden', '#hidden') : ''}
        </div>
      </div>
      ${problems.length ? checklist(problems) : ''}
    </section>`;
  }

  /** An issue as a closed row: what members see, its reports and status; opened, its title and note. */
  function issueRow(ctx: WorkspaceRequestContext, s: KnownIssuesSettings, i: BoardIssue, edit: boolean, where: 'shown' | 'below' | 'hidden'): SafeHtml {
    const b = base(ctx);
    const id = `i-${i.repoId}-${i.number}`;
    const act = (action: string, label: string, name: IconName) => postBtn(`${b}/issue`, label, ctx.csrf, { size: 'sm', icon: name, fields: { repo: String(i.repoId), number: String(i.number), action } });
    const fields = html`<div class="fields-2">
        ${textField({ id: `t-${id}`, name: 'title', label: 'Shown as', value: i.title !== i.githubTitle ? i.title : '', max: TEXT_LIMITS.issueTitle, placeholder: i.githubTitle, hint: 'Empty: the title on GitHub. Say it the way members would.' })}
        ${textField({ id: `n-${id}`, name: 'note', label: 'Note under it', value: i.note ?? '', max: TEXT_LIMITS.note, rows: 2, placeholder: 'For example: until it’s fixed, export as PNG instead.', hint: 'A workaround, or what to do meanwhile.' })}
      </div>`;
    return html`<details class="ki-row" id="${id}" data-flash>
      <summary class="ki-sum">
        <span class="cl-chev" aria-hidden="true">${icon('chevron-right', 14)}</span>
        <span class="ki-main">
          <span class="ki-meta"><span>${i.appName}</span><span class="mono">#${String(i.number)}</span>${i.pinned ? tag('Pinned', { icon: 'star' }) : ''}${i.private ? tag('Private', { title: 'Shown without a link: its repository is private' }) : ''}</span>
          <span class="ki-title">${i.title}</span>
          ${i.note ? html`<span class="ki-note">↳ ${i.note}</span>` : ''}
        </span>
        <span class="ki-side">
          <span class="ki-status ${STATUS_TONES[i.status]}">${statusLine(s, i)}</span>
          <span class="ki-reports"><b>${String(i.reports)}</b> ${i.reports === 1 ? 'report' : 'reports'}</span>
          ${openBtn(edit)}
        </span>
      </summary>
      <div class="ki-body">
        <div class="cl-tools">
          <span class="small muted">On GitHub: <a href="${i.githubUrl}" target="_blank" rel="noopener noreferrer">${i.githubTitle}</a>${i.pull ? html` · <a href="${i.pull.url}" target="_blank" rel="noopener noreferrer">PR #${String(i.pull.number)}</a>` : ''}</span>
          ${edit ? html`<div class="row">${where === 'hidden'
            ? act('unhide', 'Show again', 'eye')
            : html`${i.pinned ? act('unpin', 'Unpin', 'star') : act('pin', where === 'below' ? 'Pin to the board' : 'Pin to the top', 'star')}${act('hide', 'Hide', 'eye-off')}`}</div>` : ''}
        </div>
        ${edit
          ? html`<form method="post" action="${b}/issue/${String(i.repoId)}/${String(i.number)}" data-dirty>${csrfField(ctx.csrf)}
              <div class="section">${fields}</div>
              <div class="card-f"><span></span><div class="end"><button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>${submitBtn('Save', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}</div></div>
            </form>`
          : html`<fieldset class="plain view-only" disabled><div class="section">${fields}</div></fieldset>`}
      </div>
    </details>`;
  }

  /** A setting as a closed row: its name and what it's set to; opened, its own form. */
  function settingRow(id: string, name: IconName, title: string, gist: Content, edit: boolean, body: SafeHtml): SafeHtml {
    return html`<details class="ki-row ki-set" id="s-${id}" data-flash>
      <summary class="ki-sum">
        <span class="ki-ico" aria-hidden="true">${icon(name, 14)}</span>
        <span class="ki-main"><span class="ki-title">${title}</span><span class="ki-gist">${gist}</span></span>
        <span class="ki-side">${openBtn(edit)}</span>
      </summary>
      <div class="ki-body">${body}</div>
    </details>`;
  }

  async function healthChecks(ctx: WorkspaceRequestContext, s: KnownIssuesSettings, guild: GuildAccess | null, board: Board, conn: DiscordConnectionRow | null): Promise<Check[]> {
    const checks: Check[] = [];
    if (!conn) checks.push({ key: 'channel', status: 'error', title: 'Connect a Discord server first', fix: can(ctx.membership, 'manage') ? { label: 'Connect Discord', href: `${ctx.base}/setup/discord` } : undefined });
    else if (guild && !guild.ok) checks.push({ key: 'channel', status: 'error', title: guild.message });
    else if (guild?.ok) {
      const c = s.channelId ? guild.channels.find((x) => x.id === s.channelId) : null;
      if (!s.channelId) checks.push({ key: 'channel', status: s.enabled ? 'error' : 'warning', title: 'No channel chosen yet', fix: can(ctx.membership, 'known-issues.edit') ? { label: 'Choose one', href: '#s-channel' } : undefined });
      else if (!c) checks.push({ key: 'channel', status: 'error', title: 'The chosen channel no longer exists or is hidden from the bot' });
      else if (c.missing.length) checks.push({ key: 'channel', status: 'error', title: `The bot is missing permissions in #${c.name}`, detail: `Missing: ${c.missing.join(', ')}` });
      else checks.push({ key: 'channel', status: 'ok', title: `The bot can post in #${c.name}` });
    }
    if (s.reportButton) checks.push(reportUrl(conn) ? { key: 'button', status: 'ok', title: `“${s.reportButtonLabel?.trim() || TEXT_DEFAULTS.reportButton}” opens #${conn?.tickets_channel_name ?? 'the tickets channel'}` } : { key: 'button', status: 'warning', title: 'There’s no ticket panel channel for the button to open', detail: 'Choose one under Discord tickets › Panel, or turn the button off.' });
    if (board.privateApps.length) checks.push({ key: 'private', status: 'warning', title: `Left out: ${board.privateApps.join(', ')}`, detail: 'Their repositories are private. Turn on “Private repositories” to show their issues without links.' });
    return checks;
  }

  app.get('/w/:wid/bot/known-issues', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'known-issues.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = base(ctx);
    const edit = can(ctx.membership, 'known-issues.edit');
    const [s, conn, apps, bot] = await Promise.all([getKnownIssuesSettings(deps.db, wid), getDiscordConnection(deps.db, wid), listApps(deps.db, wid), botIdentity(deps)]);
    const [board, state, guild] = await Promise.all([computeBoard(deps, wid, s), checkBoard(deps, wid, conn), conn && deps.discord ? inspectGuild(deps.discord, conn.guild_id) : null]);
    const checks = await healthChecks(ctx, s, guild, board, conn);
    const updatedAt = state.state === 'published' ? state.changedAt : new Date();
    const over = s.period === 'all' ? 'of all time' : `in the last ${periodOf(s.period).label.toLowerCase()}`;
    const preview = html`<div class="panel-preview">
        ${previewCaption(s.channelName, state.state === 'published' ? state.link : null)}
        ${boardPreview(bot, s, board.shown, reportUrl(conn), updatedAt)}
        <p class="dp-note">${board.shown.length ? `${plural(board.shown.length, 'issue')} on the board.` : 'Nothing on the board right now.'} It’s edited in place when something changes, so the channel doesn’t fill up.</p>
      </div>`;
    const head = (id: string, title: string, n: number | null, desc: Content) => html`<div class="ki-sec" id="${id}"><h2>${title}${n === null ? '' : html`<span class="ki-count">${String(n)}</span>`}</h2><p class="small muted">${desc}</p></div>`;
    const list = (issues: BoardIssue[], where: 'shown' | 'below' | 'hidden') => issues.map((i) => issueRow(ctx, s, i, edit, where));

    // Settings: each row saves only its own part.
    const save = (section: Section, inner: SafeHtml, left: SafeHtml | string = state.state === 'published' ? 'Saving updates the board in Discord.' : '') => edit
      ? html`<form method="post" action="${b}/settings" data-dirty>${csrfField(ctx.csrf)}<input type="hidden" name="section" value="${section}">
          <div class="section">${inner}</div>
          <div class="card-f"><span class="small muted">${left}</span><div class="end"><button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>${submitBtn('Save', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}</div></div>
        </form>`
      : html`<fieldset class="plain view-only" disabled><div class="section">${inner}</div></fieldset><div class="card-f">${viewOnlyFooter('the board')}</div>`;
    const reset = (ids: string) => (edit ? html`<button type="button" class="btn ghost sm" data-reset-fields="${ids}"><span class="lead">${icon('undo-2', 14)}</span><span class="lbl">Reset to default</span></button>` : '');
    const checkLine = (c: Check | undefined) => (c ? html`<span class="ki-check ${c.status}">${icon(c.status === 'ok' ? 'circle-check' : c.status === 'warning' ? 'triangle-alert' : 'circle-x', 12)}${c.title}</span>` : '');
    const num = (name: string, value: number, [min, max]: readonly [number, number], label: string) => html`<input type="number" class="wide" name="${name}" value="${String(value)}" min="${String(min)}" max="${String(max)}" aria-label="${label}">`;
    const sorted = [...apps].sort((x, y) => x.position - y.position);
    const { apps: covered } = boardApps({ ...s, appIds: null, includePrivate: true }, apps);
    const chosenApps = sorted.filter((a) => !s.appIds || s.appIds.includes(a.id));
    const channelControl = guild?.ok
      ? selectWrap(html`<select id="ki-channel" name="channel_id" aria-label="Board channel">
          ${s.channelId ? '' : html`<option value="" selected disabled>Choose a channel…</option>`}
          ${guild.channels.map((c) => html`<option value="${c.id}" ${c.id === s.channelId ? raw('selected') : ''} ${c.missing.length ? raw('disabled') : ''}>#${c.name}${c.missing.length ? ` (bot missing: ${c.missing.join(', ')})` : c.category ? ` · ${c.category}` : ''}</option>`)}
        </select>`)
      : html`<span class="small muted">${conn ? 'Discord can’t be reached right now.' : 'Connect Discord first.'}</span>`;
    const problems = checks.filter((c) => c.status !== 'ok');
    const textIds = 'title_text intro_text empty_text';
    const statusIds = STATUSES.map((k) => `status_${k}`).join(' ');

    const settings = [
      settingRow('channel', 'hash', 'Channel', html`<span class="ki-gist-main">${s.channelName ? `#${s.channelName}` : 'Not chosen yet'}</span>${checkLine(checks.find((c) => c.key === 'channel'))}`, edit, save('channel',
        setting('Channel', 'Where the board is posted. A channel of its own works best, so it stays easy to find.', channelControl, { for: guild?.ok ? 'ki-channel' : undefined, flat: true }))),
      settingRow('content', 'list-filter', 'What goes on it', html`<span>Reports ${over} · ${String(s.minReports)}+ reports · up to ${String(s.maxIssues)} · fixed ones stay ${s.fixedDays ? plural(s.fixedDays, 'day') : 'off'}</span>
          <span class="ki-chips">${chosenApps.map((a) => html`<span class="ki-chip${a.repo_private && !s.includePrivate ? ' off' : ''}" ${a.repo_private && !s.includePrivate ? raw('title="Left out: its repository is private"') : ''}>${a.name}</span>`)}</span>`, edit, save('content', html`
        <p class="small muted ki-lead">Issues are ranked by their Discord tickets (a duplicate counts for its original), as in Repo status › Most reported.</p>
        ${setting('Reports counted over', null, selectWrap(html`<select name="period" aria-label="Reports counted over">${PERIODS.map((p) => html`<option value="${p.id}" ${p.id === s.period ? raw('selected') : ''}>${p.id === 'all' ? 'All time' : `The last ${p.label.toLowerCase()}`}</option>`)}</select>`), { flat: true })}
        ${setting('At least', 'Reports an issue needs to go on (pinned ones always do).', html`<div class="row">${num('min_reports', s.minReports, LIMITS.minReports, 'Reports needed')}<span class="small muted">reports</span></div>`, { flat: true })}
        ${setting('Up to', null, html`<div class="row">${num('max_issues', s.maxIssues, LIMITS.maxIssues, 'Issues shown')}<span class="small muted">issues</span></div>`, { flat: true })}
        ${setting('Fixed issues stay', 'So members see it’s fixed and update. 0 takes them off as soon as they’re closed.', html`<div class="row">${num('fixed_days', s.fixedDays, LIMITS.fixedDays, 'Days fixed issues stay')}<span class="small muted">days</span></div>`, { flat: true })}
        ${setting('Private repositories', 'Show their issues too, without links. Off: left out, so nothing private is posted.', switchInput({ name: 'include_private', checked: s.includePrivate, label: 'Include private repositories', id: 'ki-private' }), { flat: true, switchRow: true })}
        <div class="setting flat top"><div><div class="lbl">Apps</div><div class="desc">All on: apps you add later are included too.</div></div><div class="control"><input type="hidden" name="apps" value="1"><div class="stack gap-8">${sorted.map((a) => html`<label class="row small">${switchInput({ name: 'app_ids', value: a.id, checked: !s.appIds || s.appIds.includes(a.id), label: `Include ${a.name}` })}<span>${a.name}</span>${a.repo_private ? tag('Private') : ''}${covered.some((c) => c.id === a.id) ? '' : html`<span class="small muted">(shares a repository)</span>`}</label>`)}</div></div></div>`)),
      settingRow('message', 'message-square', 'Message', html`<span>“${s.titleText ?? TEXT_DEFAULTS.title}” · ${s.groupByApp ? 'grouped by app' : 'one list'} · ${s.showCounts ? 'with report counts' : 'no report counts'}</span>${(s.introText ?? TEXT_DEFAULTS.intro).trim() ? html`<span class="ki-quote">${(s.introText ?? TEXT_DEFAULTS.intro).trim()}</span>` : ''}`, edit, save('message', html`
        <p class="small muted ki-lead">Discord formatting works: **bold**, - list, [link](https://…). The preview follows as you type.</p>
        <div class="fields">
          ${textField({ id: 'title_text', label: 'Title', value: s.titleText ?? TEXT_DEFAULTS.title, max: TEXT_LIMITS.title, placeholder: TEXT_DEFAULTS.title, defaultValue: TEXT_DEFAULTS.title, preview: 'pv-ki-title' })}
          ${textField({ id: 'intro_text', label: 'Introduction', value: s.introText ?? TEXT_DEFAULTS.intro, max: TEXT_LIMITS.intro, rows: 2, placeholder: 'Nothing above the list', defaultValue: TEXT_DEFAULTS.intro, preview: 'pv-ki-intro', md: true })}
          ${textField({ id: 'empty_text', label: 'When nothing’s on it', value: s.emptyText ?? TEXT_DEFAULTS.empty, max: TEXT_LIMITS.empty, rows: 2, placeholder: TEXT_DEFAULTS.empty, defaultValue: TEXT_DEFAULTS.empty, preview: board.shown.length ? undefined : 'pv-ki-empty', md: true })}
        </div>
        ${setting('Group by app', 'Each app’s issues under its name. Off: one list, the app before each issue.', switchInput({ name: 'group_by_app', checked: s.groupByApp, label: 'Group by app', id: 'ki-group' }), { flat: true, switchRow: true })}
        ${setting('Report counts', 'Show how many reports each issue has.', switchInput({ name: 'show_counts', checked: s.showCounts, label: 'Show report counts', id: 'ki-counts' }), { flat: true, switchRow: true })}`, reset(textIds))),
      settingRow('status', 'tag', 'Status wording', html`<span class="ki-chips">${STATUSES.map((k) => html`<span class="ki-chip" title="${STATUS_NAMES[k]}">${s.statusText[k] ?? STATUS_DEFAULTS[k]}</span>`)}</span>`, edit, save('status', html`
        <p class="small muted ki-lead">What each issue says, worked out from its pull requests and your releases. {version} is the release with the fix.</p>
        <div class="fields">${STATUSES.map((k) => textField({ id: `status_${k}`, label: STATUS_NAMES[k], value: s.statusText[k] ?? STATUS_DEFAULTS[k], max: TEXT_LIMITS.status, placeholder: STATUS_DEFAULTS[k], defaultValue: STATUS_DEFAULTS[k] }))}</div>`, reset(statusIds))),
      settingRow('button', 'external-link', '“Report a problem” button', s.reportButton ? html`<span>On</span>${checkLine(checks.find((c) => c.key === 'button'))}` : 'Off: no button under the board', edit, save('button', html`
        ${setting('Show the button', html`Under the board. It opens the ticket panel’s channel${conn?.tickets_channel_name ? ` (#${conn.tickets_channel_name})` : ''}.`, switchInput({ name: 'report_button', checked: s.reportButton, label: 'Report a problem button', id: 'ki-report' }), { flat: true, switchRow: true })}
        <div class="fields ann-notes-label">${textField({ id: 'report_button_label', label: 'Its label', value: s.reportButtonLabel ?? TEXT_DEFAULTS.reportButton, max: TEXT_LIMITS.reportButton, placeholder: TEXT_DEFAULTS.reportButton, defaultValue: TEXT_DEFAULTS.reportButton, preview: 'pv-ki-button' })}</div>`)),
      settingRow('checks', 'activity', 'Checks', problems.length ? html`<span class="ki-check ${problems.some((c) => c.status === 'error') ? 'error' : 'warning'}">${icon('triangle-alert', 12)}${plural(problems.length, 'thing')} to look at</span>` : html`<span class="ki-check ok">${icon('circle-check', 12)}All good</span>`, false, html`
        <div class="section">${checklist(checks.length ? checks : [{ status: 'ok', title: 'Nothing to check yet' }])}</div>
        <div class="card-f"><span class="small muted">Checked live against Discord when this page loads.</span><div class="end">${linkBtn(`${b}?checked=1#s-checks`, 'Check again', { size: 'sm', icon: 'refresh-cw' })}</div></div>`),
    ];

    const body = html`
      ${await featureHeader(web, ctx, 'known-issues', 'known-issues', { actions: edit ? boardActions(ctx, s, state) : [], description: 'One message in Discord with the problems members report most and where each fix is, so they check it before opening a ticket. The bot looks every 10 minutes and edits it when something changes.' })}
      <div class="panel-grid">
        <div class="ki-page">
          ${statusCard(s, state, board, checks, edit)}
          ${head('on', s.enabled && state.state === 'published' ? 'On the board' : 'Would be on the board', board.shown.length, `Ranked by Discord reports ${over}: ${s.minReports}+ reports, up to ${s.maxIssues}. Pinned ones always go on, at the top. Open one to change how it’s shown.`)}
          <div class="ki-list">
            ${board.shown.length ? list(board.shown, 'shown') : html`<p class="ki-empty">Nothing qualifies right now. Members see: “${s.emptyText?.trim() || TEXT_DEFAULTS.empty}”</p>`}
            ${edit ? html`<form method="post" action="${b}/add" class="ki-add">${csrfField(ctx.csrf)}
              <span class="ki-ico" aria-hidden="true">${icon('plus', 14)}</span>
              <label class="sr-only" for="ki-add">GitHub issue link</label><input id="ki-add" type="text" name="issue" placeholder="Pin any issue of your apps: paste its GitHub link" required>
              ${submitBtn('Pin it', { size: 'sm', icon: 'star', loading: 'Adding…' })}
            </form>` : ''}
          </div>
          ${board.below.length ? html`${head('below', 'Also reported', board.below.length, `Not on the board: fewer than ${s.minReports} reports, or past the ${s.maxIssues} shown. Pin one to put it on.`)}<div class="ki-list">${list(board.below, 'below')}</div>` : ''}
          ${board.hidden.length ? html`${head('hidden', 'Hidden', board.hidden.length, 'Never on the board, whatever their reports.')}<div class="ki-list">${list(board.hidden, 'hidden')}</div>` : ''}
          ${head('settings', 'Settings', null, 'How the board is made. Open one to change it; the preview follows.')}
          <div class="ki-list">${settings}</div>
        </div>
        ${preview}
      </div>`;
    return web.render(reply, ctx, 'Known-issues board · Bot features', 'bot', body, { width: 'full' });
  });

  app.post('/w/:wid/bot/known-issues/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'known-issues.edit' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
    // A row of the page sends only its own part; switches left out of it keep what they were.
    const section = SECTIONS.find((x) => x === str('section')) ?? null;
    const has = (x: Section) => !section || section === x;
    try {
      if (str('section') !== undefined && !section) throw new UserFacingError('Reload the page and try again.');
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
        enabled: has('power') ? body.enabled !== undefined : current.enabled,
        channelId: channel.id,
        channelName: channel.name,
        appIds: str('apps') === '1' ? (picked.length === apps.length ? null : picked) : current.appIds,
        period: periodOf(str('period') ?? current.period).id,
        minReports: Math.min(LIMITS.minReports[1], Math.max(LIMITS.minReports[0], Math.round(Number(str('min_reports') ?? current.minReports)) || current.minReports)),
        maxIssues: Math.min(LIMITS.maxIssues[1], Math.max(LIMITS.maxIssues[0], Math.round(Number(str('max_issues') ?? current.maxIssues)) || current.maxIssues)),
        fixedDays: Math.min(LIMITS.fixedDays[1], Math.max(LIMITS.fixedDays[0], Math.round(Number(str('fixed_days') ?? current.fixedDays)) || 0)),
        includePrivate: has('content') ? body.include_private !== undefined : current.includePrivate,
        groupByApp: has('message') ? body.group_by_app !== undefined : current.groupByApp,
        showCounts: has('message') ? body.show_counts !== undefined : current.showCounts,
        titleText: keep(text('title_text', TEXT_LIMITS.title, TEXT_DEFAULTS.title), current.titleText) || null,
        // An empty introduction is kept as empty (nothing above the list).
        introText: keep(text('intro_text', TEXT_LIMITS.intro, TEXT_DEFAULTS.intro), current.introText),
        emptyText: keep(text('empty_text', TEXT_LIMITS.empty, TEXT_DEFAULTS.empty), current.emptyText) || null,
        statusText,
        reportButton: has('button') ? body.report_button !== undefined : current.reportButton,
        reportButtonLabel: keep(text('report_button_label', TEXT_LIMITS.reportButton, TEXT_DEFAULTS.reportButton), current.reportButtonLabel) || null,
      };
      if (next.enabled && !next.channelId) throw new UserFacingError('Choose the channel for the board, then turn it on.');
      await saveKnownIssuesSettings(deps.db, wid, next);
      await refreshBoardSoon(deps, wid);
      const published = (await checkBoard(deps, wid, null, { live: false })).state === 'published';
      setFlash(reply, 'success', next.enabled === current.enabled ? (section === 'channel' && !next.enabled && next.channelId ? 'Saved. Turn the board on at the top, then publish it.' : 'Saved')
        : next.enabled ? (published ? 'The board is on and kept up to date' : 'The board is on. Publish it to post it in Discord.')
        : published ? 'The board is off. It stays in Discord, but isn’t kept up to date.' : 'The board is off');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    // Back to the row that was saved, open (the switch on Bot features: back there).
    return reply.redirect(backTo(ctx, body, section && section !== 'power' ? `${base(ctx)}#s-${section}` : base(ctx)));
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
    // Back to the issue, wherever it is now (pinned onto the board, hidden).
    return reply.redirect(`${base(ctx)}#i-${repoId}-${number}`);
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
    return reply.redirect(`${base(ctx)}#i-${app.repo_id}-${ref.number}`);
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
        crumbs: [{ href: `${ctx.base}/bot`, label: 'Bot features' }, { href: b, label: 'Known-issues board' }, { label: `#${p.number}` }],
        title: issue?.githubTitle ?? `Issue #${p.number}`,
        description: html`${repo.name} · <a href="${issue?.githubUrl ?? `https://github.com/${repo.repo_owner}/${repo.repo_name}/issues/${p.number}`}" target="_blank" rel="noopener noreferrer" class="mono">${repo.repo_owner}/${repo.repo_name}#${p.number}</a>${issue ? html` · ${plural(issue.reports, 'report')} · ${statusLine(s, issue)}` : ''}`,
      })}
      ${edit
        ? html`<form method="post" action="${b}/issue/${repo.repo_id}/${p.number}" class="card">${csrfField(ctx.csrf)}${fields}
            <div class="card-f"><span></span><div class="end">${linkBtn(b, 'Cancel')}${submitBtn('Save', { variant: 'primary', loading: 'Saving…' })}</div></div></form>`
        : html`<div class="card"><fieldset class="plain view-only" disabled>${fields}</fieldset><div class="card-f">${viewOnlyFooter('the board')}</div></div>`}`;
    return web.render(reply, ctx, `#${p.number} · Known-issues board`, 'bot', body);
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
    return reply.redirect(`${base(ctx)}#i-${repo.repo_id}-${p.number}`);
  });
}

