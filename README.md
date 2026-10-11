# Ticket Relay

Discord support tickets, filed as GitHub issues.

Members submit tickets from a panel in Discord. Each ticket is routed to the right repository
and filed by a GitHub App. Reporters never need a GitHub account.

`Node.js 24` · `TypeScript` · `Fastify` · `SQLite` · `Discord Interactions` · `GitHub Apps`

## Features

**Members (Discord)**
- App picker panel, then a native ticket form
- Private confirmation with ticket number, reference ID and issue link
- Told up front whether the report will be public or private
- Duplicate detection and per-user rate limiting

**Admins (web console)**
- Guided setup: connect GitHub, connect Discord, add apps, validate and publish
- Map apps to repositories and labels; several apps can share one repository
- Live validation of repository access, Issues, labels and bot permissions
- Ticket history with per-ticket timeline, retry, re-check and link-issue actions
- Owner/admin roles with invite links; rate limit and retention settings

**Platform**
- Multi-tenant workspaces (one GitHub installation and one Discord server each)
- SQLite-backed job queue with multiple worker processes; safe across restarts and crashes
- Never files an issue twice: unknown outcomes are reconciled, not retried
- Credentials stay server-side; stored tokens and ticket text are encrypted

## Quick start

```bash
npm install
cp .env.example .env    # PUBLIC_URL, ENCRYPTION_KEY
npm run dev             # http://localhost:3000
```

Set `DEV_LOGIN=true` to use the console locally without Discord credentials.

## Self-hosting

One host, PM2 and a TLS reverse proxy. No external database: state is a single SQLite file.
Serverless platforms such as Vercel are not supported.

```bash
npm ci && npm run build
cp .env.example .env               # PUBLIC_URL, ENCRYPTION_KEY, provider credentials
pm2 start ecosystem.config.cjs     # web (1) + queue workers (2); migrations run on boot
pm2 save && pm2 startup
```

Then:

1. Proxy HTTPS to port `3000` (set `HOST=127.0.0.1` so the port isn't public).
2. Register the Discord application and the GitHub App: [docs/PROVIDER_SETUP.md](docs/PROVIDER_SETUP.md).
3. Open `PUBLIC_URL`, sign in with Discord and follow the setup steps.

Processes, operations, backups and scaling: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Configuration

| Variable | Description |
|---|---|
| `DATABASE_PATH` | SQLite file (default `./data/ticket-relay.db`) |
| `PUBLIC_URL` | Public HTTPS origin |
| `ENCRYPTION_KEY` | `openssl rand -base64 32`; keep it stable |
| `DISCORD_*` | `APPLICATION_ID`, `PUBLIC_KEY`, `CLIENT_SECRET`, `BOT_TOKEN` |
| `GITHUB_*` | `APP_ID`, `APP_SLUG`, `CLIENT_ID`, `CLIENT_SECRET`, optional `WEBHOOK_SECRET` |
| `GITHUB_APP_PRIVATE_KEY_FILE` | `./secrets/sec.pem` (git-ignored; see [`secrets/`](secrets/README.md)) |
| `PLATFORM_ADMIN_DISCORD_IDS` | Discord user IDs allowed to create workspaces |

Optional variables are listed in [`.env.example`](.env.example). Everything else is configured
in the console.

## Scripts

| Command | |
|---|---|
| `npm run dev` | Dev server with reload |
| `npm run build` · `npm start` | Production build and run |
| `npm run start:worker` | Queue worker process |
| `npm run migrate` | Apply migrations (also runs on boot) |
| `npm run typecheck` | Type-check source and tests |
| `npm test` | Test suite (self-contained; uses a temporary SQLite file) |

## Docs

- [Provider setup](docs/PROVIDER_SETUP.md): Discord application and GitHub App registration
- [Deployment](docs/DEPLOYMENT.md): runtime, scaling, retention, operations
- [Architecture](docs/ARCHITECTURE.md): ticket lifecycle, endpoints, schema, security

## Scope

Not included: GitHub ↔ Discord comment sync, issue-status sync, attachments, private ticket channels.
