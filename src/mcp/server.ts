/**
 * The MCP endpoint: POST /mcp, the Streamable HTTP transport without sessions (each request
 * stands alone and is answered with JSON), authenticated by a personal bearer token. It speaks
 * JSON-RPC: initialize, ping, tools/list, tools/call, prompts/list and prompts/get. There's no
 * event stream (GET answers 405), and nothing here reads or writes anything the tools don't.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { listApps } from '../domain/store.js';
import type { Deps } from '../domain/types.js';
import { getModerationSettings, type ModerationSettings } from '../moderation/settings.js';
import type { QueueLabels } from '../moderation/queue.js';
import type { TriageEngine } from '../triage/engine.js';
import { instructions, PROMPTS } from './prompts.js';
import { authenticate, touchToken, type McpCaller } from './tokens.js';
import { MCP_SWITCHES } from '../domain/permissions.js';
import { moderationLabels, toolAllowed, toolByName, toolError, TOOLS, type McpContext, type ToolDef, type ToolResult } from './tools.js';

/** Newest first; a client asking for another version gets the newest. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_VERSION = '1.0.0';

/** Per token, per minute: requests, tool calls, and actions on GitHub. */
export const LIMITS = { requests: 240, calls: 120, actions: 20 } as const;
const WINDOW_MS = 60_000;

interface RpcRequest {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: any;
}
type RpcResponse = { jsonrpc: '2.0'; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

const rpcError = (id: string | number | null, code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Sliding one-minute counts per token (one web process, so memory is enough). */
const recent = new Map<string, number[]>();
function overLimit(key: string, max: number, now = Date.now()): boolean {
  const times = (recent.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= max) {
    recent.set(key, times);
    return true;
  }
  times.push(now);
  recent.set(key, times);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, times] of recent) if (!times.some((t) => now - t < WINDOW_MS)) recent.delete(k);
}, WINDOW_MS).unref();

/** For tests: forget the counts. */
export function resetMcpLimits(): void {
  recent.clear();
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h.trim()) : null;
  return m ? m[1]! : null;
}

function wireTool(t: ToolDef, schema: z.ZodObject) {
  const { $schema: _drop, ...inputSchema } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return { name: t.name, title: t.annotations.title, description: t.description, inputSchema, annotations: t.annotations };
}

export function registerMcpEndpoint(app: FastifyInstance, deps: Deps, triage: TriageEngine): void {
  const origin = new URL(deps.config.publicUrl).origin;

  function context(caller: McpCaller, apps: Awaited<ReturnType<typeof listApps>>): McpContext {
    let moderation: Promise<ModerationSettings> | null = null;
    let labels: Promise<QueueLabels> | null = null;
    const ctx: McpContext = {
      deps,
      triage,
      workspaceId: caller.token.workspace_id,
      workspaceName: caller.membership.workspace.name,
      userId: caller.token.user_id,
      userName: caller.token.user_name,
      membership: caller.membership,
      readOnly: caller.token.read_only,
      apps,
      moderation: () => (moderation ??= getModerationSettings(deps.db, caller.token.workspace_id)),
      labels: () => (labels ??= moderationLabels(ctx)),
    };
    return ctx;
  }

  async function callTool(ctx: McpContext, caller: McpCaller, params: any): Promise<ToolResult> {
    const tool = toolByName(params?.name);
    if (!tool || !toolAllowed(ctx, tool)) {
      const why = !tool ? `There’s no tool “${String(params?.name)}”.` : caller.token.read_only && tool.switch && MCP_SWITCHES[tool.switch].group !== 'read' ? 'This token is read-only.' : `${ctx.userName}’s access doesn’t include ${tool.name}. An admin can switch it on in Members & permissions › MCP.`;
      return { content: [{ type: 'text', text: why }], isError: true };
    }
    const id = caller.token.id;
    if (overLimit(`${id}:calls`, LIMITS.calls)) return { content: [{ type: 'text', text: `Over ${LIMITS.calls} calls a minute. Wait a minute and try again.` }], isError: true };
    if (!tool.annotations.readOnlyHint && overLimit(`${id}:actions`, LIMITS.actions)) return { content: [{ type: 'text', text: `Over ${LIMITS.actions} changes a minute. Wait a minute and try again.` }], isError: true };
    const parsed = (await tool.input(ctx)).safeParse(params?.arguments ?? {});
    if (!parsed.success) return { content: [{ type: 'text', text: `The arguments don’t fit ${tool.name}:\n${z.prettifyError(parsed.error)}` }], isError: true };
    const started = Date.now();
    await touchToken(deps.db, id, null);
    try {
      const result = await tool.run(ctx, parsed.data);
      deps.log.info({ mcp: tool.name, workspace: ctx.workspaceId, user: ctx.userId, ms: Date.now() - started }, 'mcp tool call');
      return result;
    } catch (err) {
      const shown = toolError(err);
      deps.log[shown ? 'info' : 'error']({ mcp: tool.name, workspace: ctx.workspaceId, user: ctx.userId, ms: Date.now() - started, err: (err as Error).message, ...(shown ? {} : { stack: (err as Error).stack }) }, 'mcp tool call failed');
      return shown ?? { content: [{ type: 'text', text: 'Something went wrong on the server. It’s been logged; try again, or another way.' }], isError: true };
    }
  }

  async function handle(msg: RpcRequest, caller: McpCaller, ctx: () => Promise<McpContext>): Promise<RpcResponse | null> {
    const id = msg.id === undefined ? undefined : msg.id;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return id === undefined ? null : rpcError(id ?? null, -32600, 'Invalid request');
    // Notifications (initialized, cancelled) need no answer.
    if (id === undefined) return null;
    const ok = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        const client = msg.params?.clientInfo;
        await touchToken(deps.db, caller.token.id, typeof client?.name === 'string' ? `${client.name}${typeof client.version === 'string' ? ` ${client.version}` : ''}` : null);
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'ticket-relay', title: 'Ticket Relay', version: SERVER_VERSION },
          instructions: instructions({ user: caller.token.user_name, workspace: caller.membership.workspace.name }),
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list': {
        const c = await ctx();
        const tools = [];
        for (const t of TOOLS.filter((x) => toolAllowed(c, x))) tools.push(wireTool(t, await t.input(c)));
        return ok({ tools });
      }
      case 'tools/call':
        return ok(await callTool(await ctx(), caller, msg.params));
      case 'prompts/list': {
        const c = await ctx();
        const can = new Set(TOOLS.filter((t) => toolAllowed(c, t)).map((t) => t.name));
        return ok({ prompts: PROMPTS.filter((p) => p.needs.every((n) => can.has(n))).map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.args })) });
      }
      case 'prompts/get': {
        const c = await ctx();
        const can = new Set(TOOLS.filter((t) => toolAllowed(c, t)).map((t) => t.name));
        const p = PROMPTS.find((x) => x.name === msg.params?.name && x.needs.every((n) => can.has(n)));
        if (!p) return rpcError(id, -32602, `There’s no prompt “${String(msg.params?.name)}”.`);
        const args = Object.fromEntries(Object.entries((msg.params?.arguments ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '').slice(0, 300)]));
        const missing = p.args.filter((x) => x.required && !args[x.name]?.trim());
        if (missing.length) return rpcError(id, -32602, `${p.name} needs ${missing.map((x) => x.name).join(', ')}.`);
        return ok({ description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(args) } }] });
      }
      default:
        return rpcError(id, -32601, `Method not found: ${msg.method}`);
    }
  }

  async function post(req: FastifyRequest, reply: FastifyReply) {
    // Agents don't send an Origin; a web page elsewhere does, and isn't let in.
    const from = req.headers.origin;
    if (from && from !== origin) return reply.code(403).send(rpcError(null, -32000, 'This origin isn’t allowed.'));
    const caller = await authenticate(deps.db, bearer(req));
    if (typeof caller === 'string') {
      if (caller === 'off') return reply.code(403).send(rpcError(null, -32001, 'MCP is off in this workspace. An admin can turn it on in the console, under MCP.'));
      reply.header('WWW-Authenticate', `Bearer realm="Ticket Relay"${caller === 'invalid' ? ', error="invalid_token"' : ''}`);
      return reply.code(401).send(rpcError(null, -32001, caller === 'missing'
        ? 'Send your Ticket Relay token as Authorization: Bearer trm_… (make one in the console, under MCP).'
        : 'This token doesn’t work: it’s revoked or expired, or its person is no longer a member. Make a new one in the console, under MCP.'));
    }
    if (overLimit(`${caller.token.id}:requests`, LIMITS.requests)) return reply.code(429).header('Retry-After', '60').send(rpcError(null, -32002, 'Too many requests. Wait a minute.'));
    const body = req.body as RpcRequest | RpcRequest[] | undefined;
    const batch = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
    if (!batch.length || batch.length > 20) return reply.code(400).send(rpcError(null, -32600, 'Invalid request'));
    let ctx: Promise<McpContext> | null = null;
    const lazy = () => (ctx ??= listApps(deps.db, caller.token.workspace_id).then((apps) => context(caller, apps)));
    const answers = (await Promise.all(batch.map((m) => handle(m, caller, lazy)))).filter((r): r is RpcResponse => r !== null);
    if (!answers.length) return reply.code(202).send();
    return reply.type('application/json').send(Array.isArray(body) ? answers : answers[0]);
  }

  app.post('/mcp', post);
  // No server-to-client stream, and no sessions to end.
  const notHere = async (_req: FastifyRequest, reply: FastifyReply) => reply.code(405).header('Allow', 'POST').send(rpcError(null, -32000, 'Only POST is supported here.'));
  app.get('/mcp', notHere);
  app.delete('/mcp', notHere);
}
