# discord-github-ticket-relay

Members of your Discord server submit tickets for your apps through a panel in a Discord
channel. Each ticket becomes a GitHub issue in the repository mapped to that app. Members
never need a GitHub account. Admins set everything up and manage it in a web interface.

## How it works

1. An admin publishes a **ticket panel** in the Discord tickets channel. The panel explains
   the process and shows an app picker.
2. A member picks an app. A Discord form opens with a title, a description (with guidance to
   include steps to reproduce, expected and actual behavior), a note on who will be able to
   see the report, and a reminder not to include secrets.
3. On submit the bot acknowledges right away (privately), saves the ticket, and creates the
   GitHub issue in the app's repository through a GitHub App.
4. The member's private reply is updated with the app name, ticket number, reference ID and
   a link. For private repositories it explains that the link only works with repository
   access, so the member doesn't need to open it.

Out of scope for this version: comment syncing, issue-status sync, attachments and private
ticket channels.

## Stack

The repository was empty, so this is a small, conventional stack:

- **Node.js 24 + TypeScript, Fastify.** One process serves the admin UI and Discord's HTTP
  interactions endpoint, and runs the background worker.
- **PostgreSQL.** Stores settings, apps, panels, submissions and the work queue. Row
  locking (`FOR UPDATE SKIP LOCKED`) plus leases make it safe to run several instances.
- **Server-rendered HTML** with a little progressive-enhancement JavaScript. There is no
  frontend build, and no credentials ever reach the browser.
- **Discord over HTTP interactions** (no gateway connection). The bot needs no privileged
  intents or slash commands, and nothing has to be "registered".
- **A GitHub App with installation tokens.** It needs only *Issues: read & write* and
  *Metadata: read*.

## Tenancy model

- Everything belongs to a **workspace**. Each workspace connects one GitHub App
  installation and one Discord server.
- A Discord server can belong to only one workspace, because incoming interactions are routed
  by server ID. This is enforced with a unique constraint and checked in the setup flow.
- Admins sign in with Discord. Workspace members are **owners** (they can manage admins) or
  **admins**. Admins are added with one-time invitation links.
- People without membership get a 404 for a workspace's pages, not a 403.
- Workspace creation is limited by default. The first person to sign in to a fresh deployment
  can create one, plus anyone listed in `PLATFORM_ADMIN_DISCORD_IDS`. Set
  `OPEN_WORKSPACE_CREATION=true` to let anyone who signs in create a workspace.

## Getting started

```bash
npm install
cp .env.example .env              # fill in DATABASE_URL, ENCRYPTION_KEY, provider credentials
npm run migrate                   # also runs automatically on startup
npm run dev                       # http://localhost:3000
```

- The app starts even when provider credentials are missing. The admin UI then shows exactly
  what is missing on the **Deployment setup** page.
- For local UI work without Discord, set `DEV_LOGIN=true`. This only works with a localhost
  `PUBLIC_URL` and never in production.
- To receive Discord interactions locally, expose the port through an HTTPS tunnel and use
  the tunnel URL as `PUBLIC_URL`.

Next steps:

- One-time provider registration: [docs/PROVIDER_SETUP.md](docs/PROVIDER_SETUP.md)
- Production runtime, endpoints and scaling: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

Once deployed, everything else happens in the admin UI. Each step is a page:

1. Connect GitHub.
2. Connect Discord.
3. Add apps.
4. Validate & publish.

After that, use the Submissions and Settings pages to manage it.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server with reload |
| `npm run build` / `npm start` | Compile to `dist/` and run (web + worker) |
| `npm run start:worker` | Worker-only process (optional; see deployment doc) |
| `npm run migrate` | Apply database migrations |
| `npm run typecheck` | TypeScript checks for app and tests |
| `npm test` | Test suite (needs a local PostgreSQL; uses `TEST_DATABASE_URL` or `postgres://localhost:5432/ticket_relay_test`) |

## Tests

The tests run the real app (HTTP routes, database, worker, and the GitHub/Discord REST
clients) against **in-memory fakes of the GitHub and Discord APIs** (`test/fakes.ts`). They
are mocked, not live, verification. They cover:

- Admin authorization, CSRF, owner-only actions, invitations and workspace isolation.
- Configuration and validation:
  - the repository allowlist, disabled Issues and unknown labels
  - channel permissions
  - OAuth state checks and spoofed GitHub installation IDs
  - the Discord server ownership check and signed GitHub webhooks
- Discord signature checks, the app picker (including more than 25 apps), the form, routing
  to the right repository, and several apps sharing one repository.
- Issue content and attribution, and the member's private confirmation.
- Repeated delivery of the same interaction, concurrent duplicate submissions, and rate
  limits.
- GitHub failures: permissions, disabled Issues, rate limits, token refresh, invalid labels,
  uninstalled app and network errors.
- Timeouts, uncertain results and reconciliation. It never re-creates an issue blindly,
  including when a worker died mid-request.
- Panel publishing, in-place updates, deleted panels and moving the panel to another channel.
- Persistence across restarts, several workers running at once, routing snapshots, and
  retention purging.

## Project layout

```
src/
  config.ts              deployment configuration (env)
  app.ts, index.ts       app wiring and entry point (web + worker)
  worker.ts              optional worker-only entry point
  db/                    pool, migration runner, SQL migrations
  discord/               REST client, signature check, permissions, payload builders, interaction handler
  github/                GitHub App client (JWT, installation tokens), issue content
  domain/                submissions & queue, processor (create/reconcile), worker, panel, validation, stores
  web/                   Fastify server, sessions/CSRF, layout, routes, static assets
test/                    test suite and provider fakes
docs/                    provider setup and deployment
```
