import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { inspectGuild } from '../../domain/discord-checks.js';
import { can } from '../../domain/permissions.js';
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
  saveTriageConfig,
  setTriageEnabled,
  type Flag,
  type Mode,
  type TriageConfig,
} from '../../triage/settings.js';
import { keyPill, keyStatus, keySummary } from './claude.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { csrfField, icon, linkBtn, locked, notice, plural, postBtn, segRadios, selectWrap, setting, submitBtn, switchInput, tag, typeIcon } from '../ui.js';
import { textField } from './panel.js';
import { areaHref, canOpen, pageLink, toolHeader } from './tool.js';
import { workspacePath } from './triage-bulk.js';

export const FLAG_COPY: Record<Flag, { title: string; desc: string; placeholders: string }> = {
  support: { title: 'Not a development issue', desc: 'How-to and installation help, account or billing questions: things your community should answer, not code changes. Adds a label and posts your reply.', placeholders: '{app}, {help_channel}' },
  duplicate: { title: 'Duplicates', desc: 'Compares the ticket with every issue in the same repository and links the original. Adds a label and posts your comment.', placeholders: '{duplicate}, {app}, {help_channel}' },
  regression: { title: 'Regression', desc: 'A problem that’s back: the ticket matches an issue that was closed as fixed. Adds a label and links the old issue. Never closes the ticket.', placeholders: '{regression}, {app}, {help_channel}' },
  inProgress: { title: 'Being worked on', desc: 'An open pull request already works on the ticket’s problem or request: it fixes it, or it’s for an issue that’s the same. Adds a label and names the pull request. Never closes the ticket.', placeholders: '{pull}, {app}' },
  fixed: { title: 'Already fixed', desc: 'A merged pull request, or a commit pushed without one, already fixed it. {release} says whether that’s in a release yet (“it’s in v1.4.3”) or not (“it will be in the next release”). Never closes the ticket. A fix that didn’t hold is a Regression instead.', placeholders: '{fix}, {release}, {app}' },
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

/** Shown where Save would be, on a page this person can only see. */
export function viewOnlyFooter(what: string): SafeHtml {
  return html`<span class="small muted">${icon('eye', 14)} View only. Ask an admin if you need to change ${what}.</span>`;
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
  const back = (ctx: WorkspaceRequestContext) => areaHref(ctx, 'triage.actions');

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

  app.get('/w/:wid/triage/actions', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.actions.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    const edit = can(ctx.membership, 'triage.actions.edit');
    const admin = can(ctx.membership, 'manage');
    const settingsLink = (text: string, plain: string) => (admin ? html`<a href="${b}/settings#claude">${text}</a>` : plain);
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
      ${await toolHeader(web, ctx, 'triage', 'triage.actions')}
      ${!key ? notice('warn', 'Triage needs a Claude API key', admin ? 'Add the workspace’s key in Settings. It’s shared by every feature that uses Claude.' : 'An admin can add the workspace’s key in Settings.', { action: admin ? linkBtn(`${b}/settings#claude`, 'Open Settings', { size: 'sm', trail: 'arrow-right' }) : undefined }) : ''}
      ${anyOn && settings.paused
        ? notice('warn', 'Triage is paused', `${pauseMessage(settings.paused.reason, settings.paused.detail, c.model)} Tickets are still being filed normally.`, { id: 'triage-paused', action: edit ? postBtn(`${b}/triage/resume`, 'Try again', ctx.csrf, { size: 'sm', icon: 'rotate-ccw', loading: 'Checking…' }) : undefined })
        : ''}
      ${anyOn && usage.triaged >= c.monthlyLimit
        ? notice('warn', 'Monthly limit reached', `Triage resumes on ${nextMonth.toISOString().slice(0, 10)}${edit ? ', or raise the limit below' : ''}. Tickets are still being filed normally.`)
        : ''}
      <div class="card">
        <div class="card-h"><div><h2>Switches</h2><div class="desc">Turn triage on for each source. It runs in its own worker: if it’s off, paused or out of credits, tickets are still filed exactly as before.</div></div></div>
        ${setting('Claude API key', admin ? keySummary(keyState, b) : 'Shared by every feature that uses Claude. Admins manage it in Settings.', keyPill(keyState))}
        ${setting(html`${icon('message-circle', 16, 'muted')} Discord tickets`, key ? html`Tickets members open in Discord. Only tickets filed after you turn it on are triaged; for older ones, use ${pageLink(ctx, 'triage.runs', 'Re-run')}.` : html`Needs a Claude API key. ${settingsLink('Add one in Settings', 'An admin can add one in Settings.')}`, html`<form method="post" action="${b}/triage/enabled" data-async class="inline-form">${csrfField(ctx.csrf)}<input type="hidden" name="set" value="1">
          ${switchInput({ name: 'enabled', checked: settings.enabled, label: 'Triage Discord tickets', disabled: !edit || (!key && !settings.enabled) })}${edit ? html`<button type="submit" class="btn sm nojs">Save</button>` : ''}</form>`, { switchRow: true })}
        ${setting(html`${icon('github', 16, 'muted')} Issues opened on GitHub`, key ? html`Issues people open directly on GitHub (not pull requests, bots, or tickets from Discord). Only issues opened after you turn it on are triaged; for older ones, use ${pageLink(ctx, 'triage.runs', 'Re-run')}.${canOpen(ctx.membership, 'triage.review') ? html` Review their suggestions in ${pageLink(ctx, 'triage.review', 'Review')}.` : canOpen(ctx.membership, 'issues-github') ? html` See them in ${pageLink(ctx, 'issues-github', 'GitHub issues › Opened on GitHub')}.` : ''}` : html`Needs a Claude API key. ${settingsLink('Add one in Settings', 'An admin can add one in Settings.')}`, html`<form method="post" action="${b}/triage/github-enabled" data-async data-gh-switch class="inline-form">${csrfField(ctx.csrf)}<input type="hidden" name="set" value="1">
          ${switchInput({ name: 'enabled', checked: settings.githubEnabled, label: 'Triage issues opened on GitHub', disabled: !edit || (!key && !settings.githubEnabled) })}${edit ? html`<button type="submit" class="btn sm nojs">Save</button>` : ''}</form>`, { switchRow: true })}
        ${setting('This month', 'Re-runs count too.', html`<span class="value">${plural(usage.triaged, 'ticket')} of ${String(c.monthlyLimit)}${cost !== null ? ` · ${formatCost(cost)}` : ''}${usage.inputTokens ? ` · ${(usage.inputTokens + usage.outputTokens).toLocaleString('en-US')} tokens` : ''}</span>`)}
      </div>
      <form method="post" action="${b}/triage/actions" ${edit ? raw('data-dirty') : ''}>
        ${csrfField(ctx.csrf)}
        <fieldset class="plain stack${edit ? '' : ' view-only'}" ${edit ? '' : raw('disabled')}>
        <div class="card">
          <div class="card-h"><div><h2>What triage does</h2><div class="desc">Each action has its own setting for Discord tickets and for issues opened on GitHub, and starts Off. <strong>Suggest</strong> shows Claude’s call for someone to apply. <strong>Automatic</strong> applies it on GitHub when Claude is at least ${String(c.threshold)}% sure; less sure calls become suggestions. The label, comment and closing are shared.</div>
            <div class="src-summary"><span>${icon('message-circle', 14)}Discord tickets: ${sourceSummary(ticketsOn, (k) => actionMode(c, k), settings.enabled)}</span><span>${icon('github', 14)}Opened on GitHub: ${sourceSummary(githubOn, (k) => githubMode(c, k), settings.githubEnabled)}</span></div></div>
            ${edit ? html`<div class="row js-only"><button type="button" class="btn sm" data-copy-modes>Copy Discord settings to GitHub</button><button type="button" class="btn sm" data-set-gh-modes="suggest">Set all GitHub to Suggest</button></div>` : ''}</div>
          <div class="card-b tight" data-gh-off-note ${ghOff ? '' : raw('hidden')}>${notice('info', null, edit ? 'Issues opened on GitHub is switched off, so its settings below aren’t used yet. You can set them up first and turn it on above when you’re ready.' : 'Issues opened on GitHub is switched off, so its settings below aren’t used yet.')}</div>
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
            <div class="section-h"><div><h3>Custom labels</h3><div class="desc">Your own labels, in categories such as Kind, Topic and Platform. Claude picks from each category for every ticket, and only from your labels.</div></div>${can(ctx.membership, 'triage.labels.edit') ? linkBtn(areaHref(ctx, 'triage.labels'), c.labelGroups.length ? 'Edit labels' : 'Add labels', { size: 'sm', trail: 'arrow-right' }) : canOpen(ctx.membership, 'triage.labels') && c.labelGroups.length ? linkBtn(areaHref(ctx, 'triage.labels'), 'See labels', { size: 'sm', trail: 'arrow-right' }) : ''}</div>
            ${c.labelGroups.map((g) => html`<div class="group-row"><div><div class="cell-title">${icon('tags', 14, 'muted')} ${g.name}</div><div class="sub">${plural(g.options.length, 'label')}</div></div>${modeControls(`group_${g.id}`, groupKind(g.id), g.name)}</div>`)}
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
        <div class="card" id="limits">
          <div class="card-h"><h2>Model, scope and limits</h2></div>
          ${setting('Model', modelError ? `Couldn’t load models: ${modelError}` : key ? 'Models available to your API key. Haiku is the fastest and cheapest.' : admin ? 'Add an API key in Settings to load the models it can use.' : 'Models load once an admin adds a Claude API key.', selectWrap(html`<select id="model" name="model" ${available.length ? '' : raw('disabled')}>${modelOptions.map((m) => html`<option value="${m.id}" ${m.id === c.model ? raw('selected') : ''}>${m.name}${m.deprecated && available.length ? ' (deprecated)' : ''}</option>`)}</select>`), { for: 'model' })}
          ${available.length ? '' : html`<input type="hidden" name="model" value="${c.model}">`}
          ${setting('Confidence threshold', 'Automatic actions only happen at or above this confidence.', html`<input type="number" name="threshold" value="${String(c.threshold)}" min="50" max="100" required aria-label="Confidence threshold"><span class="connector">%</span>`)}
          ${setting('Monthly limit', 'Triage stops for the rest of the month after this many tickets. Filing isn’t affected.', html`<input type="number" class="wide" name="monthly_limit" value="${String(c.monthlyLimit)}" min="1" max="100000" required aria-label="Monthly limit"><span class="connector">tickets</span>`)}
          ${setting('Apps', 'Which apps’ tickets are triaged. While all are selected, new apps are included too.', html`<div class="check-list">${apps.map((a) => html`<label class="check"><input type="checkbox" name="app_ids" value="${a.id}" ${!c.appIds || c.appIds.includes(a.id) ? raw('checked') : ''}> ${a.name}</label>`)}</div>`, { stacked: true })}
          ${setting('Screenshots', 'Claude also looks at the screenshots members attach to Discord tickets (up to 5 per ticket), so it can read error messages and see what’s on screen. Each adds up to about 1,600 tokens. Issues opened on GitHub are read as text.', switchInput({ name: 'screenshots', checked: c.screenshots, label: 'Show Claude the screenshots' }), { switchRow: true })}
          ${setting('Knowledge', 'A TRIAGE.md for each app: what your team knows that a ticket doesn’t say. Claude reads it with every ticket, and asks when it’s missing something.', canOpen(ctx.membership, 'triage.knowledge') ? linkBtn(areaHref(ctx, 'triage.knowledge'), can(ctx.membership, 'triage.knowledge.edit') ? 'Edit TRIAGE.md files' : 'See TRIAGE.md files', { size: 'sm', trail: 'arrow-right' }) : locked('No access'))}
          ${setting('Prompt', 'What Claude is told about your products, each check and examples.', canOpen(ctx.membership, 'triage.prompt') ? linkBtn(areaHref(ctx, 'triage.prompt'), can(ctx.membership, 'triage.prompt.edit') ? 'Edit the prompt' : 'See the prompt', { size: 'sm', trail: 'arrow-right' }) : locked('No access'))}
          <div class="card-f">${anyActionOn(c) ? html`<span></span>` : html`<span class="small muted">Every action is off, so triage won’t do anything yet.</span>`}${edit ? html`<div class="end">
            <button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>
            ${submitBtn('Save changes', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
          </div>` : viewOnlyFooter('these settings')}</div>
        </div>
        </fieldset>
      </form>`;
    return web.render(reply, ctx, 'Actions · AI triage', 'triage', body);
  });

  app.post('/w/:wid/triage/actions', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.actions.edit' });
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
        screenshots: b.screenshots !== undefined,
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
  app.post('/w/:wid/triage/enabled', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.actions.edit' });
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
  app.post('/w/:wid/triage/github-enabled', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.actions.edit' });
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

  /** Try again: asks Claude first, and carries on only if it answers (JSON for the alert, or a form). */
  app.post('/w/:wid/triage/resume', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.actions.edit' });
    if (!ctx) return reply;
    const [check] = await web.triage.checkPaused({ workspaceId: ctx.workspace.id, by: ctx.user.id });
    const ok = !check || check.resumed;
    const message = !check ? 'Triage is running.' : check.resumed ? check.message : `Still paused: ${check.message}`;
    if (web.wantsJson(req)) return reply.send(ok ? { ok: true, message } : { ok: false, error: message });
    setFlash(reply, ok ? 'success' : 'error', message);
    return reply.redirect(back(ctx));
  });

  // ---- Suggestions on a ticket (people with Edit on Review) ---------------------------------------

  for (const verb of ['apply', 'dismiss'] as const) {
    app.post(`/w/:wid/tickets/:id/triage/${verb}`, async (req, reply) => {
      const ctx = await web.requireWorkspace(req, reply, { permission: 'triage.review.edit' });
      if (!ctx) return reply;
      const id = (req.params as { id: string }).id;
      const body = (req.body ?? {}) as { kind?: string; back?: string };
      const kind = String(body.kind ?? '');
      try {
        const action = verb === 'apply'
          ? await web.triage.applySuggestion(ctx.workspace.id, id, kind, ctx.user.id)
          : await web.triage.dismissSuggestion(ctx.workspace.id, id, kind, ctx.user.id);
        setFlash(reply, 'success', verb === 'apply' ? `Applied on GitHub${action.close ? ' and closed the issue' : ''}` : 'Suggestion dismissed');
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
        setFlash(reply, 'error', err.message);
      }
      // Back where it was pressed (AI triage › Review sends its list), else the ticket.
      return reply.redirect(workspacePath(ctx, body.back) ?? `${ctx.base}/tickets/${id}`);
    });
  }
}

