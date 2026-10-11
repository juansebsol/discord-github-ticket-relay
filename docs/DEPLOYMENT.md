# Deployment

## What runs

The app is a single Node.js service: `node dist/index.js`, or the Docker image. One process:

- serves the admin web interface
- receives Discord interactions over HTTPS (no gateway/websocket connection, so nothing has
  to stay connected)
- runs the background worker that files issues, retries and reconciles (disable with
  `RUN_WORKER=false`)
- applies database migrations on startup (disable with `AUTO_MIGRATE=false` and run
  `npm run migrate:prod` yourself)

It needs **PostgreSQL 13+** and **Node.js 22+**.

```bash
docker compose up --build     # app + Postgres on one host, reads .env
# or
npm ci && npm run build && npm start
```

## Public endpoints

Serve the app over **HTTPS** at `PUBLIC_URL`. Discord and GitHub require public HTTPS for
callbacks.

| Path | Caller | Purpose |
|---|---|---|
| `POST /discord/interactions` | Discord | Panel menu, form submissions. Ed25519 signature verified on every request. |
| `GET /oauth/discord/callback` | Browser (from Discord) | Admin sign-in and bot installation. One-time state checked. |
| `GET /oauth/github/callback` | Browser (from GitHub) | GitHub App installation / authorization. One-time state checked; installation verified against the user's accessible installations. |
| `POST /github/webhook` | GitHub (optional) | Uninstall/suspend events. HMAC-SHA256 signature verified. 404 when `GITHUB_WEBHOOK_SECRET` is unset. |
| `GET /healthz` | Load balancer | Returns 200 when the database is reachable. |
| everything else | Admins' browsers | Admin UI (Discord sign-in required). |

Behind a reverse proxy or load balancer, set `TRUST_PROXY=true`. Session cookies are
`Secure` whenever `PUBLIC_URL` is `https://`.

## Configuration

See [`.env.example`](../.env.example). Only deployment secrets live in environment
variables:

- `DATABASE_URL`, `PUBLIC_URL`
- `ENCRYPTION_KEY`
- Discord application credentials
- GitHub App credentials

Workspace settings, connections, apps, labels, limits, panels and submissions are stored in
the database and managed in the UI.

`ENCRYPTION_KEY` encrypts the following at rest with AES-256-GCM:

- admins' Discord access tokens, used only to list the servers they manage
- Discord interaction tokens, kept for at most 15 minutes so the member's reply can be updated
- the recoverable copy of ticket text

Keep the key in your secret manager and don't change it. If it changes, existing encrypted
values can't be read: pending tickets can't be re-sent and admins must sign in again.

## Scaling and reliability

- **Several instances are safe.** Work is claimed from the `submissions` table with
  `FOR UPDATE SKIP LOCKED` and a 90-second lease, so each submission is processed by one
  worker at a time. If a worker dies, its lease expires and another worker picks the
  submission up. Any number of web instances can receive interactions.
- **Optional split:** run web instances with `RUN_WORKER=false` plus one or more
  `npm run start:worker` processes.
- **Discord's 3-second deadline:** a form submission is validated and saved in one short
  transaction. The app then answers with a private deferred response, and the GitHub call
  starts only after the response is sent. The member's reply is edited with the result (the
  interaction token stays valid for 15 minutes).
- **Duplicates:**
  - The Discord interaction ID is unique in the database, so a repeated delivery is
    processed once.
  - Identical tickets from the same member for the same app within the duplicate window
    (default 10 minutes) are rejected with a pointer to the first one.
  - A per-member rate limit (default 5 tickets per 10 minutes) applies. Both are
    configurable per workspace under Settings.
  - These checks run under a per-member advisory lock, so concurrent submissions are
    handled correctly.
- **Routing is frozen** when a ticket is accepted. The repository, labels and installation
  are copied into the submission, so later configuration changes never redirect it. If an
  app's repository changes while a member has the form open, the submission is refused and
  the member's text is echoed back for them to resubmit.

### Submission states

| State | Meaning |
|---|---|
| `pending` | Saved and queued (new, or waiting for a scheduled retry after a definite failure such as a rate limit or GitHub being unreachable). |
| `processing` | A worker holds the lease. |
| `created` | The issue exists; the member was told. |
| `failed` | Definitely not created (missing permission, Issues disabled, repository gone, app uninstalled). The admin sees the cause; the member is told the team has it. Can be retried after fixing. |
| `uncertain` | The create request may have reached GitHub (timeout after sending, dropped connection, 5xx). **Never retried blindly.** |
| `dismissed` | Closed by an admin without filing. |

Every issue body contains a hidden marker with the stable submission ID, e.g.
`<!-- ticket-relay:submission=TR-7KQ2M9XA4D -->`. For `uncertain` submissions the worker
searches the repository for that marker:

- It checks after 20 s, then again after 1, 5 and 15 minutes.
- If the issue is found, the submission becomes `created` and the member's reply is updated.
- If the issue is still not found after the last check, an admin decides on the
  submission's page. They can:
  - **Check now**
  - **Retry**, which checks again first and only creates the issue if none exists
  - **Link an existing issue**
  - **Close**

  Each submission's page has a full event timeline. A worker that died mid-request is
  handled the same way: the request start is recorded before sending, so it is reconciled,
  not re-sent.

### Retention

- When an issue is created, the stored copy of the description is dropped right away,
  because it now lives on GitHub. Only the title is kept for the history view.
- Created and closed submissions lose their stored text after the workspace's retention
  period (default 30 days).
- Failed and uncertain ones keep it for at least 90 days so they can still be recovered.
- Interaction tokens are discarded once they expire.
- Housekeeping runs in the worker every 10 minutes.

## Logging

- Logs are JSON (pino).
- Request URLs are logged without query strings, so OAuth codes and state values don't
  appear.
- Authorization and cookie headers are removed.
- Ticket text and tokens are never logged.
- Processing logs carry the submission reference, repository, outcome code and HTTP status,
  which is enough to trace a ticket with the admin UI's timeline.

## Security notes

- Admin pages require a Discord sign-in. Every state-changing form uses a per-session CSRF
  token, and workspace pages check membership on every request.
- Browser hardening: a strict Content Security Policy (no inline scripts or styles),
  `frame-ancestors 'none'`, and `Referrer-Policy: same-origin` so invitation links and OAuth
  codes don't leak.
- Repository and channel allowlists are enforced on the server:
  - An app can only be mapped to a repository the workspace's installation can access, with
    Issues enabled and not archived.
  - Labels must exist in that repository.
  - The tickets channel must belong to the connected server, and the bot must have the
    required permissions there.
- Every message the bot sends uses `allowed_mentions: { parse: [] }`, so ticket text can't
  ping anyone.
- In the issue body, GitHub @-mentions in user text are neutralized (outside code blocks).
- Members only ever see friendly messages. Provider error details are shown only to admins
  of the workspace.

## Backups and upgrades

- Back up the PostgreSQL database. It holds all configuration and history.
- Upgrades are a redeploy. Migrations run automatically, and the migration runner takes an
  advisory lock, so concurrent instances starting at the same time is fine.
