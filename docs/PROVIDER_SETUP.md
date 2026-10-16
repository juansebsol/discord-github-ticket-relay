# One-time provider setup

These steps happen on Discord's and GitHub's websites and only once per deployment. The
operator who runs the server does them. Admins never repeat them. Everything else
(choosing accounts, servers, channels, repositories, apps and labels) happens in the admin
UI.

The console's **Deployment** page shows the exact URLs below for your `PUBLIC_URL`,
with copy buttons, and whether each provider is configured.

Throughout, `https://relay.example.com` stands for your `PUBLIC_URL`.

## Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**. Name it
   (members will see this name, e.g. "Ticket Relay").
2. **General Information**:
   - Copy the **Application ID** → `DISCORD_APPLICATION_ID`.
   - Copy the **Public Key** → `DISCORD_PUBLIC_KEY`.
   - Set **Interactions Endpoint URL** to `https://relay.example.com/discord/interactions`.
     Discord sends a signed test request when you save. The app must be deployed and
     reachable with Discord credentials configured, or saving fails. If needed, deploy first
     with the other variables, then set this URL.
   - Set **Terms of Service URL** to `https://relay.example.com/terms` and **Privacy Policy
     URL** to `https://relay.example.com/privacy`. Discord requires both to verify the bot.
     Set `LEGAL_OPERATOR_NAME` and `LEGAL_CONTACT_EMAIL` so the pages name you and give a
     contact address. Review the text before you rely on it; it describes what this app
     stores and shares, but it isn't legal advice for your situation.
3. **OAuth2**:
   - Copy the **Client Secret** → `DISCORD_CLIENT_SECRET`.
   - Under **Redirects**, add `https://relay.example.com/oauth/discord/callback`. This one
     URL is used for both admin sign-in and adding the bot to a server.
4. **Bot**:
   - **Reset Token** and copy it → `DISCORD_BOT_TOKEN`.
   - No privileged gateway intents are needed, so leave them all off.
   - **Public Bot**: leave it on only if admins of other workspaces on this deployment should
     be able to add the bot. With it off, only you (the application owner) can add it to
     servers.
   - Leave "Requires OAuth2 Code Grant" off. The app requests `bot identify`, which already
     goes through the code grant.
5. **Installation** → install link: choose **None**. The admin UI generates the correct link,
   with the right permissions and a state check.

The bot asks for these channel permissions when it is added:

- View Channel
- Send Messages
- Embed Links
- Read Message History (needed to check and update its own panel message)
- Manage Roles (only for contributor roles; the bot's role must sit above the contributor role)

## GitHub App

1. Go to GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**. For an
   organization, use **Organization settings → Developer settings**.
2. Fill in:
   - **GitHub App name**: e.g. "Ticket Relay". Its URL slug → `GITHUB_APP_SLUG`. The slug is
     the last part of `https://github.com/apps/<slug>`.
   - **Homepage URL**: `https://relay.example.com`.
   - **Callback URL**: `https://relay.example.com/oauth/github/callback`. It must be the
     *first* callback URL listed.
   - Turn on **Request user authorization (OAuth) during installation**. The app uses this
     to confirm that the admin can actually access the installation; it does not store the
     user's token. The Setup URL field is disabled when this is on. That is expected.
   - **Webhook**:
     - Recommended: set **Active**, the URL to `https://relay.example.com/github/webhook`,
       and a random **secret** → `GITHUB_WEBHOOK_SECRET`. The admin UI then learns about
       uninstalls and suspensions right away.
     - Otherwise: uncheck **Active** and leave `GITHUB_WEBHOOK_SECRET` empty. Problems are
       then found by the validation checks and when filing tickets.
3. **Repository permissions**:
   - **Issues: Read and write**, to create issues and read labels.
   - **Metadata: Read-only**, which GitHub requires; it covers repository names, visibility
     and the Issues setting.
   - For **contributor roles**: **Pull requests: Read-only** (merged PRs) and **Contents:
     Read-only** (direct commits). Read-only; the app never changes code.
   - Leave everything else as *No access*. No organization or account permissions are
     needed, and no event subscriptions are needed.
   - Adding permissions to an existing app: GitHub asks each installation to accept them
     (Settings → Applications → the app → Review request).
4. **Where can this GitHub App be installed?**
   - *Only on this account* if every repository is yours.
   - *Any account* if workspaces will connect other organizations.
5. Create the app, then:
   - Copy the **App ID** → `GITHUB_APP_ID`.
   - Copy the **Client ID** → `GITHUB_CLIENT_ID`.
   - **Generate a new client secret** → `GITHUB_CLIENT_SECRET`.
   - **Generate a private key** (a `.pem` file). Rename it to `sec.pem` and place it at
     `secrets/sec.pem` (git-ignored), then `chmod 600 secrets/sec.pem`. `.env.example` already
     points `GITHUB_APP_PRIVATE_KEY_FILE` there. Alternatively set `GITHUB_APP_PRIVATE_KEY` to the
     key as one base64 line.

Issues created by the app show **`<app-slug>[bot]`** as the author. The issue body credits
the Discord member who reported it.

## After setup

Restart the app with the new variables. The **Deployment** page then shows both providers
as *Working*. Admins can sign in and follow the three setup steps (GitHub, Discord, Apps &
repositories), then publish the panels from **Discord tickets › Panel** and **Contributor roles › Panel**.
