# Deployment

Runs on a single Linux host with Node.js, PM2 and a TLS reverse proxy. State lives in one
SQLite file. No external database or container runtime is required.

## Processes

| PM2 app | Entry | Instances | Role |
|---|---|---|---|
| `ticket-relay-web` | `dist/index.js` | 1 | Admin console, Discord interactions endpoint, OAuth callbacks. Binds `PORT`. Makes the first filing attempt right after acknowledging Discord. |
| `ticket-relay-worker` | `dist/worker.js` | 2 (configurable) | Claims queued submissions, retries, reconciles uncertain results, housekeeping. No port. |
| `ticket-relay-triage` | `dist/triage-worker.js` | 1 | Optional AI triage of tickets that are already filed, and the issue sync: a copy of every issue in the connected repositories (GitHub issues), refreshed every couple of minutes, that triage searches for duplicates. Never touches the filing queue, so stopping it or Claude being down can't affect filing. |

All processes share `DATABASE_PATH`. Every process applies pending migrations on boot; the
runner holds SQLite's write lock, so simultaneous starts are safe.

**Requirements:** Node.js ≥ 22 (with build tools for `better-sqlite3` if no prebuilt binary
matches), PM2, a domain with TLS, local disk for the database. Network filesystems are not
supported by SQLite.

## Install

```bash
git clone <repo> ticket-relay && cd ticket-relay
npm ci
npm run build
cp .env.example .env          # see Configuration
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup                   # run the printed command to start on boot
```

### Reverse proxy

Terminate TLS and forward to `127.0.0.1:3000`. Caddy example (automatic certificates):

```
tickets.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Set `HOST=127.0.0.1` and `TRUST_PROXY=true` in `.env`. Verify with `curl https://tickets.example.com/healthz`.

### Public endpoints

| Route | Caller |
|---|---|
| `POST /discord/interactions` | Discord (Ed25519-signed) |
| `GET /oauth/discord/callback` | Browser, after Discord OAuth |
| `GET /oauth/github/callback` | Browser, after GitHub App install/authorize |
| `POST /github/webhook` | GitHub (HMAC-signed, optional) |
| `GET /healthz` | Monitoring |
| `/*` | Admin console |

## Configuration

`.env` in the app directory (see [`.env.example`](../.env.example)):

| Variable | Notes |
|---|---|
| `DATABASE_PATH` | SQLite file. Default `./data/ticket-relay.db`; directory is created. |
| `PUBLIC_URL` | `https://tickets.example.com` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32`. Encrypts stored tokens and ticket text (AES-256-GCM). Changing it makes existing encrypted data unreadable. |
| `DISCORD_*`, `GITHUB_*` | Provider credentials, see [PROVIDER_SETUP.md](PROVIDER_SETUP.md) |
| `PLATFORM_ADMIN_DISCORD_IDS` | Your Discord user ID, so nobody else can claim the deployment |
| `HOST`, `TRUST_PROXY` | `127.0.0.1`, `true` behind a proxy |
| `WORKER_CONCURRENCY` | Parallel filings per worker process (set in `ecosystem.config.cjs`, default 2) |

All other configuration is stored in the database and managed in the console.

## Operations

| Task | Command |
|---|---|
| Deploy update | `git pull && npm ci && npm run build && pm2 reload ecosystem.config.cjs` |
| Status | `pm2 status` |
| Logs | `pm2 logs ticket-relay-web` / `pm2 logs ticket-relay-worker` |
| Scale workers | `pm2 scale ticket-relay-worker 4` |
| Backup (online) | `sqlite3 data/ticket-relay.db ".backup 'backups/relay-$(date +%F).db'"` |
| Backup files | `tar czf backups/files-$(date +%F).tgz -C data files` (screenshots attached to tickets) |
| Restore | `pm2 stop all`, replace the database file (remove `-wal`/`-shm`), `pm2 start all` |

Keep the `.env` (especially `ENCRYPTION_KEY`) alongside database backups. A backup can't be
decrypted without it.

Attached files live in `FILES_DIR` (default `data/files`). They're served at `/f/<id>` through
the web process, so no Caddy change is needed. A file deleted in the console (or by the cleanup
rules in Discord tickets › Files) is gone from disk right away, but stays in older backups until
they rotate out.

## Server health

Each process reports its memory, CPU and event-loop delay every 30 seconds. The **Server health**
page in the console shows them live (with 24-hour charts, restarts, disk, the GitHub API rate
limit and alerts). The limit shown comes from `MEMORY_LIMIT_MB` in `ecosystem.config.cjs`; keep
it equal to that app's `max_memory_restart` when you change one.

## Scaling

- **Queue safety.** Workers claim a submission with a single atomic `UPDATE … RETURNING`
  under SQLite's write lock and hold a 90s lease, so a ticket is filed by exactly one process.
  A crashed worker's ticket is picked up after the lease expires and reconciled, never
  re-sent blindly.
- **Throughput.** GitHub limits issue creation per app to roughly 80/min and 500/h, with
  about 1s spacing recommended. Two workers with concurrency 2 already exceed what GitHub
  accepts; more workers add redundancy, not speed. Over the limit, tickets wait in the queue
  and retry automatically.
- **Single host.** SQLite needs local disk, so all processes run on one machine. Keep exactly
  one `ticket-relay-web` instance (it owns the port); scale `ticket-relay-worker` freely.

## Data retention

Housekeeping runs in every worker every 10 minutes:

- The description is dropped once the issue exists; only the title stays for history.
- Created and closed submissions lose stored text after the workspace retention period
  (default 30 days). Failed and uncertain ones keep it for at least 90 days.
- Expired sessions, OAuth states and Discord interaction tokens are deleted.
- Moderation › Ticket management keeps an encrypted copy of each GitHub issue a moderator opens
  (its text and comments), so it shows at once. A copy is deleted 30 days after it was last read.

## Logging

pino JSON to stdout, collected by PM2. Request URLs are logged without query strings, auth
and cookie headers are stripped, and ticket text and tokens are never logged. Processing
logs include the submission reference, repository, outcome code and HTTP status, so you can
trace a ticket alongside its timeline in the console.
