import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { inspectGuild } from '../../domain/discord-checks.js';
import { getDiscordConnection, listApps } from '../../domain/store.js';
import { listTicketTypes } from '../../domain/ticket-types.js';
import { UserFacingError } from '../../domain/types.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { classifyAiError, type ModelOption } from '../../triage/ai.js';
import {
  forGitHub,
  githubMode,
  groupKind,
  setGitHubTriageEnabled,
  actionMode,
  actionName,
  actionsOffFor,
  allActionKeys,
  CLOSE_ONLY_COMMENT,
  formatCost,
  NO_CLOSE,
  tokenCost,
  DEFAULT_MODEL,
  FLAG_DEFAULTS,
  FLAGS,
  NOTIFIABLE,
  MODES,
  PRIORITIES,
  anyActionOn,
  getTriageSettings,
  monthlyUsage,
  parseTriageConfig,
  pauseMessage,
  resolveApiKey,
  resumeTriage,
  saveTriageConfig,
  setTriageEnabled,
  type Flag,
  type Mode,
  type TriageConfig,
} from '../../triage/settings.js';
import { keyPill, keyStatus, keySummary } from './claude.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { csrfField, icon, linkBtn, notice, pill, plural, postBtn, segLinks, segRadios, selectWrap, setting, submitBtn, switchInput, tag, typeIcon } from '../ui.js';
import { textField } from './panel.js';
import { ticketsHeader } from './tickets.js';

export const FLAG_COPY: Record<Flag, { title: string; desc: string; placeholders: string }> = {
  support: { title: 'Not a development issue', desc: 'How-to and installation help, account or billing questions: things your community should answer, not code changes. Adds a label and posts your reply.', placeholders: '{app}, {help_channel}' },
  duplicate: { title: 'Duplicates', desc: 'Compares the ticket with every issue in the same repository and links the original. Adds a label and posts your comment.', placeholders: '{duplicate}, {app}, {help_channel}' },
  regression: { title: 'Regression', desc: 'A problem that’s back: the ticket matches an issue that was closed as fixed. Adds a label and links the old issue. Never closes the ticket.', placeholders: '{regression}, {app}, {help_channel}' },
  needsInfo: { title: 'Needs more info', desc: 'Real bug reports or feature requests that are missing details. Claude picks what’s missing (steps to reproduce, expected vs. actual, app version, operating system, screenshot, sample file); your comment lists it.', placeholders: '{missing}, {app}, {help_channel}' },
  multiple: { title: 'Several problems', desc: 'Tickets that report several separate problems at once. Your comment lists them, so the member can file each one on its own.', placeholders: '{parts}, {app}, {help_channel}' },
  related: { title: 'Related issues', desc: 'Links up to three issues that are related but not the same problem, from any of your apps’ repositories. Never closes the ticket.', placeholders: '{related}, {app}' },
  shared: { title: 'Shared across apps', desc: 'Problems that affect several of your apps, such as a shared component or the installer. Adds a label and names the apps. Never closes the ticket.', placeholders: '{shared_apps}, {shared_issue}, {app}' },
  wrongRepo: { title: 'Wrong repository', desc: 'The ticket is about a different app than the one the member picked. Your comment links the repository it belongs in. Issues are never moved or closed.', placeholders: '{right_app}, {right_repo}, {app}' },
  spam: { title: 'Spam', desc: 'Advertising, scams, gibberish and abuse. Adds a label.', placeholders: '{app}, {help_channel}' },
  noAction: { title: 'No action needed', desc: 'Test messages, thank-yous and things sent by mistake. Adds a label.', placeholders: '{app}, {help_channel}' },
};

export const MODE_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'suggest', label: 'Suggest' },
  { value: 'auto', label: 'Automatic' },
];

export const MODE_NAMES: Record<Mode, string> = { off: 'Off', suggest: 'Suggest', auto: 'Automatic' };

export type TriagePage = 'actions' | 'labels' | 'prompt' | 'runs' | 'activity';

/** The Triage tab's sections. */
export function triageNav(ctx: WorkspaceRequestContext, current: TriagePage, actions?: SafeHtml | null): SafeHtml {
  const b = `${ctx.base}/tickets/triage`;
  return html`<div class="subnav">${segLinks('Triage', [
    { href: b, label: 'Actions', current: current === 'actions' },
    { href: `${b}/labels`, label: 'Label groups', current: current === 'labels' },
    { href: `${b}/prompt`, label: 'Prompt', current: current === 'prompt' },
    { href: `${b}/runs`, label: 'Re-run', current: current === 'runs' },
    { href: `${b}/activity`, label: 'Activity', current: current === 'activity' },
  ])}${actions ? html`<div class="row">${actions}</div>` : ''}</div>`;
}

/** One line on what an action does when applied, from its settings. */
function flagSummary(c: TriageConfig, f: Flag): string {
  const x = c[f];
  const comments = Boolean(x.comment.trim()) && (!CLOSE_ONLY_COMMENT.has(f) || x.close);
  return [
    x.label ? `label “${x.label}”` : 'no label',
    comments ? 'comments' : 'no comment',
    !NO_CLOSE.has(f) && x.close ? 'closes the issue' : '',
    NOTIFIABLE.has(f) && x.notifyMember ? 'tells the member' : '',
  ].filter(Boolean).join(' · ');
}

const modelCache = new Map<string, { at: number; models: ModelOption[] }>();

export function registerTriageRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const back = (ctx: WorkspaceRequestContext) => `${ctx.base}/tickets/triage`;

  /** Models for the dropdown, cached for 10 minutes per key. */
  async function models(key: string | null): Promise<{ models: ModelOption[]; error: string | null }> {
    if (!key) return { models: [], error: null };
    const id = createHash('sha256').update(key).digest('hex');
    const hit = modelCache.get(id);
    if (hit && Date.now() - hit.at < 600_000) return { models: hit.models, error: null };
    try {
      const list = await web.triage.ai.listModels(key);
      modelCache.set(id, { at: Date.now(), models: list });
      return { models: list, error: null };
    } catch (err) {
      return { models: [], error: classifyAiError(err).message };
    }
  }

  app.get('/w/:wid/tickets/triage', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    const [settings, apps, types, usage, key, conn] = await Promise.all([
      getTriageSettings(deps.db, wid),
      listApps(deps.db, wid),
      listTicketTypes(deps.db, wid),
      monthlyUsage(deps.db, wid),
      resolveApiKey(deps, wid),
      getDiscordConnection(deps.db, wid),
    ]);
    const guild = deps.discord && conn?.status === 'active' ? await inspectGuild(deps.discord, conn.guild_id) : null;
    const keyState = await keyStatus(web, wid);
    const c = settings.config;
    const { models: available, error: modelError } = await models(key?.key ?? null);
    const cost = tokenCost(c.model, usage.inputTokens, usage.outputTokens);
    const nextMonth = new Date(Date.UTC(usage.since.getUTCFullYear(), usage.since.getUTCMonth() + 1, 1));

    const anyOn = settings.enabled || settings.githubEnabled;
    const status = !anyOn ? pill('Off', 'neutral') : settings.paused ? pill('Paused', 'warn') : pill('On', 'ok');
    const ghOff = !settings.githubEnabled;
    /** An action's two modes: for Discord tickets, and for issues opened on GitHub. */
    const modeControls = (name: string, key: string, title: string) => html`<div class="src-modes${ghOff ? ' gh-off' : ''}">
      <span class="src-l">${icon('message-circle', 14)}Discord tickets</span>${segRadios(`${name}_mode`, MODE_OPTIONS, actionMode(c, key), `${title} for Discord tickets`)}
      <span class="src-l gh">${icon('github', 14)}Opened on GitHub</span><span class="gh">${segRadios(`${name}_gh_mode`, MODE_OPTIONS, githubMode(c, key), `${title} for issues opened on GitHub`)}</span>
    </div>`;
    const keys = allActionKeys(c);
    const onCount = (modeOf: (k: string) => string) => keys.filter((k) => modeOf(k) !== 'off');
    const ticketsOn = onCount((k) => actionMode(c, k));
    const githubOn = onCount((k) => githubMode(c, k));
    const sourceSummary = (on: string[], modeOf: (k: string) => string, enabled: boolean) => {
      const allSuggest = on.length && on.every((k) => modeOf(k) === 'suggest');
      return `${plural(on.length, 'action')} on${allSuggest ? ' (all Suggest)' : ''}${enabled ? '' : ' · switched off'}`;
    };
    const modelOptions = available.length ? available : [{ id: c.model, name: c.model, deprecated: false }];
    if (!modelOptions.some((m) => m.id === c.model)) modelOptions.unshift({ id: c.model, name: `${c.model} (not available to this key)`, deprecated: true });

    const flagSection = (f: Flag) => html`<div class="section">
      <div class="section-h"><div><h3>${FLAG_COPY[f].title}</h3><div class="desc">${FLAG_COPY[f].desc}</div></div>${modeControls(f, f, FLAG_COPY[f].title)}</div>
      <details class="act-more">
        <summary>${icon('chevron-right', 14, 'chev')}<span class="what">Label, comment${NO_CLOSE.has(f) ? '' : ' and closing'}</span><span class="truncate">${flagSummary(c, f)}</span></summary>
        <div class="fields">
          <div class="fields-2">
            <div class="field"><label for="${f}_label">GitHub label</label><input id="${f}_label" type="text" name="${f}_label" value="${c[f].label}" maxlength="50" placeholder="No label">
              <div class="hint">Created on GitHub the first time it’s used. Leave empty to only comment.</div></div>
            <div class="field"><span class="label">When applied</span>
              ${NO_CLOSE.has(f) ? html`<p class="small muted mt-8">Never closes the issue.</p>` : html`<label class="check mt-8"><input type="checkbox" name="${f}_close" value="1" ${c[f].close ? raw('checked') : ''}> Also close the issue (as not planned)</label>`}
              ${NOTIFIABLE.has(f) ? html`<label class="check mt-8"><input type="checkbox" name="${f}_notify" value="1" ${c[f].notifyMember ? raw('checked') : ''}> Also tell the member in Discord (Discord tickets only)</label>` : ''}
              <div class="hint">Applies on Automatic and when someone presses Apply.${NOTIFIABLE.has(f) ? ' Discord can only be updated within 15 minutes of the ticket being filed.' : ''}</div></div>
          </div>
          ${f === 'support' ? html`<div class="field"><label for="help_channel">Help channel</label>
            ${guild?.ok
              ? selectWrap(html`<select id="help_channel" name="help_channel"><option value="">None (says “our Discord server”)</option>${guild.channels.map((ch) => html`<option value="${ch.id}" ${ch.id === c.helpChannel?.id ? raw('selected') : ''}>#${ch.name}${ch.category ? ` · ${ch.category}` : ''}</option>`)}</select>`)
              : html`<p class="small muted">${c.helpChannel ? `#${c.helpChannel.name}. ` : ''}Connect Discord to choose a channel.</p><input type="hidden" name="help_channel" value="${c.helpChannel?.id ?? ''}">`}
            <div class="hint">Used for {help_channel}: a link to the channel on GitHub, and a clickable #channel in Discord.</div></div>` : ''}
          ${textField({
            id: `${f}_comment`,
            label: CLOSE_ONLY_COMMENT.has(f) ? 'Comment when it closes the issue' : 'Comment on the GitHub issue',
            value: c[f].comment,
            max: 1500,
            rows: 3,
            placeholder: 'No comment',
            defaultValue: FLAG_DEFAULTS[f].comment,
            hint: html`Placeholders: <code>${FLAG_COPY[f].placeholders}</code>. Leave empty to post no comment.${NOTIFIABLE.has(f) ? ' The same text is used for the Discord note.' : ''} <button type="button" class="link-btn" data-reset-fields="${f}_comment">Reset to default</button>`,
          })}
        </div>
      </details></div>`;

    const body = html`
      ${await ticketsHeader(web, ctx, 'triage')}
      ${triageNav(ctx, 'actions')}
      ${!key ? notice('warn', 'Triage needs a Claude API key', 'Add the workspace’s key in Settings. It’s shared by every feature that uses Claude.', { action: linkBtn(`${b}/settings#claude`, 'Open Settings', { size: 'sm', trail: 'arrow-right' }) }) : ''}
      ${anyOn && settings.paused
        ? notice('warn', 'Triage is paused', `${pauseMessage(settings.paused.reason, settings.paused.detail, c.model)} Tickets are still being filed normally.`, { action: postBtn(`${b}/tickets/triage/resume`, 'Resume', ctx.csrf, { size: 'sm', icon: 'rotate-ccw' }) })
        : ''}
      ${anyOn && usage.triaged >= c.monthlyLimit
        ? notice('warn', 'Monthly limit reached', `Triage resumes on ${nextMonth.toISOString().slice(0, 10)}, or raise the limit below. Tickets are still being filed normally.`)
        : ''}
      <div class="card">
        <div class="card-h"><div><div class="title"><h2>AI triage</h2>${status}</div><div class="desc">Claude reads each ticket after it’s filed and flags priority, duplicates, spam and more. It runs in its own worker: if it’s off, paused or out of credits, tickets are still filed exactly as before.</div></div></div>
        ${setting('Claude API key', keySummary(keyState, b), keyPill(keyState))}
        ${setting(html`${icon('message-circle', 16, 'muted')} Discord tickets`, key ? html`Tickets members open in Discord. Only tickets filed after you turn it on are triaged; for older ones, use <a href="${b}/tickets/triage/runs">Re-run</a>.` : html`Needs a Claude API key. <a href="${b}/settings#claude">Add one in Settings</a>.`, html`<form method="post" action="${b}/tickets/triage/enabled" data-async class="inline-form">${csrfField(ctx.csrf)}<input type="hidden" name="set" value="1">
          ${switchInput({ name: 'enabled', checked: settings.enabled, label: 'Triage Discord tickets', disabled: !key && !settings.enabled })}<button type="submit" class="btn sm nojs">Save</button></form>`, { switchRow: true })}
        ${setting(html`${icon('github', 16, 'muted')} Issues opened on GitHub`, key ? html`Issues people open directly on GitHub (not pull requests, bots, or tickets from Discord). Only issues opened after you turn it on are triaged; for older ones, use <a href="${b}/tickets/triage/runs">Re-run</a>. Review them in <a href="${b}/tickets/issues/triage">Issues › Triage</a>.` : html`Needs a Claude API key. <a href="${b}/settings#claude">Add one in Settings</a>.`, html`<form method="post" action="${b}/tickets/triage/github-enabled" data-async data-gh-switch class="inline-form">${csrfField(ctx.csrf)}<input type="hidden" name="set" value="1">
          ${switchInput({ name: 'enabled', checked: settings.githubEnabled, label: 'Triage issues opened on GitHub', disabled: !key && !settings.githubEnabled })}<button type="submit" class="btn sm nojs">Save</button></form>`, { switchRow: true })}
        ${setting('This month', 'Re-runs count too.', html`<span class="value">${plural(usage.triaged, 'ticket')} of ${String(c.monthlyLimit)}${cost !== null ? ` · ${formatCost(cost)}` : ''}${usage.inputTokens ? ` · ${(usage.inputTokens + usage.outputTokens).toLocaleString('en-US')} tokens` : ''}</span>`)}
      </div>
      <form method="post" action="${b}/tickets/triage" class="stack" data-dirty>
        ${csrfField(ctx.csrf)}
        <div class="card">
          <div class="card-h"><div><h2>What triage does</h2><div class="desc">Each action has its own setting for Discord tickets and for issues opened on GitHub, and starts Off. <strong>Suggest</strong> shows Claude’s call for someone to apply. <strong>Automatic</strong> applies it on GitHub when Claude is at least ${String(c.threshold)}% sure; less sure calls become suggestions. The label, comment and closing are shared.</div>
            <div class="src-summary"><span>${icon('message-circle', 14)}Discord tickets: ${sourceSummary(ticketsOn, (k) => actionMode(c, k), settings.enabled)}</span><span>${icon('github', 14)}Opened on GitHub: ${sourceSummary(githubOn, (k) => githubMode(c, k), settings.githubEnabled)}</span></div></div>
            <div class="row js-only"><button type="button" class="btn sm" data-copy-modes>Copy Discord settings to GitHub</button><button type="button" class="btn sm" data-set-gh-modes="suggest">Set all GitHub to Suggest</button></div></div>
          <div class="card-b tight" data-gh-off-note ${ghOff ? '' : raw('hidden')}>${notice('info', null, 'Issues opened on GitHub is switched off, so its settings below aren’t used yet. You can set them up first and turn it on above when you’re ready.')}</div>
          <div class="section">
            <div class="section-h"><div><h3>Priority</h3><div class="desc">Adds one of four priority labels. The ticket type isn’t changed; the member picks it.</div></div>${modeControls('priority', 'priority', 'Priority')}</div>
            <details class="act-more">
              <summary>${icon('chevron-right', 14, 'chev')}<span class="what">Labels and what each priority means</span><span class="truncate">${PRIORITIES.map((p) => c.priority.labels[p]).join(', ')}</span></summary>
              <div class="fields">
                <div class="fields-2">${PRIORITIES.map((p) => html`<div class="field"><label for="priority_label_${p}">${p[0]!.toUpperCase() + p.slice(1)} label</label><input id="priority_label_${p}" type="text" name="priority_label_${p}" value="${c.priority.labels[p]}" maxlength="50"></div>`)}</div>
                ${textField({ id: 'priority_guide', label: 'What each priority means (optional)', value: c.priority.guide, max: 1500, rows: 4, placeholder: 'critical: crashes, data loss, security or payments\nhigh: a core feature is broken with no workaround\nmedium: something is wrong but there’s a workaround\nlow: cosmetic issues, small improvements and questions', hint: 'Leave empty for the defaults shown here.' })}
              </div>
            </details>
          </div>
          ${FLAGS.map(flagSection)}
          <div class="section">
            <div class="section-h"><div><h3>Label groups</h3><div class="desc">Claude can also sort tickets with labels you define, such as Type, Area and Platform. It only picks from your options.</div></div>${linkBtn(`${b}/tickets/triage/labels`, c.labelGroups.length ? 'Edit groups' : 'Add groups', { size: 'sm', trail: 'arrow-right' })}</div>
            ${c.labelGroups.map((g) => html`<div class="group-row"><div><div class="cell-title">${icon('tags', 14, 'muted')} ${g.name}</div><div class="sub">${plural(g.options.length, 'option')}</div></div>${modeControls(`group_${g.id}`, groupKind(g.id), g.name)}</div>`)}
          </div>
        </div>
        ${types.length ? html`<div class="card" id="rules">
          <div class="card-h"><div><h2>Rules by ticket type</h2><div class="desc">For Discord tickets: members pick a ticket type when they open a ticket. Choose which actions run for each type. Unticked actions never run for that type, and Claude is told to skip them so it still checks the rest. Issues opened on GitHub have no ticket type; they use their own column of settings above.</div></div></div>
          <input type="hidden" name="rules" value="1">
          <div class="card-b flush"><div class="table-wrap"><table>
            <thead><tr><th class="th-perm"><div class="l">Ticket type</div></th>${keys.map((k) => html`<th class="th-perm center"><div class="l">${actionName(c, k)}</div><div class="d">${MODE_NAMES[actionMode(c, k)]}</div></th>`)}</tr></thead>
            <tbody>${types.map((t) => {
              const off = actionsOffFor(c, t);
              return html`<tr>
                <td><span class="who-cell">${icon(typeIcon(t), 16, 'muted')}<span><span class="cell-title">${t.name}</span>${t.label ? html`<span class="sub mono">${t.label}</span>` : ''}</span>${keys.every((k) => off.has(k)) ? tag('Not triaged') : ''}</span></td>
                ${keys.map((k) => html`<td class="center"><input type="checkbox" class="rule-check" name="rule_${t.id}" value="${k}" ${off.has(k) ? '' : raw('checked')} aria-label="${t.name}: ${actionName(c, k)}"></td>`)}
              </tr>`;
            })}</tbody>
          </table></div></div>
          <div class="card-note">New ticket types start with every action ticked, except Not a dev issue for feature requests and ideas. An action that’s Off above doesn’t run for any type.</div>
        </div>` : ''}
        <div class="card">
          <div class="card-h"><h2>Model, scope and limits</h2></div>
          ${setting('Model', modelError ? `Couldn’t load models: ${modelError}` : key ? 'Models available to your API key. Haiku is the fastest and cheapest.' : 'Add an API key to load the models it can use.', selectWrap(html`<select id="model" name="model" ${available.length ? '' : raw('disabled')}>${modelOptions.map((m) => html`<option value="${m.id}" ${m.id === c.model ? raw('selected') : ''}>${m.name}${m.deprecated && available.length ? ' (deprecated)' : ''}</option>`)}</select>`), { for: 'model' })}
          ${available.length ? '' : html`<input type="hidden" name="model" value="${c.model}">`}
          ${setting('Confidence threshold', 'Automatic actions only happen at or above this confidence.', html`<input type="number" name="threshold" value="${String(c.threshold)}" min="50" max="100" required aria-label="Confidence threshold"><span class="connector">%</span>`)}
          ${setting('Monthly limit', 'Triage stops for the rest of the month after this many tickets. Filing isn’t affected.', html`<input type="number" class="wide" name="monthly_limit" value="${String(c.monthlyLimit)}" min="1" max="100000" required aria-label="Monthly limit"><span class="connector">tickets</span>`)}
          ${setting('Apps', 'Which apps’ tickets are triaged. While all are selected, new apps are included too.', html`<div class="check-list">${apps.map((a) => html`<label class="check"><input type="checkbox" name="app_ids" value="${a.id}" ${!c.appIds || c.appIds.includes(a.id) ? raw('checked') : ''}> ${a.name}</label>`)}</div>`, { stacked: true })}
          ${setting('Prompt', 'What Claude is told about your products, each check and examples.', linkBtn(`${b}/tickets/triage/prompt`, 'Edit the prompt', { size: 'sm', trail: 'arrow-right' }))}
          <div class="card-f">${anyActionOn(c) ? html`<span></span>` : html`<span class="small muted">Every action is off, so triage won’t do anything yet.</span>`}<div class="end">
            <button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>
            ${submitBtn('Save changes', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
          </div></div>
        </div>
      </form>`;
    return web.render(reply, ctx, 'Triage', 'tickets', body);
  });

  app.post('/w/:wid/tickets/triage', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const b = (req.body ?? {}) as Record<string, string | string[] | undefined>;
    const str = (k: string) => (Array.isArray(b[k]) ? String((b[k] as string[])[0]) : String(b[k] ?? '')).trim();
    const list = (k: string) => (b[k] === undefined ? [] : Array.isArray(b[k]) ? (b[k] as string[]) : [b[k] as string]);
    const mode = (k: string): Mode => ((MODES as readonly string[]).includes(str(k)) ? (str(k) as Mode) : 'off');
    try {
      const currentConfig = (await getTriageSettings(deps.db, ctx.workspace.id)).config;
      // A field missing from the form keeps its current value.
      const flagLabel = (f: Flag) => (b[`${f}_label`] === undefined ? currentConfig[f].label : str(`${f}_label`));
      const flagComment = (f: Flag) => (b[`${f}_comment`] === undefined ? currentConfig[f].comment : str(`${f}_comment`).replace(/\r\n/g, '\n').slice(0, 1500));
      const flagClose = (f: Flag) => !NO_CLOSE.has(f) && b[`${f}_close`] !== undefined;
      if (PRIORITIES.some((p) => !str(`priority_label_${p}`) || str(`priority_label_${p}`).length > 50)) throw new UserFacingError('Each priority needs a label of up to 50 characters.');
      if (FLAGS.some((f) => flagLabel(f).length > 50)) throw new UserFacingError('Labels can be up to 50 characters.');
      // Modes for issues opened on GitHub; a field missing from the form keeps its value.
      const ghMode = (name: string, key: string): Mode => (b[`${name}_gh_mode`] === undefined ? githubMode(currentConfig, key) : mode(`${name}_gh_mode`));
      const githubModes: Record<string, Mode> = Object.fromEntries([
        ['priority', ghMode('priority', 'priority')],
        ...FLAGS.map((f) => [f, ghMode(f, f)]),
        ...currentConfig.labelGroups.map((g) => [groupKind(g.id), ghMode(`group_${g.id}`, groupKind(g.id))]),
      ]);
      // An action that's on (for either source) must do something when applied.
      const idle = FLAGS.find((f) => (mode(`${f}_mode`) !== 'off' || githubModes[f] !== 'off') && !flagLabel(f) && !flagClose(f) && !(flagComment(f).trim() && !CLOSE_ONLY_COMMENT.has(f)));
      if (idle) throw new UserFacingError(`${FLAG_COPY[idle].title} is on but wouldn’t change anything: give it a label${CLOSE_ONLY_COMMENT.has(idle) ? ' or let it close the issue' : ', a comment or closing'}.`);
      const model = str('model') || DEFAULT_MODEL;
      if (!/^[a-z0-9][a-z0-9.-]{2,99}$/.test(model)) throw new UserFacingError('Choose a model from the list.');
      const threshold = Number(str('threshold'));
      const monthlyLimit = Number(str('monthly_limit'));
      if (!Number.isInteger(threshold) || threshold < 50 || threshold > 100) throw new UserFacingError('The confidence threshold must be between 50 and 100.');
      if (!Number.isInteger(monthlyLimit) || monthlyLimit < 1 || monthlyLimit > 100_000) throw new UserFacingError('The monthly limit must be between 1 and 100,000 tickets.');
      const [apps, types] = await Promise.all([listApps(deps.db, ctx.workspace.id), listTicketTypes(deps.db, ctx.workspace.id)]);
      const appIds = list('app_ids').filter((id) => apps.some((a) => a.id === id));
      if (apps.length && !appIds.length) throw new UserFacingError('Choose at least one app.');
      // The help channel must belong to the connected server (allowlist). If Discord can't be
      // reached right now, an unchanged choice is kept.
      const current = currentConfig.helpChannel;
      const channelId = str('help_channel');
      let helpChannel: { id: string; name: string } | null = null;
      if (channelId && channelId === current?.id) helpChannel = current;
      else if (channelId) {
        const conn = await getDiscordConnection(deps.db, ctx.workspace.id);
        const guild = deps.discord && conn ? await inspectGuild(deps.discord, conn.guild_id) : null;
        const ch = guild?.ok ? guild.channels.find((x) => x.id === channelId) : undefined;
        if (!ch) throw new UserFacingError('Choose a help channel from the list.');
        helpChannel = { id: ch.id, name: ch.name };
      }
      const config: TriageConfig = parseTriageConfig({
        ...currentConfig,
        model,
        threshold,
        monthlyLimit,
        appIds: appIds.length === apps.length ? null : appIds,
        // The rules table replaces the old "which types are triaged" list.
        typeNames: b.rules === '1' ? null : currentConfig.typeNames,
        typeRules: b.rules === '1'
          ? Object.fromEntries(types.map((t) => {
              const on = new Set(list(`rule_${t.id}`));
              return [t.id, { off: allActionKeys(currentConfig).filter((k) => !on.has(k)) }];
            }))
          : currentConfig.typeRules,
        priority: {
          mode: mode('priority_mode'),
          labels: Object.fromEntries(PRIORITIES.map((p) => [p, str(`priority_label_${p}`)])),
          guide: str('priority_guide').replace(/\r\n/g, '\n').slice(0, 1500),
        },
        ...Object.fromEntries(FLAGS.map((f) => [f, {
          mode: mode(`${f}_mode`),
          label: flagLabel(f),
          close: flagClose(f),
          comment: flagComment(f),
          notifyMember: NOTIFIABLE.has(f) && b[`${f}_notify`] !== undefined,
        }])),
        helpChannel,
        githubModes,
        labelGroups: currentConfig.labelGroups.map((g) => ({ ...g, mode: b[`group_${g.id}_mode`] === undefined ? g.mode : mode(`group_${g.id}_mode`) })),
      });
      await saveTriageConfig(deps.db, ctx.workspace.id, config);
      setFlash(reply, 'success', 'Triage settings saved');
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(back(ctx));
  });

  /** The on/off switch (JSON from the switch, or a plain form without JavaScript). */
  app.post('/w/:wid/tickets/triage/enabled', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const enabled = (req.body as { enabled?: string }).enabled !== undefined;
    const respond = (ok: boolean, message: string) => {
      if (web.wantsJson(req)) return reply.code(ok ? 200 : 400).send(ok ? { ok, message } : { ok, error: message });
      setFlash(reply, ok ? 'success' : 'error', message);
      return reply.redirect(back(ctx));
    };
    if (enabled && !(await resolveApiKey(deps, ctx.workspace.id))) return respond(false, 'Add a Claude API key first.');
    await setTriageEnabled(deps.db, ctx.workspace.id, enabled);
    const config = (await getTriageSettings(deps.db, ctx.workspace.id)).config;
    return respond(true, enabled ? (anyActionOn(config) ? 'Triage is on for new tickets' : 'Triage is on, but every action is off. Turn one on below.') : 'Triage is off. Tickets are filed as usual.');
  });

  /** The switch for issues opened on GitHub (JSON from the switch, or a plain form without JavaScript). */
  app.post('/w/:wid/tickets/triage/github-enabled', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const enabled = (req.body as { enabled?: string }).enabled !== undefined;
    const respond = (ok: boolean, message: string) => {
      if (web.wantsJson(req)) return reply.code(ok ? 200 : 400).send(ok ? { ok, message } : { ok, error: message });
      setFlash(reply, ok ? 'success' : 'error', message);
      return reply.redirect(back(ctx));
    };
    if (enabled && !(await resolveApiKey(deps, ctx.workspace.id))) return respond(false, 'Add a Claude API key first.');
    await setGitHubTriageEnabled(deps.db, ctx.workspace.id, enabled);
    const config = (await getTriageSettings(deps.db, ctx.workspace.id)).config;
    return respond(true, enabled
      ? (anyActionOn(forGitHub(config)) ? 'Triage is on for new issues opened on GitHub' : 'Triage is on for issues opened on GitHub, but every action is Off for them. Set them in the “Opened on GitHub” rows below.')
      : 'Triage of issues opened on GitHub is off.');
  });

  app.post('/w/:wid/tickets/triage/resume', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    await resumeTriage(deps.db, ctx.workspace.id);
    setFlash(reply, 'success', 'Triage resumed');
    return reply.redirect(back(ctx));
  });

  // ---- Suggestions on a ticket (people who can act on tickets) ------------------------------------

  for (const verb of ['apply', 'dismiss'] as const) {
    app.post(`/w/:wid/tickets/:id/triage/${verb}`, async (req, reply) => {
      const ctx = await web.requireWorkspace(req, reply, { permission: 'tickets.act' });
      if (!ctx) return reply;
      const id = (req.params as { id: string }).id;
      const kind = String((req.body as { kind?: string }).kind ?? '');
      try {
        const action = verb === 'apply'
          ? await web.triage.applySuggestion(ctx.workspace.id, id, kind, ctx.user.id)
          : await web.triage.dismissSuggestion(ctx.workspace.id, id, kind, ctx.user.id);
        setFlash(reply, 'success', verb === 'apply' ? `Applied on GitHub${action.close ? ' and closed the issue' : ''}` : 'Suggestion dismissed');
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
        setFlash(reply, 'error', err.message);
      }
      return reply.redirect(`${ctx.base}/tickets/${id}`);
    });
  }
}

