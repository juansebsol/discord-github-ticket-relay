import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { safeEqual } from '../lib/crypto.js';
import { html } from '../lib/html.js';
import { empty, linkBtn, pageHeader } from './ui.js';
import type { Processor } from '../domain/processor.js';
import type { TriageEngine } from '../triage/engine.js';
import { runShown } from '../triage/knowledge-runs.js';
import { getDiscordConnection, getGitHubConnection, getPanel, listApps } from '../domain/store.js';
import { UserFacingError, type Deps, type Role } from '../domain/types.js';
import { getMembership, listMemberships, type Membership } from '../domain/workspaces.js';
import { areaLabel, can, isArea, type Permission } from '../domain/permissions.js';
import { layout, simplePage, type PageContext, type PageWidth, type SetupProgress } from './layout.js';
import { loadSession, SESSION_COOKIE, takeFlash, type AuthContext } from './session.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { registerGitHubRoutes } from './routes/github.js';
import { registerDiscordRoutes } from './routes/discord.js';
import { registerAppRoutes } from './routes/apps.js';
import { registerPanelRoutes } from './routes/panel.js';
import { registerTicketRoutes } from './routes/tickets.js';
import { registerMemberRoutes } from './routes/members.js';
import { registerLegalRoutes } from './routes/legal.js';
import { registerTriageRoutes } from './routes/triage.js';
import { registerTriageConfigRoutes } from './routes/triage-config.js';
import { registerTriageKnowledgeRoutes } from './routes/triage-knowledge.js';
import { registerRepoStatusRoutes } from './routes/repo-status.js';
import { registerAnalyticsRoutes } from './routes/analytics.js';
import { registerTriageRunRoutes } from './routes/triage-runs.js';
import { registerTriageActivityRoutes } from './routes/triage-activity.js';
import { registerTriageBulkRoutes } from './routes/triage-bulk.js';
import { registerContributorRoutes } from './routes/contributors.js';
import { registerAnnouncementRoutes } from './routes/announcements.js';
import { registerBotFeatureRoutes } from './routes/bot-features.js';
import { registerBotRoutes } from './routes/bot.js';
import { registerTicketTypeRoutes } from './routes/ticket-types.js';
import { registerFileRoutes, UPLOAD_ROUTE } from './routes/files.js';
import { registerIssueRoutes } from './routes/issues.js';
import { registerIssueTriageRoutes } from './routes/issue-triage.js';
import { registerClaudeRoutes } from './routes/claude.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerTriageReviewRoutes } from './routes/triage-review.js';
import { registerTriageOverviewRoutes } from './routes/triage-overview.js';
import { registerReleaseRoutes } from './routes/releases.js';
import { registerModerationRoutes } from './routes/moderation.js';
import { registerMovedRoutes } from './routes/tool.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerMcpEndpoint } from '../mcp/server.js';
import { MAX_FILE_BYTES } from '../domain/files.js';

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
  triage: TriageEngine;
  /** Requires a signed-in user; redirects to sign-in otherwise. */
  requireUser(req: FastifyRequest, reply: FastifyReply): AuthContext | null;
  /**
   * Requires membership of the workspace in the URL (404 for non-members, to avoid leaking
   * existence) and a permission (any one of a list). Secure by default: without `permission`
   * the route needs "manage" (owners and admins), so moderators are only let in where a route opts in.
   */
  requireWorkspace(req: FastifyRequest, reply: FastifyReply, opts?: { permission?: Permission | Permission[] }): Promise<WorkspaceRequestContext | null>;
  pageContext(req: FastifyRequest, reply: FastifyReply): PageContext;
  /** `width: 'full'` is for pages that are mostly a table or list: they use the whole window. Other pages keep a readable width. */
  render(reply: FastifyReply, ctx: PageContext, title: string, active: string, body: ReturnType<typeof html>, o?: { width?: PageWidth }): FastifyReply;
  /** True when the request came from app.js and expects a JSON reply (switches that save right away). */
  wantsJson(req: FastifyRequest): boolean;
  publicUrl(p: string): string;
  secureCookies: boolean;
}

export async function computeProgress(deps: Deps, workspaceId: string): Promise<SetupProgress> {
  const [gh, dc, apps, panel, attention, dev, review, knowledgeRun] = await Promise.all([
    getGitHubConnection(deps.db, workspaceId),
    getDiscordConnection(deps.db, workspaceId),
    listApps(deps.db, workspaceId),
    getPanel(deps.db, workspaceId),
    deps.db.query<{ n: number }>(`SELECT count(*) AS n FROM submissions WHERE workspace_id = $1 AND status IN ('failed', 'uncertain')`, [workspaceId]),
    deps.db.query<{ on: number }>('SELECT dev_mode_on_at IS NOT NULL AS "on" FROM server_settings WHERE id = 1'),
    // Tickets and issues opened on GitHub with triage suggestions waiting (AI triage › Review), counted
    // from the waiting indexes. Issues only in repositories the workspace still has an app for.
    deps.db.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM triage_results WHERE workspace_id = $1 AND status = 'done' AND suggestion_count > 0)
         + (SELECT count(*) FROM issue_triage t WHERE t.workspace_id = $1 AND t.status = 'done' AND t.suggestion_count > 0
              AND EXISTS (SELECT 1 FROM apps a WHERE a.workspace_id = t.workspace_id AND a.repo_id = t.repo_id)) AS n`,
      [workspaceId],
    ),
    // Claude writing TRIAGE.md files (AI triage › Knowledge): pages show the Live studio's pill.
    runShown(deps.db, workspaceId),
  ]);
  return {
    github: !gh ? 'todo' : gh.status === 'active' ? 'done' : 'problem',
    discord: !dc ? 'todo' : dc.status !== 'active' ? 'problem' : 'done',
    apps: apps.some((a) => a.enabled) ? 'done' : 'todo',
    panel: !panel ? 'todo' : panel.status === 'missing' ? 'problem' : 'done',
    attention: attention.rows[0]!.n,
    review: Number(review.rows[0]?.n ?? 0),
    devMode: Boolean(dev.rows[0]?.on),
    knowledgeRun,
  };
}

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

export async function buildServer(deps: Deps, processor: Processor, opts: { logger?: boolean | object; triage: TriageEngine }): Promise<FastifyInstance> {
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
  // File uploads (only the ticket "Add files" form); each file is read one at a time.
  // A file over the limit is cut off and reported, without failing the other files in the form.
  await app.register(multipart, { throwFileSizeLimit: false, limits: { fileSize: MAX_FILE_BYTES, files: 10, fields: 4, parts: 16, fieldSize: 1024 } });
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
    // Coding agents authenticate with a bearer token (mcp/server.ts), never a cookie.
    if (url === '/mcp') return;
    // Local-only development sign-in has no session yet (never registered in production).
    if (url === '/dev-login' && deps.config.devLogin) return;
    // The upload form's token is the first form field; that route checks it before reading any file.
    if (req.isMultipart() && UPLOAD_ROUTE.test(url)) return;
    const token = (req.body as Record<string, unknown> | undefined)?._csrf;
    if (!req.auth || typeof token !== 'string' || !safeEqual(token, req.auth.session.csrf_token)) {
      reply.code(403).type('text/html').send(simplePage('Session expired', html`<h1>Your session expired</h1><p class="muted">For your security this action wasn’t performed. Go back, reload the page and try again.</p>${linkBtn('/', 'Back to the app', { block: true })}`));
    }
  });

  app.setErrorHandler((err, req, reply) => {
    // Coding agents get JSON-RPC, not a page (a body that isn't JSON, say).
    if (req.url.split('?')[0] === '/mcp') {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      if (status >= 500) req.log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'mcp request failed');
      reply.code(status).send({ jsonrpc: '2.0', id: null, error: { code: status === 400 ? -32700 : -32603, message: status === 400 ? 'Parse error' : 'Internal error' } });
      return;
    }
    if (err instanceof UserFacingError) {
      reply.code(err.status).type('text/html').send(simplePage('Something went wrong', html`<h1>Something went wrong</h1><p class="muted">${err.message}</p>${linkBtn('/', 'Back to the app', { block: true })}`));
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'request failed');
    reply.code(status).type('text/html').send(
      simplePage('Something went wrong', html`<h1>${status >= 500 ? 'Something went wrong on our side' : 'That request couldn’t be handled'}</h1><p class="muted">Please try again. If it keeps happening, check the server logs.</p>${linkBtn('/', 'Back to the app', { block: true })}`),
    );
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).type('text/html').send(simplePage('Not found', html`<h1>Page not found</h1><p class="muted">It may have moved, or you may not have access to it.</p>${linkBtn('/', 'Back to the app', { block: true })}`));
  });

  const web: Web = {
    deps,
    processor,
    triage: opts.triage,
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
      if (!membership) {
        reply.callNotFound();
        return null;
      }
      const permissions = [o.permission ?? 'manage'].flat();
      if (!permissions.some((p) => can(membership, p))) {
        reply.code(403);
        if (web.wantsJson(req)) {
          reply.send({ ok: false, error: 'You don’t have permission to change this.' });
          return null;
        }
        const ctx = { ...web.pageContext(req, reply), workspace: membership.workspace, role: membership.role, membership, base: `/w/${membership.workspace.id}`, memberships: await listMemberships(deps.db, auth.user.id), progress: await computeProgress(deps, wid) };
        // A page admins can open to moderators: say which one, and what access it needs.
        const grant = permissions.map((p) => /^(.+)\.(view|edit)$/.exec(p)).find((x) => x && isArea(x[1]!));
        const area = grant && isArea(grant[1]!) ? grant[1] : null;
        const text = area
          ? grant![2] === 'edit' && can(membership, `${area}.view`) ? `You can see ${areaLabel(area)}, but not change it. Ask an admin if you need Edit.` : `You don’t have access to ${areaLabel(area)}. Ask an admin if you need it.`
          : permissions.every((p) => p === 'members')
            ? 'Only the owner can do this. Ask the owner if you need it.'
            : 'This page is for admins. Ask an admin or the owner if you need access.';
        web.render(reply, ctx, 'No access', '', html`${pageHeader({ title: 'No access' })}
          <div class="card">${empty('lock', 'You don’t have access to this page', text, linkBtn(`/w/${membership.workspace.id}`, 'Go to overview'))}</div>`);
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
    wantsJson(req) {
      return String(req.headers.accept ?? '').includes('application/json');
    },
    render(reply, ctx, title, active, body, o = {}) {
      return reply.type('text/html').send(layout(ctx, { title, active, body, width: o.width }));
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
  registerLegalRoutes(app, web);
  registerWorkspaceRoutes(app, web);
  registerGitHubRoutes(app, web);
  registerDiscordRoutes(app, web);
  registerAppRoutes(app, web);
  registerPanelRoutes(app, web);
  registerTicketRoutes(app, web);
  registerMovedRoutes(app);
  registerTriageOverviewRoutes(app, web);
  registerTriageReviewRoutes(app, web);
  registerTriageRoutes(app, web);
  registerTriageConfigRoutes(app, web);
  registerTriageKnowledgeRoutes(app, web);
  registerRepoStatusRoutes(app, web);
  registerAnalyticsRoutes(app, web);
  registerTriageRunRoutes(app, web);
  registerTriageActivityRoutes(app, web);
  registerTriageBulkRoutes(app, web);
  registerModerationRoutes(app, web);
  registerMemberRoutes(app, web);
  registerContributorRoutes(app, web);
  registerAnnouncementRoutes(app, web);
  registerBotRoutes(app, web);
  registerBotFeatureRoutes(app, web);
  registerReleaseRoutes(app, web);
  registerTicketTypeRoutes(app, web);
  registerFileRoutes(app, web);
  registerIssueRoutes(app, web);
  registerIssueTriageRoutes(app, web);
  registerClaudeRoutes(app, web);
  registerHealthRoutes(app, web);
  registerAlertRoutes(app, web);
  registerMcpRoutes(app, web);
  registerMcpEndpoint(app, deps, opts.triage);

  return app;
}
