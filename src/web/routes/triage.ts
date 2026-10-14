import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { inspectGuild } from '../../domain/discord-checks.js';
import { getDiscordConnection, listApps } from '../../domain/store.js';
import { listTicketTypes } from '../../domain/ticket-types.js';
import { UserFacingError } from '../../domain/types.js';
import { html, raw } from '../../lib/html.js';
import { classifyAiError, type ModelOption } from '../../triage/ai.js';
import {
  ACTION_KINDS,
  ACTION_NAMES,
  actionsOffFor,
  CLOSE_ONLY_COMMENT,
  DEFAULT_MODEL,
  FLAG_DEFAULTS,
  FLAGS,
  NOTIFIABLE,
  MODES,
  PRIORITIES,
  anyActionOn,
  getTriageSettings,
  looksLikeApiKey,
  monthlyUsage,
  parseTriageConfig,
  pauseMessage,
  removeApiKey,
  resolveApiKey,
  resumeTriage,
  saveTriageConfig,
  setApiKey,
  setTriageEnabled,
  type Flag,
  type Mode,
  type TriageConfig,
} from '../../triage/settings.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { btn, csrfField, dialog, icon, notice, pill, plural, postBtn, segRadios, selectWrap, setting, submitBtn, switchInput, tag, timeAgo, typeIcon } from '../ui.js';
import { textField } from './panel.js';
import { ticketsHeader } from './tickets.js';

const FLAG_COPY: Record<Flag, { title: string; desc: string; placeholders: string }> = {
  support: { title: 'Not a development issue', desc: 'How-to and installation help, account or billing questions: things your community should answer, not code changes. Adds a label and posts your reply.', placeholders: '{app}, {help_channel}' },
  duplicate: { title: 'Duplicates', desc: 'Compares the ticket with open issues in the same repository. Adds a label and posts your comment.', placeholders: '{duplicate}, {app}, {help_channel}' },
  needsInfo: { title: 'Needs more info', desc: 'Real bug reports or feature requests that are missing details. Claude picks what’s missing (steps to reproduce, expected vs. actual, app version, operating system, screenshot); your comment lists it.', placeholders: '{missing}, {app}, {help_channel}' },
  spam: { title: 'Spam', desc: 'Advertising, scams, gibberish and abuse. Adds a label.', placeholders: '{app}, {help_channel}' },
  noAction: { title: 'No action needed', desc: 'Test messages, thank-yous and things sent by mistake. Adds a label.', placeholders: '{app}, {help_channel}' },
};

const MODE_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'suggest', label: 'Suggest' },
  { value: 'auto', label: 'Automatic' },
];

/** Approximate list prices (USD per million tokens) for the cost estimate; unknown models show tokens only. */
const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-fable-5-1': [10, 50],
};

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
    const c = settings.config;
    const { models: available, error: modelError } = await models(key?.key ?? null);
    const price = PRICES[c.model];
    const cost = price ? (usage.inputTokens * price[0] + usage.outputTokens * price[1]) / 1_000_000 : null;
    const nextMonth = new Date(Date.UTC(usage.since.getUTCFullYear(), usage.since.getUTCMonth() + 1, 1));

    const status = !settings.enabled ? pill('Off', 'neutral') : settings.paused ? pill('Paused', 'warn') : pill('On', 'ok');
    const modelOptions = available.length ? available : [{ id: c.model, name: c.model, deprecated: false }];
    if (!modelOptions.some((m) => m.id === c.model)) modelOptions.unshift({ id: c.model, name: `${c.model} (not available to this key)`, deprecated: true });

    const flagSection = (f: Flag) => html`<div class="section">
      <div class="section-h"><div><h3>${FLAG_COPY[f].title}</h3><div class="desc">${FLAG_COPY[f].desc}</div></div>${segRadios(`${f}_mode`, MODE_OPTIONS, c[f].mode, `${FLAG_COPY[f].title} mode`)}</div>
      <div class="fields">
        <div class="fields-2">
          <div class="field"><label for="${f}_label">GitHub label</label><input id="${f}_label" type="text" name="${f}_label" value="${c[f].label}" maxlength="50" required></div>
          <div class="field"><span class="label">When applied</span>
            <label class="check mt-8"><input type="checkbox" name="${f}_close" value="1" ${c[f].close ? raw('checked') : ''}> Also close the issue (as not planned)</label>
            ${NOTIFIABLE.has(f) ? html`<label class="check mt-8"><input type="checkbox" name="${f}_notify" value="1" ${c[f].notifyMember ? raw('checked') : ''}> Also tell the member in Discord</label>` : ''}
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
      </div></div>`;

    const keyCard = html`<div class="card">
      <div class="card-h"><div><h2>Claude API key</h2><div class="desc">Stored encrypted. After saving, nobody can view it, including you; you can only replace or remove it. Set a monthly spend limit for the key in the Anthropic Console.</div></div></div>
      ${settings.key
        ? html`${setting('API key', html`Added${settings.key.addedBy ? ` by ${settings.key.addedBy}` : ''}${settings.key.addedAt ? ` ${timeAgo(settings.key.addedAt)}` : ''}`, html`<code>${settings.key.hint}</code>`)}
            <div class="card-f"><span></span><div class="end">
              ${postBtn(`${b}/tickets/triage/key/remove`, 'Remove', ctx.csrf, { variant: 'ghost danger', icon: 'trash-2', confirm: { title: 'Remove the API key?', body: deps.config.anthropicApiKey ? 'Triage falls back to the server’s key.' : 'Triage pauses until someone adds a key.', label: 'Remove key', danger: true } })}
              ${postBtn(`${b}/tickets/triage/key/test`, 'Test key', ctx.csrf, { icon: 'refresh-cw', loading: 'Testing…' })}
              ${btn('Replace', { variant: 'primary', icon: 'key-round', attrs: raw('data-dialog="key-dialog"') })}
            </div></div>`
        : html`${key?.source === 'server' ? html`<div class="card-b tight">${notice('info', 'Using the server’s key', 'ANTHROPIC_API_KEY is set on the server, so triage works without a key here. Add one to bill your own Anthropic account.')}</div>` : ''}
            <form method="post" action="${b}/tickets/triage/key">${csrfField(ctx.csrf)}
              ${setting('API key', 'Create one at console.anthropic.com › API keys. It starts with sk-ant-.', html`<input type="password" name="api_key" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" required aria-label="Claude API key">`)}
              <div class="card-f"><span></span><div class="end">${submitBtn('Save key', { variant: 'primary', loading: 'Checking…' })}</div></div>
            </form>`}
    </div>
    ${settings.key ? dialog('key-dialog', {
      title: 'Replace the API key',
      action: `${b}/tickets/triage/key`,
      csrf: ctx.csrf,
      body: html`<p>The new key is checked with Claude before it replaces <code>${settings.key.hint}</code>.</p>
        <div class="field"><label for="new-key">New API key</label><input id="new-key" type="password" name="api_key" class="full" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" required autofocus></div>`,
      submit: submitBtn('Replace key', { variant: 'primary', loading: 'Checking…' }),
    }) : ''}`;

    const body = html`
      ${await ticketsHeader(web, ctx, 'triage')}
      ${settings.enabled && settings.paused
        ? notice('warn', 'Triage is paused', `${pauseMessage(settings.paused.reason, settings.paused.detail, c.model)} Tickets are still being filed normally.`, { action: postBtn(`${b}/tickets/triage/resume`, 'Resume', ctx.csrf, { size: 'sm', icon: 'rotate-ccw' }) })
        : ''}
      ${settings.enabled && usage.triaged >= c.monthlyLimit
        ? notice('warn', 'Monthly limit reached', `Triage resumes on ${nextMonth.toISOString().slice(0, 10)}, or raise the limit below. Tickets are still being filed normally.`)
        : ''}
      <div class="card">
        <div class="card-h"><div><div class="title"><h2>AI triage</h2>${status}</div><div class="desc">Claude reads each ticket after it’s filed and flags priority, duplicates and spam. It runs in its own worker: if it’s off, paused or out of credits, tickets are still filed exactly as before.</div></div></div>
        ${setting('Triage', key ? 'Only tickets filed after you turn it on are triaged.' : 'Add a Claude API key first.', html`<form method="post" action="${b}/tickets/triage/enabled" data-async class="inline-form">${csrfField(ctx.csrf)}<input type="hidden" name="set" value="1">
          ${switchInput({ name: 'enabled', checked: settings.enabled, label: 'Triage on', disabled: !key && !settings.enabled })}<button type="submit" class="btn sm nojs">Save</button></form>`, { switchRow: true })}
        ${setting('This month', null, html`<span class="value">${plural(usage.triaged, 'ticket')} of ${String(c.monthlyLimit)}${cost !== null ? ` · about $${cost < 0.01 && cost > 0 ? '0.01' : cost.toFixed(2)}` : ''}${usage.inputTokens ? ` · ${(usage.inputTokens + usage.outputTokens).toLocaleString('en-US')} tokens` : ''}</span>`)}
      </div>
      ${keyCard}
      <form method="post" action="${b}/tickets/triage" class="stack" data-dirty>
        ${csrfField(ctx.csrf)}
        <div class="card">
          <div class="card-h"><div><h2>What triage does</h2><div class="desc">Every action starts off. <strong>Suggest</strong> shows Claude’s call on the ticket for someone to apply. <strong>Automatic</strong> applies it on GitHub when Claude is at least ${String(c.threshold)}% sure; less sure calls become suggestions.</div></div></div>
          <div class="section">
            <div class="section-h"><div><h3>Priority</h3><div class="desc">Adds one of four priority labels. The ticket type isn’t changed; the member picks it.</div></div>${segRadios('priority_mode', MODE_OPTIONS, c.priority.mode, 'Priority mode')}</div>
            <div class="fields">
              <div class="fields-2">${PRIORITIES.map((p) => html`<div class="field"><label for="priority_label_${p}">${p[0]!.toUpperCase() + p.slice(1)} label</label><input id="priority_label_${p}" type="text" name="priority_label_${p}" value="${c.priority.labels[p]}" maxlength="50" required></div>`)}</div>
              ${textField({ id: 'priority_guide', label: 'What each priority means (optional)', value: c.priority.guide, max: 1500, rows: 4, placeholder: 'critical: crashes, data loss, security or payments\nhigh: a core feature is broken with no workaround\nmedium: something is wrong but there’s a workaround\nlow: cosmetic issues, small improvements and questions', hint: 'Leave empty for the defaults shown here.' })}
            </div>
          </div>
          ${FLAGS.map(flagSection)}
        </div>
        ${types.length ? html`<div class="card" id="rules">
          <div class="card-h"><div><h2>Rules by ticket type</h2><div class="desc">Members pick a ticket type when they open a ticket. Choose which actions run for each type. Unticked actions never run for that type, and Claude is told to skip them so it still checks the rest.</div></div></div>
          <input type="hidden" name="rules" value="1">
          <div class="card-b flush"><div class="table-wrap"><table>
            <thead><tr><th class="th-perm"><div class="l">Ticket type</div></th>${ACTION_KINDS.map((k) => {
              const m = k === 'priority' ? c.priority.mode : c[k].mode;
              return html`<th class="th-perm center"><div class="l">${ACTION_NAMES[k]}</div><div class="d">${m === 'off' ? 'Off' : m === 'suggest' ? 'Suggest' : 'Automatic'}</div></th>`;
            })}</tr></thead>
            <tbody>${types.map((t) => {
              const off = actionsOffFor(c, t);
              return html`<tr>
                <td><span class="who-cell">${icon(typeIcon(t), 16, 'muted')}<span><span class="cell-title">${t.name}</span>${t.label ? html`<span class="sub mono">${t.label}</span>` : ''}</span>${off.size === ACTION_KINDS.length ? tag('Not triaged') : ''}</span></td>
                ${ACTION_KINDS.map((k) => html`<td class="center"><input type="checkbox" class="rule-check" name="rule_${t.id}" value="${k}" ${off.has(k) ? '' : raw('checked')} aria-label="${t.name}: ${ACTION_NAMES[k]}"></td>`)}
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
          <div class="section">${textField({ id: 'instructions', label: 'Instructions for Claude (optional)', value: c.instructions, max: 2000, rows: 4, placeholder: 'Anything about payments or sign-in is high priority. Questions about pricing are low priority.', hint: 'Context about your product that helps Claude decide. Only admins can see and change this.' })}</div>
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
      const labels = [...PRIORITIES.map((p) => str(`priority_label_${p}`)), ...FLAGS.map(flagLabel)];
      if (labels.some((l) => !l || l.length > 50)) throw new UserFacingError('Every label needs a name of up to 50 characters.');
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
        model,
        threshold,
        monthlyLimit,
        appIds: appIds.length === apps.length ? null : appIds,
        // The rules table replaces the old "which types are triaged" list.
        typeNames: b.rules === '1' ? null : currentConfig.typeNames,
        typeRules: b.rules === '1'
          ? Object.fromEntries(types.map((t) => {
              const on = new Set(list(`rule_${t.id}`));
              return [t.id, { off: ACTION_KINDS.filter((k) => !on.has(k)) }];
            }))
          : currentConfig.typeRules,
        instructions: str('instructions').replace(/\r\n/g, '\n').slice(0, 2000),
        priority: {
          mode: mode('priority_mode'),
          labels: Object.fromEntries(PRIORITIES.map((p) => [p, str(`priority_label_${p}`)])),
          guide: str('priority_guide').replace(/\r\n/g, '\n').slice(0, 1500),
        },
        ...Object.fromEntries(FLAGS.map((f) => [f, {
          mode: mode(`${f}_mode`),
          label: flagLabel(f),
          close: b[`${f}_close`] !== undefined,
          comment: b[`${f}_comment`] === undefined ? currentConfig[f].comment : str(`${f}_comment`).replace(/\r\n/g, '\n').slice(0, 1500),
          notifyMember: NOTIFIABLE.has(f) && b[`${f}_notify`] !== undefined,
        }])),
        helpChannel,
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

  app.post('/w/:wid/tickets/triage/key', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const key = String((req.body as { api_key?: string }).api_key ?? '').trim();
    try {
      if (!looksLikeApiKey(key)) throw new UserFacingError('That doesn’t look like a Claude API key. Keys start with sk-ant-.');
      let warning = '';
      try {
        await web.triage.ai.listModels(key);
      } catch (err) {
        const e = classifyAiError(err);
        if (e.pauseReason === 'key_invalid') throw new UserFacingError('Claude rejected this key. Check that you copied all of it.');
        warning = e.pauseReason === 'credits' ? ' The Anthropic account is out of credits, so triage will pause until you add some.' : ' Claude couldn’t be reached to check it right now.';
      }
      await setApiKey(deps.db, deps.box, ctx.workspace.id, key, ctx.user.id);
      setFlash(reply, warning ? 'warn' : 'success', `API key saved.${warning}`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(back(ctx));
  });

  app.post('/w/:wid/tickets/triage/key/remove', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    await removeApiKey(deps.db, ctx.workspace.id);
    setFlash(reply, 'success', 'API key removed');
    return reply.redirect(back(ctx));
  });

  app.post('/w/:wid/tickets/triage/key/test', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const key = await resolveApiKey(deps, ctx.workspace.id);
    if (!key) {
      setFlash(reply, 'error', 'There’s no API key to test.');
      return reply.redirect(back(ctx));
    }
    try {
      const list = await web.triage.ai.listModels(key.key);
      setFlash(reply, 'success', `The key works. ${plural(list.length, 'model')} available.`);
    } catch (err) {
      setFlash(reply, 'error', `The key didn’t work: ${classifyAiError(err).message}`);
    }
    return reply.redirect(back(ctx));
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

