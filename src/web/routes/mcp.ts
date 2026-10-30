/**
 * MCP: connecting coding agents to the workspace. Everyone who can use it makes their own tokens
 * here and sees what their agent can do; admins turn it on or off, see everyone's tokens and
 * claims, and revoke or release them. Which tools each moderator gets is set in Members &
 * permissions.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { can, canMcp, canUseMcp, MCP_GROUPS, MCP_SWITCH_KEYS, MCP_SWITCHES, mcpSwitches } from '../../domain/permissions.js';
import { listApps } from '../../domain/store.js';
import { UserFacingError } from '../../domain/types.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { activeClaims, CLAIM_DAYS, MAX_CLAIMS, releaseClaim } from '../../mcp/claims.js';
import { PROMPTS } from '../../mcp/prompts.js';
import { TOOLS } from '../../mcp/tools.js';
import { createToken, DEFAULT_EXPIRY_DAYS, EXPIRY_DAYS, getMcpSettings, listTokens, revokeToken, setMcpEnabled, TOKEN_NAME_MAX, type McpToken } from '../../mcp/tokens.js';
import { parseKey } from '../../moderation/queue.js';
import { setFlash } from '../session.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { copyBtn, copyField, csrfField, empty, icon, linkBtn, pageHeader, pill, plural, postBtn, selectWrap, submitBtn, switchInput, tag, when } from '../ui.js';

const PLACEHOLDER = 'trm_YOUR_TOKEN';

/** How to add the server to each agent, with the token (or a placeholder). */
function clients(url: string, token: string) {
  return [
    { id: 'claude', name: 'Claude Code', where: html`Run it in a terminal. <code>--scope user</code> adds it for every project; leave it out for this project only.`, text: `claude mcp add --transport http --scope user ticket-relay ${url} --header "Authorization: Bearer ${token}"` },
    { id: 'cursor', name: 'Cursor', where: html`In <code>~/.cursor/mcp.json</code> for every project, or <code>.cursor/mcp.json</code> in one.`, text: JSON.stringify({ mcpServers: { 'ticket-relay': { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2) },
    { id: 'vscode', name: 'VS Code', where: html`In <code>.vscode/mcp.json</code>, or your user configuration (<em>MCP: Open User Configuration</em>).`, text: JSON.stringify({ servers: { 'ticket-relay': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2) },
    { id: 'codex', name: 'Codex', where: html`In <code>~/.codex/config.toml</code>, with the token in the <code>TICKET_RELAY_TOKEN</code> environment variable.`, text: `# In your shell profile: export TICKET_RELAY_TOKEN="${token}"\n[mcp_servers.ticket-relay]\nurl = "${url}"\nbearer_token_env_var = "TICKET_RELAY_TOKEN"` },
    { id: 'other', name: 'Other', where: html`Any agent that connects to remote MCP servers over HTTP (Streamable HTTP).`, text: `URL:    ${url}\nHeader: Authorization: Bearer ${token}` },
  ];
}

function setupTabs(url: string, token: string): SafeHtml {
  const list = clients(url, token);
  return html`<div class="mcp-setup" data-mcp-tabs>
    <div class="seg js-only" role="tablist" aria-label="Your coding agent">${list.map((c, i) => html`<button type="button" class="seg-item" role="tab" id="mcp-tab-${c.id}" aria-controls="mcp-pane-${c.id}" aria-selected="${i === 0 ? 'true' : 'false'}" data-mcp-tab="${c.id}">${c.name}</button>`)}</div>
    ${list.map((c) => html`<div class="mcp-pane" id="mcp-pane-${c.id}" role="tabpanel" aria-labelledby="mcp-tab-${c.id}" data-mcp-pane="${c.id}">
      <div class="nojs mcp-pane-name">${c.name}</div>
      <p class="small muted">${c.where}</p>
      <div class="mcp-code"><pre>${c.text}</pre>${copyBtn(c.text, `Copy the ${c.name} setup`)}</div>
    </div>`)}
  </div>`;
}

function tokenRows(ctx: WorkspaceRequestContext, tokens: McpToken[], o: { everyone: boolean }): SafeHtml {
  const revoke = (t: McpToken) => postBtn(`${ctx.base}/mcp/tokens/${t.id}/revoke`, 'Revoke', ctx.csrf, {
    size: 'sm', variant: 'ghost', loading: 'Revoking…',
    confirm: { title: `Revoke “${t.name}”?`, body: `${o.everyone && t.user_id !== ctx.user.id ? `${t.user_name}’s agent` : 'The agent using it'} loses access on its next call.`, label: 'Revoke', danger: true },
  });
  return html`<div class="table-wrap"><table>
    <thead><tr>${o.everyone ? html`<th>Person</th>` : ''}<th class="col-main">Token</th><th>Last used</th><th class="num">Calls</th><th>Expires</th><th class="actions"><span class="sr-only">Revoke</span></th></tr></thead>
    <tbody>${tokens.map((t) => html`<tr>
      ${o.everyone ? html`<td>${t.user_name}${t.user_id === ctx.user.id ? tag('You', { cls: 'subtle' }) : ''}</td>` : ''}
      <td><div class="cell-title">${t.name}${t.read_only ? tag('Read only', { cls: 'subtle', icon: 'eye' }) : ''}</div><div class="sub"><span class="mono">trm_…${t.hint}</span> · made ${when(t.created_at)}</div></td>
      <td>${t.last_used_at ? html`${when(t.last_used_at)}${t.last_client ? html`<div class="sub">${t.last_client}</div>` : ''}` : html`<span class="muted">Not yet</span>`}</td>
      <td class="num">${t.calls.toLocaleString('en-US')}</td>
      <td>${t.expires_at ? when(t.expires_at) : html`<span class="muted">Never</span>`}</td>
      <td class="actions">${revoke(t)}</td>
    </tr>`)}</tbody></table></div>`;
}

/** Every tool, with whether this person's agent has it. */
function toolsCard(ctx: WorkspaceRequestContext): SafeHtml {
  const m = ctx.membership;
  const admin = m.role !== 'moderator';
  const on = (k: (typeof MCP_SWITCH_KEYS)[number]) => canMcp(m, k);
  const has = new Set(TOOLS.filter((t) => !t.switch || on(t.switch) || (t.name === 'undo' && (on('close_ticket') || on('post_reply')))).map((t) => t.name));
  const prompts = PROMPTS.filter((p) => p.needs.every((n) => has.has(n)));
  return html`<div class="card" id="tools">
    <div class="card-h"><div><h2>What your agent can do</h2><div class="desc">${admin
      ? 'Admins and owners have every tool. Choose each moderator’s on Members & permissions.'
      : html`${plural(mcpSwitches(m).length, 'tool')} of ${String(MCP_SWITCH_KEYS.length)} switched on for you. Ask an admin if you need another.`}</div></div>
      ${can(m, 'manage') ? linkBtn(`${ctx.base}/members#moderator-access`, 'Moderators’ tools', { size: 'sm', icon: 'users' }) : ''}</div>
    ${MCP_GROUPS.map((g) => html`<div class="sub-h">${g.name}<span class="muted"> · ${g.desc}</span></div>
      <ul class="mcp-tools">${MCP_SWITCH_KEYS.filter((k) => MCP_SWITCHES[k].group === g.key).map((k) => html`<li class="${on(k) ? 'on' : 'off'}">
        ${icon(on(k) ? 'circle-check' : 'lock', 16, on(k) ? 'ok' : 'faint')}
        <div><div class="n">${MCP_SWITCHES[k].name}<span class="mono xs muted"> ${TOOLS.filter((t) => t.switch === k).map((t) => t.name).join(', ')}</span></div><div class="d">${MCP_SWITCHES[k].desc}</div></div>
      </li>`)}</ul>`)}
    <div class="sub-h">Ready-made prompts<span class="muted"> · slash commands in Claude Code, like /mcp__ticket-relay__pick_up</span></div>
    ${prompts.length
      ? html`<ul class="mcp-tools">${prompts.map((p) => html`<li class="on">${icon('square-terminal', 16, 'muted')}<div><div class="n">${p.title}<span class="mono xs muted"> ${p.name}</span></div><div class="d">${p.description}</div></div></li>`)}</ul>`
      : html`<p class="card-b small muted">None with your tools.</p>`}
  </div>`;
}

export function registerMcpRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;
  const url = web.publicUrl('/mcp');

  async function renderMcp(ctx: WorkspaceRequestContext, reply: FastifyReply, o: { created?: { token: string; row: McpToken } } = {}) {
    const wid = ctx.workspace.id;
    const admin = can(ctx.membership, 'manage');
    const settings = await getMcpSettings(deps.db, wid);
    const header = pageHeader({
      title: 'MCP',
      after: settings.enabled ? pill('On', 'ok') : pill('Off', 'neutral'),
      description: 'Connect coding agents (Claude Code, Cursor, VS Code, Codex) to this workspace’s tickets. They find, read and work on them with the tools you were given, as you.',
    });
    if (!settings.enabled) {
      const body = html`${header}<div class="card">${empty('plug', 'MCP is off', admin
        ? 'Turn it on to let the team connect their coding agents. Moderators get no tools until you switch them on, one by one, in Members & permissions. Admins and owners can use every tool.'
        : 'An admin hasn’t turned it on yet.', admin ? postBtn(`${ctx.base}/mcp/enable`, 'Turn on MCP', ctx.csrf, { variant: 'primary', fields: { on: '1' } }) : null)}</div>
        ${toolsCard(ctx)}`;
      return web.render(reply, ctx, 'MCP', 'mcp', body);
    }

    const [mine, everyone, claims, apps] = await Promise.all([
      listTokens(deps.db, wid, ctx.user.id),
      admin ? listTokens(deps.db, wid) : Promise.resolve([]),
      activeClaims(deps.db, wid),
      listApps(deps.db, wid),
    ]);
    const acts = MCP_SWITCH_KEYS.some((k) => MCP_SWITCHES[k].group !== 'read' && canMcp(ctx.membership, k));
    const created = o.created
      ? html`<div class="card" id="new-token">
          <div class="card-h"><div><h2>Your new token: ${o.created.row.name}</h2><div class="desc">Copy it now. It won’t be shown again; if you lose it, make another and revoke this one.</div></div></div>
          <div class="card-b stack">
            ${copyField('mcp-token', o.created.token, 'Token')}
            ${setupTabs(url, o.created.token)}
            <p class="small muted">Then ask your agent, for example: “Use Ticket Relay to pick up the most urgent ticket in this app.”</p>
          </div>
        </div>`
      : '';
    const days = [...EXPIRY_DAYS.map((d) => ({ value: String(d), label: d === 365 ? '1 year' : `${d} days` })), ...(admin ? [{ value: 'never', label: 'Never' }] : [])];
    const createForm = html`<form method="post" action="${ctx.base}/mcp/tokens" class="mcp-new">${csrfField(ctx.csrf)}
      <div class="field"><label for="mcp-name">Name</label><input id="mcp-name" type="text" name="name" maxlength="${String(TOKEN_NAME_MAX)}" placeholder="Laptop, Claude Code" required><div class="hint">To tell your tokens apart: one per device.</div></div>
      <div class="field"><label for="mcp-days">Expires after</label>${selectWrap(html`<select id="mcp-days" name="days">${days.map((d) => html`<option value="${d.value}" ${d.value === String(DEFAULT_EXPIRY_DAYS) ? raw('selected') : ''}>${d.label}</option>`)}</select>`)}</div>
      ${acts ? html`<label class="mcp-ro">${switchInput({ name: 'read_only', checked: false, label: 'Read only' })}<span><span class="lbl">Read only</span><span class="hint">Can’t close, label or reply, even though you can. For agents that run on their own.</span></span></label>` : ''}
      <div class="mcp-new-go">${submitBtn('Create token', { variant: 'primary', icon: 'key-round', loading: 'Creating…' })}</div>
    </form>`;
    const connect = html`<div class="card" id="connect">
      <div class="card-h"><div><h2>Connect your agent</h2><div class="desc">Make a token, then add Ticket Relay to your agent with it. Your agent can do what your tools allow, as you; everything it changes is in the Mod log.</div></div></div>
      <div class="card-b stack">
        <div class="field"><label for="mcp-url">Server address</label>${copyField('mcp-url', url, 'Server address')}</div>
        ${createForm}
      </div>
      ${mine.length ? html`<div class="sub-h">Your tokens · ${String(mine.length)}</div>${tokenRows(ctx, mine, { everyone: false })}` : ''}
      ${o.created ? '' : html`<details class="mcp-how"><summary>${icon('chevron-right', 14, 'chev')}How to add it to Claude Code, Cursor, VS Code or Codex</summary><div class="card-b">${setupTabs(url, PLACEHOLDER)}</div></details>`}
    </div>`;

    const refOf = (repoId: number, number: number) => {
      const a = apps.find((x) => x.repo_id === repoId);
      return a ? `${a.repo_name}#${number}` : `#${number}`;
    };
    const claimsCard = html`<div class="card" id="claims">
      <div class="card-h"><div><h2>Claimed tickets</h2><div class="desc">“I’m on it”, from agents’ claim_ticket. Up to ${String(MAX_CLAIMS)} per person; a claim lapses after ${String(CLAIM_DAYS)} days unread unless a pull request for it is open, and ends when the ticket closes. Nothing is written to GitHub.</div></div></div>
      ${claims.length
        ? html`<div class="table-wrap"><table><thead><tr><th class="col-main">Ticket</th><th>Who</th><th>Since</th><th>Pull request</th><th class="actions"><span class="sr-only">Release</span></th></tr></thead>
          <tbody>${claims.map((c) => html`<tr>
            <td><div class="cell-title">${c.title ?? `#${c.number}`}</div><div class="sub"><span class="mono">${refOf(c.repo_id, c.number)}</span>${c.note ? html` · ${c.note}` : ''}</div></td>
            <td>${c.user_name ?? 'Someone'}${c.user_id === ctx.user.id ? tag('You', { cls: 'subtle' }) : ''}</td>
            <td>${when(c.claimed_at)}</td>
            <td>${c.pr ? html`<span class="mono">#${String(c.pr)}</span> open` : html`<span class="muted">None</span>`}</td>
            <td class="actions">${admin || c.user_id === ctx.user.id ? postBtn(`${ctx.base}/mcp/claims/release`, 'Release', ctx.csrf, { size: 'sm', variant: 'ghost', fields: { item: `${c.repo_id}-${c.number}` }, loading: 'Releasing…' }) : ''}</td>
          </tr>`)}</tbody></table></div>`
        : html`<div class="card-b small muted">Nothing is claimed.</div>`}
    </div>`;

    const adminCards = admin
      ? html`<div class="card" id="all-tokens">
          <div class="card-h"><div><h2>Everyone’s tokens</h2><div class="desc">Tokens that work now. Removing someone from the workspace revokes theirs.</div></div></div>
          ${everyone.length ? tokenRows(ctx, everyone, { everyone: true }) : html`<div class="card-b small muted">Nobody has made a token yet.</div>`}
        </div>
        <div class="card">
          <div class="card-b row"><div class="grow"><div class="lbl">Turn off MCP</div><div class="small muted">Every agent loses access on its next call. Tokens and claims are kept for when it’s back on.</div></div>
            ${postBtn(`${ctx.base}/mcp/enable`, 'Turn off', ctx.csrf, { fields: { on: '0' }, confirm: { title: 'Turn off MCP?', body: 'Every coding agent connected to this workspace loses access right away.', label: 'Turn off', danger: true } })}</div>
        </div>`
      : '';

    const body = html`${header}${created}${connect}${toolsCard(ctx)}${claimsCard}${adminCards}`;
    return web.render(reply, ctx, 'MCP', 'mcp', body);
  }

  /** Any member who can use MCP (owners, admins, and moderators with a tool); 403 otherwise. */
  async function requireMcp(req: Parameters<Web['requireWorkspace']>[0], reply: FastifyReply): Promise<WorkspaceRequestContext | null> {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'view' });
    if (!ctx) return null;
    if (canUseMcp(ctx.membership)) return ctx;
    reply.code(403);
    web.render(reply, ctx, 'No access', 'mcp', html`${pageHeader({ title: 'MCP' })}<div class="card">${empty('lock', 'You don’t have any MCP tools', 'An admin can switch tools on for you in Members & permissions.', linkBtn(ctx.base, 'Go to overview'))}</div>`);
    return null;
  }

  app.get('/w/:wid/mcp', async (req, reply) => {
    const ctx = await requireMcp(req, reply);
    if (!ctx) return reply;
    return renderMcp(ctx, reply);
  });

  app.post('/w/:wid/mcp/enable', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'manage' });
    if (!ctx) return reply;
    const on = (req.body as { on?: string }).on === '1';
    await setMcpEnabled(deps.db, ctx.workspace.id, on, ctx.user.id);
    setFlash(reply, 'success', on ? 'MCP is on. Make a token below, and switch tools on for moderators in Members & permissions.' : 'MCP is off. Connected agents lose access on their next call.');
    return reply.redirect(`${ctx.base}/mcp`);
  });

  app.post('/w/:wid/mcp/tokens', async (req, reply) => {
    const ctx = await requireMcp(req, reply);
    if (!ctx) return reply;
    const body = (req.body ?? {}) as { name?: string; days?: string; read_only?: string };
    try {
      if (!(await getMcpSettings(deps.db, ctx.workspace.id)).enabled) throw new UserFacingError('MCP is off. An admin can turn it on.');
      const never = body.days === 'never' && can(ctx.membership, 'manage');
      const days = never ? null : (EXPIRY_DAYS as readonly number[]).includes(Number(body.days)) ? Number(body.days) : DEFAULT_EXPIRY_DAYS;
      const created = await createToken(deps.db, ctx.workspace.id, ctx.user.id, { name: String(body.name ?? ''), readOnly: body.read_only === '1', days });
      // Shown once, on this page (not after a redirect).
      reply.header('Cache-Control', 'no-store');
      return renderMcp(ctx, reply, { created });
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
      return reply.redirect(`${ctx.base}/mcp`);
    }
  });

  app.post('/w/:wid/mcp/tokens/:id/revoke', async (req, reply) => {
    const ctx = await requireMcp(req, reply);
    if (!ctx) return reply;
    try {
      const admin = can(ctx.membership, 'manage');
      const t = await revokeToken(deps.db, ctx.workspace.id, (req.params as { id: string }).id, ctx.user.id, admin ? {} : { ownerId: ctx.user.id });
      setFlash(reply, 'success', `Revoked “${t.name}”${t.user_id !== ctx.user.id ? ` (${t.user_name})` : ''}. The agent using it loses access on its next call.`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/mcp`);
  });

  app.post('/w/:wid/mcp/claims/release', async (req, reply) => {
    const ctx = await requireMcp(req, reply);
    if (!ctx) return reply;
    try {
      const key = parseKey((req.body as { item?: string }).item) ?? (() => { throw new UserFacingError('Pick a claimed ticket.'); })();
      const c = await releaseClaim(deps.db, ctx.workspace.id, key, ctx.user.id, { admin: can(ctx.membership, 'manage') });
      setFlash(reply, 'success', `Released ${c.title ? `“${c.title}”` : `#${c.number}`}${c.user_id !== ctx.user.id ? ` from ${c.user_name ?? 'them'}` : ''}.`);
    } catch (err) {
      if (!(err instanceof UserFacingError)) throw err;
      setFlash(reply, 'error', err.message);
    }
    return reply.redirect(`${ctx.base}/mcp#claims`);
  });
}
