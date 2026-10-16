import type { FastifyInstance } from 'fastify';
import {
  claudeKeyStatus,
  getClaudeKey,
  KEY_STATE_TEXT,
  looksLikeApiKey,
  removeClaudeKey,
  setClaudeKey,
  type ClaudeKeyStatus,
  type KeyState,
} from '../../domain/claude-key.js';
import { UserFacingError } from '../../domain/types.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { classifyAiError } from '../../triage/ai.js';
import { getTriageSettings } from '../../triage/settings.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { btn, csrfField, dialog, linkBtn, notice, pill, plural, postBtn, setting, submitBtn, timeAgo, type Tone } from '../ui.js';

const STATE_TONE: Record<ClaudeKeyStatus['state'], Tone> = { working: 'ok', rejected: 'danger', credits: 'warn', unreachable: 'warn', missing: 'neutral', unchecked: 'neutral' };

export function keyPill(s: ClaudeKeyStatus): SafeHtml {
  return pill(s.source === 'server' && s.state === 'working' ? 'Working · server key' : KEY_STATE_TEXT[s.state], STATE_TONE[s.state]);
}

/** Checks a key with Claude by listing its models (no tokens are used). */
export function keyChecker(web: Web): (key: string) => Promise<{ state: KeyState; detail: string | null }> {
  return async (key) => {
    try {
      const models = await web.triage.ai.listModels(key);
      return { state: 'working', detail: `${plural(models.length, 'model')} available` };
    } catch (err) {
      const e = classifyAiError(err);
      return { state: e.pauseReason === 'key_invalid' ? 'rejected' : e.pauseReason === 'credits' ? 'credits' : 'unreachable', detail: e.message };
    }
  };
}

export function keyStatus(web: Web, workspaceId: string, o: { fresh?: boolean; live?: boolean } = {}): Promise<ClaudeKeyStatus> {
  return claudeKeyStatus(web.deps, keyChecker(web), workspaceId, o).catch(() => ({ source: null, key: null, state: 'unreachable' as const, detail: null, checkedAt: null }));
}

/** One line describing the key, for Triage and Deployment, linking to Settings. */
export function keySummary(s: ClaudeKeyStatus, base: string): SafeHtml {
  if (s.state === 'missing') return html`No Claude API key yet. Add one in <a href="${base}/settings#claude">Settings › Claude API</a>.`;
  const which = s.source === 'server' ? 'The server’s key (ANTHROPIC_API_KEY)' : html`<code>${s.key?.hint ?? 'sk-ant-…'}</code>`;
  const checked = s.checkedAt ? ` Checked ${timeAgo(s.checkedAt)}${s.detail ? `: ${s.detail}` : ''}.` : '';
  return html`${which}.${checked} <a href="${base}/settings#claude">Manage in Settings</a>`;
}

/** The Claude API card in Settings: add, test, replace or remove the workspace's key. */
export async function claudeCard(web: Web, ctx: WorkspaceRequestContext): Promise<SafeHtml> {
  const b = ctx.base;
  const wid = ctx.workspace.id;
  const [status, key, triage] = await Promise.all([keyStatus(web, wid), getClaudeKey(web.deps.db, wid), getTriageSettings(web.deps.db, wid)]);
  const usedBy = setting('Used by', 'Features in this workspace that call Claude with this key.',
    html`<div class="tags">${linkBtn(`${b}/triage/actions`, html`AI triage · ${triage.enabled || triage.githubEnabled ? 'On' : 'Off'}`, { size: 'sm', variant: 'ghost', trail: 'arrow-right' })}</div>`);
  const body = key
    ? html`${setting('API key', html`Added${key.addedBy ? ` by ${key.addedBy}` : ''}${key.addedAt ? ` ${timeAgo(key.addedAt)}` : ''}.${status.checkedAt ? ` Checked ${timeAgo(status.checkedAt)}${status.detail ? `: ${status.detail}` : ''}.` : ''}`, html`<code>${key.hint}</code>`)}
        ${usedBy}
        <div class="card-f"><span></span><div class="end">
          ${postBtn(`${b}/settings/claude/remove`, 'Remove', ctx.csrf, { variant: 'ghost danger', icon: 'trash-2', confirm: { title: 'Remove the Claude API key?', body: web.deps.config.anthropicApiKey ? 'Features fall back to the server’s key.' : 'AI triage pauses until someone adds a key.', label: 'Remove key', danger: true } })}
          ${postBtn(`${b}/settings/claude/test`, 'Test key', ctx.csrf, { icon: 'refresh-cw', loading: 'Testing…' })}
          ${btn('Replace', { variant: 'primary', icon: 'key-round', attrs: raw('data-dialog="key-dialog"') })}
        </div></div>`
    : html`${status.source === 'server' ? html`<div class="card-b tight">${notice('info', 'Using the server’s key', 'ANTHROPIC_API_KEY is set on the server, so Claude features work without a key here. Add one to use your own Anthropic account.')}</div>` : ''}
        <form method="post" action="${b}/settings/claude/key">${csrfField(ctx.csrf)}
          ${setting('API key', 'Create one at console.anthropic.com › API keys. It starts with sk-ant-.', html`<input type="password" name="api_key" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" required aria-label="Claude API key">`)}
          ${usedBy}
          <div class="card-f"><span></span><div class="end">${submitBtn('Save key', { variant: 'primary', loading: 'Checking…' })}</div></div>
        </form>`;
  return html`<div class="card" id="claude">
      <div class="card-h"><div><div class="title"><h2>Claude API</h2>${keyPill(status)}</div><div class="desc">One key for every feature that uses Claude. Stored encrypted: after saving, nobody can view it, including you; you can only replace or remove it. Set a monthly spend limit for it in the Anthropic Console.</div></div></div>
      ${status.state === 'rejected' || status.state === 'credits' ? html`<div class="card-b tight">${notice(status.state === 'rejected' ? 'danger' : 'warn', status.state === 'rejected' ? 'Claude rejected this key' : 'The Anthropic account is out of credits', status.state === 'rejected' ? 'Replace it with a working key. AI triage is paused meanwhile; tickets are still filed.' : 'Add credits in the Anthropic Console, then test the key. AI triage is paused meanwhile; tickets are still filed.')}</div>` : ''}
      ${body}
    </div>
    ${key ? dialog('key-dialog', {
      title: 'Replace the Claude API key',
      action: `${b}/settings/claude/key`,
      csrf: ctx.csrf,
      body: html`<p>The new key is checked with Claude before it replaces <code>${key.hint}</code>.</p>
        <div class="field"><label for="new-key">New API key</label><input id="new-key" type="password" name="api_key" class="full" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" required autofocus></div>`,
      submit: submitBtn('Replace key', { variant: 'primary', loading: 'Checking…' }),
    }) : ''}`;
}

export function registerClaudeRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const back = (ctx: WorkspaceRequestContext) => `${ctx.base}/settings#claude`;

  app.post('/w/:wid/settings/claude/key', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const key = String((req.body as { api_key?: string }).api_key ?? '').trim();
    try {
      if (!looksLikeApiKey(key)) throw new UserFacingError('That doesn’t look like a Claude API key. Keys start with sk-ant-.');
      const check = await keyChecker(web)(key);
      if (check.state === 'rejected') throw new UserFacingError('Claude rejected this key. Check that you copied all of it.');
      await setClaudeKey(deps.db, deps.box, ctx.workspace.id, key, ctx.user.id, check);
      const warning = check.state === 'credits' ? ' The Anthropic account is out of credits, so AI triage pauses until you add some.' : check.state === 'unreachable' ? ' Claude couldn’t be reached to check it right now.' : '';
      setFlash(reply, warning ? 'warn' : 'success', `Claude API key saved.${warning}`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(back(ctx));
  });

  app.post('/w/:wid/settings/claude/remove', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    await removeClaudeKey(deps.db, ctx.workspace.id);
    setFlash(reply, 'success', 'Claude API key removed');
    return reply.redirect(back(ctx));
  });

  app.post('/w/:wid/settings/claude/test', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const s = await keyStatus(web, ctx.workspace.id, { fresh: true });
    if (s.state === 'missing') setFlash(reply, 'error', 'There’s no Claude API key to test.');
    else if (s.state === 'working') setFlash(reply, 'success', `The key works. ${s.detail ?? ''}`.trim());
    else setFlash(reply, 'error', `The key didn’t work: ${s.detail ?? KEY_STATE_TEXT[s.state]}`);
    return reply.redirect(back(ctx));
  });

}
