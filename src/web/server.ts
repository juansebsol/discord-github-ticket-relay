import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { safeEqual } from '../lib/crypto.js';
import { html } from '../lib/html.js';
import type { Processor } from '../domain/processor.js';
import { getDiscordConnection, getGitHubConnection, getPanel, listApps } from '../domain/store.js';
import { UserFacingError, type Deps, type Role } from '../domain/types.js';
import { getMembership, listMemberships, type Membership } from '../domain/workspaces.js';
import { layout, simplePage, type PageContext, type SetupProgress } from './layout.js';
import { loadSession, SESSION_COOKIE, takeFlash, type AuthContext } from './session.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { registerGitHubRoutes } from './routes/github.js';
import { registerDiscordRoutes } from './routes/discord.js';
import { registerAppRoutes } from './routes/apps.js';
import { registerPanelRoutes } from './routes/panel.js';
import { registerSubmissionRoutes } from './routes/submissions.js';
import { registerContributorRoutes } from './routes/contributors.js';
import { registerTicketTypeRoutes } from './routes/ticket-types.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    rawBody?: string;
  }
}

export interface WorkspaceRequestContext extends PageContext {
  workspace: NonNullable<PageContext['workspace']>;
  role: Role;
  base: string;
  membership: Membership;
}

export interface Web {
  deps: Deps;
  processor: Processor;
  /** Requires a signed-in user; redirects to sign-in otherwise. */
  requireUser(req: FastifyRequest, reply: FastifyReply): AuthContext | null;
  /** Requires membership of the workspace in the URL (404 for non-members, to avoid leaking existence). */
  requireWorkspace(req: FastifyRequest, reply: FastifyReply, opts?: { owner?: boolean }): Promise<WorkspaceRequestContext | null>;
  pageContext(req: FastifyRequest, reply: FastifyReply): PageContext;
  render(reply: FastifyReply, ctx: PageContext, title: string, active: string, body: ReturnType<typeof html>): FastifyReply;
  publicUrl(p: string): string;
  secureCookies: boolean;
}

export async function computeProgress(deps: Deps, workspaceId: string): Promise<SetupProgress> {
  const [gh, dc, apps, panel, attention] = await Promise.all([
    getGitHubConnection(deps.db, workspaceId),
    getDiscordConnection(deps.db, workspaceId),
    listApps(deps.db, workspaceId),
    getPanel(deps.db, workspaceId),
    deps.db.query<{ n: number }>(`SELECT count(*) AS n FROM submissions WHERE workspace_id = $1 AND status IN ('failed', 'uncertain')`, [workspaceId]),
  ]);
  return {
    github: !gh ? 'todo' : gh.status === 'active' ? 'done' : 'problem',
    discord: !dc ? 'todo' : dc.status !== 'active' ? 'problem' : dc.tickets_channel_id ? 'done' : 'todo',
    apps: apps.some((a) => a.enabled) ? 'done' : 'todo',
    panel: !panel ? 'todo' : panel.status === 'missing' ? 'problem' : 'done',
    attention: attention.rows[0]!.n,
  };
}

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

export async function buildServer(deps: Deps, processor: Processor, opts: { logger?: boolean | object } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: deps.config.trustProxy,
    bodyLimit: 256 * 1024,
  });

  // Keep the raw body for signature verification (Discord, GitHub webhooks).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      const err = new Error('Invalid JSON') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(fastifyStatic, { root: STATIC_DIR, prefix: '/static/', maxAge: '1h' });

  const secureCookies = deps.config.publicUrl.startsWith('https://');

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: https://cdn.discordapp.com https://avatars.githubusercontent.com; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://discord.com https://github.com",
    );
    if (secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
    req.auth = await loadSession(deps.db, req.cookies[SESSION_COOKIE]);
  });

  // CSRF protection for every browser form post. Webhooks authenticate by signature instead.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'POST') return;
    const url = req.url.split('?')[0]!;
    if (url === '/discord/interactions' || url === '/github/webhook') return;
    // Local-only development sign-in has no session yet (never registered in production).
    if (url === '/dev-login' && deps.config.devLogin) return;
    const token = (req.body as Record<string, unknown> | undefined)?._csrf;
    if (!req.auth || typeof token !== 'string' || !safeEqual(token, req.auth.session.csrf_token)) {
      reply.code(403).type('text/html').send(simplePage('Session expired', html`<h1>Your session expired</h1><p class="muted">For your security this action was not performed. Go back, reload the page and try again.</p><a class="btn" href="/">Back to the app</a>`));
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof UserFacingError) {
      reply.code(err.status).type('text/html').send(simplePage('Something went wrong', html`<h1>Something went wrong</h1><p>${err.message}</p><a class="btn" href="/">Back to the app</a>`));
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'request failed');
    reply.code(status).type('text/html').send(
      simplePage('Something went wrong', html`<h1>${status >= 500 ? 'Something went wrong on our side' : 'That request could not be handled'}</h1><p class="muted">Please try again. If it keeps happening, check the server logs.</p><a class="btn" href="/">Back to the app</a>`),
    );
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).type('text/html').send(simplePage('Not found', html`<h1>Page not found</h1><p class="muted">It may have moved, or you may not have access to it.</p><a class="btn" href="/">Back to the app</a>`));
  });

  const web: Web = {
    deps,
    processor,
    secureCookies,
    publicUrl: (p) => `${deps.config.publicUrl}${p}`,
    requireUser(req, reply) {
      if (!req.auth) {
        reply.redirect('/login');
        return null;
      }
      return req.auth;
    },
    pageContext(req, reply) {
      return { user: req.auth!.user, csrf: req.auth!.session.csrf_token, flash: takeFlash(req, reply) };
    },
    async requireWorkspace(req, reply, o = {}) {
      const auth = web.requireUser(req, reply);
      if (!auth) return null;
      const wid = (req.params as { wid?: string }).wid ?? '';
      const membership = await getMembership(deps.db, auth.user.id, wid);
      if (!membership || (o.owner && membership.role !== 'owner')) {
        reply.callNotFound();
        return null;
      }
      const [memberships, progress] = await Promise.all([listMemberships(deps.db, auth.user.id), computeProgress(deps, wid)]);
      return {
        ...web.pageContext(req, reply),
        workspace: membership.workspace,
        role: membership.role,
        memberships,
        progress,
        membership,
        base: `/w/${membership.workspace.id}`,
      };
    },
    render(reply, ctx, title, active, body) {
      return reply.type('text/html').send(layout(ctx, { title, active, body }));
    },
  };

  app.get('/healthz', async (_req, reply) => {
    try {
      await deps.db.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  registerWebhookRoutes(app, web);
  registerAuthRoutes(app, web);
  registerWorkspaceRoutes(app, web);
  registerGitHubRoutes(app, web);
  registerDiscordRoutes(app, web);
  registerAppRoutes(app, web);
  registerPanelRoutes(app, web);
  registerSubmissionRoutes(app, web);
  registerContributorRoutes(app, web);
  registerTicketTypeRoutes(app, web);

  return app;
}
