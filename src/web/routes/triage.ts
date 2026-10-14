import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { listApps } from '../../domain/store.js';
import { listTicketTypes } from '../../domain/ticket-types.js';
import { UserFacingError } from '../../domain/types.js';
import { html, raw } from '../../lib/html.js';
import { classifyAiError, type ModelOption } from '../../triage/ai.js';
import {
  DEFAULT_MODEL,
  FLAGS,
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
import { btn, csrfField, dialog, notice, pill, plural, postBtn, segRadios, selectWrap, setting, submitBtn, switchInput, timeAgo } from '../ui.js';
import { textField } from './panel.js';
import { ticketsHeader } from './tickets.js';

const FLAG_COPY: Record<Flag, { title: string; desc: string; close: string }> = {
  duplicate: { title: 'Duplicates', desc: 'Compares the ticket with open issues in the same repository. Adds a label and comments “Possible duplicate of #123”.', close: 'Close duplicates as not planned' },
  spam: { title: 'Spam', desc: 'Advertising, scams, gibberish and abuse. Adds a label.', close: 'Close spam as not planned' },
  needsInfo: { title: 'Needs more info', desc: 'Genuine tickets that are missing what’s needed to act, like steps to reproduce. Adds a label.', close: 'Close tickets that need more info' },
  noAction: { title: 'No action needed', desc: 'Test messages, thank-yous and things sent by mistake. Adds a label.', close: 'Close them as not planned' },
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
    const [settings, apps, types, usage, key] = await Promise.all([
      getTriageSettings(deps.db, wid),
      listApps(deps.db, wid),
      listTicketTypes(deps.db, wid),
      monthlyUsage(deps.db, wid),
      resolveApiKey(deps, wid),
    ]);
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
      <div class="fields-2">
        <div class="field"><label for="${f}_label">GitHub label</label><input id="${f}_label" type="text" name="${f}_label" value="${c[f].label}" maxlength="50" required></div>
        <div class="field"><span class="label">When applied automatically</span><label class="check mt-8"><input type="checkbox" name="${f}_close" value="1" ${c[f].close ? raw('checked') : ''}> ${FLAG_COPY[f].close}</label></div>
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
        <div class="card">
          <div class="card-h"><h2>Model, scope and limits</h2></div>
          ${setting('Model', modelError ? `Couldn’t load models: ${modelError}` : key ? 'Models available to your API key. Haiku is the fastest and cheapest.' : 'Add an API key to load the models it can use.', selectWrap(html`<select id="model" name="model" ${available.length ? '' : raw('disabled')}>${modelOptions.map((m) => html`<option value="${m.id}" ${m.id === c.model ? raw('selected') : ''}>${m.name}${m.deprecated && available.length ? ' (deprecated)' : ''}</option>`)}</select>`), { for: 'model' })}
          ${available.length ? '' : html`<input type="hidden" name="model" value="${c.model}">`}
          ${setting('Confidence threshold', 'Automatic actions only happen at or above this confidence.', html`<input type="number" name="threshold" value="${String(c.threshold)}" min="50" max="100" required aria-label="Confidence threshold"><span class="connector">%</span>`)}
          ${setting('Monthly limit', 'Triage stops for the rest of the month after this many tickets. Filing isn’t affected.', html`<input type="number" class="wide" name="monthly_limit" value="${String(c.monthlyLimit)}" min="1" max="100000" required aria-label="Monthly limit"><span class="connector">tickets</span>`)}
          ${setting('Apps', 'Which apps’ tickets are triaged. While all are selected, new apps are included too.', html`<div class="check-list">${apps.map((a) => html`<label class="check"><input type="checkbox" name="app_ids" value="${a.id}" ${!c.appIds || c.appIds.includes(a.id) ? raw('checked') : ''}> ${a.name}</label>`)}</div>`, { top: true })}
          ${types.length ? setting('Ticket types', 'Which ticket types are triaged.', html`<div class="check-list">${types.map((t) => html`<label class="check"><input type="checkbox" name="type_names" value="${t.name}" ${!c.typeNames || c.typeNames.includes(t.name) ? raw('checked') : ''}> ${t.name}</label>`)}</div>`, { top: true }) : ''}
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
      const labels = [...PRIORITIES.map((p) => str(`priority_label_${p}`)), ...FLAGS.map((f) => str(`${f}_label`))];
      if (labels.some((l) => !l || l.length > 50)) throw new UserFacingError('Every label needs a name of up to 50 characters.');
      const model = str('model') || DEFAULT_MODEL;
      if (!/^[a-z0-9][a-z0-9.-]{2,99}$/.test(model)) throw new UserFacingError('Choose a model from the list.');
      const threshold = Number(str('threshold'));
      const monthlyLimit = Number(str('monthly_limit'));
      if (!Number.isInteger(threshold) || threshold < 50 || threshold > 100) throw new UserFacingError('The confidence threshold must be between 50 and 100.');
      if (!Number.isInteger(monthlyLimit) || monthlyLimit < 1 || monthlyLimit > 100_000) throw new UserFacingError('The monthly limit must be between 1 and 100,000 tickets.');
      const [apps, types] = await Promise.all([listApps(deps.db, ctx.workspace.id), listTicketTypes(deps.db, ctx.workspace.id)]);
      const appIds = list('app_ids').filter((id) => apps.some((a) => a.id === id));
      const typeNames = list('type_names').filter((n) => types.some((t) => t.name === n));
      if (apps.length && !appIds.length) throw new UserFacingError('Choose at least one app.');
      if (types.length && !typeNames.length) throw new UserFacingError('Choose at least one ticket type.');
      const config: TriageConfig = parseTriageConfig({
        model,
        threshold,
        monthlyLimit,
        appIds: appIds.length === apps.length ? null : appIds,
        typeNames: typeNames.length === types.length ? null : typeNames,
        instructions: str('instructions').replace(/\r\n/g, '\n').slice(0, 2000),
        priority: {
          mode: mode('priority_mode'),
          labels: Object.fromEntries(PRIORITIES.map((p) => [p, str(`priority_label_${p}`)])),
          guide: str('priority_guide').replace(/\r\n/g, '\n').slice(0, 1500),
        },
        ...Object.fromEntries(FLAGS.map((f) => [f, { mode: mode(`${f}_mode`), label: str(`${f}_label`), close: b[`${f}_close`] !== undefined }])),
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

