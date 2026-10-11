-- Initial schema for discord-github-ticket-relay.
--
-- Tenancy model: everything belongs to a workspace. A workspace connects exactly one
-- GitHub App installation and exactly one Discord server (guild). A Discord server can
-- belong to at most one workspace, because incoming Discord interactions are routed to
-- a workspace by guild ID.

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_user_id text NOT NULL UNIQUE,
  username        text NOT NULL,
  display_name    text,
  avatar          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                       text NOT NULL,
  rate_limit_count           integer NOT NULL DEFAULT 5 CHECK (rate_limit_count BETWEEN 1 AND 100),
  rate_limit_window_minutes  integer NOT NULL DEFAULT 10 CHECK (rate_limit_window_minutes BETWEEN 1 AND 1440),
  duplicate_window_minutes   integer NOT NULL DEFAULT 10 CHECK (duplicate_window_minutes BETWEEN 0 AND 1440),
  retention_days             integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 365),
  panel_title                text,
  panel_intro                text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'admin')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);

CREATE TABLE workspace_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  used_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   timestamptz
);

CREATE TABLE sessions (
  id                        text PRIMARY KEY,            -- sha256 of the cookie token
  user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token                text NOT NULL,
  discord_access_token_enc  text,                        -- encrypted; used only to list the admin's servers
  discord_token_expires_at  timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  expires_at                timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- One-time OAuth / installation state values (CSRF protection + binding to session/workspace).
CREATE TABLE oauth_states (
  state_hash   text PRIMARY KEY,
  purpose      text NOT NULL CHECK (purpose IN ('discord_login', 'discord_bot', 'github_install')),
  session_id   text,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);

CREATE TABLE github_connections (
  workspace_id          uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id       bigint NOT NULL,
  account_login         text NOT NULL,
  account_type          text NOT NULL,
  account_avatar_url    text,
  repository_selection  text,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed', 'error')),
  status_detail         text,
  connected_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_at          timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX github_connections_installation_idx ON github_connections(installation_id);

CREATE TABLE discord_connections (
  workspace_id          uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  guild_id              text NOT NULL UNIQUE,
  guild_name            text NOT NULL,
  guild_icon            text,
  tickets_channel_id    text,
  tickets_channel_name  text,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed', 'error')),
  status_detail         text,
  connected_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  connected_at          timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE apps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  public_id     text NOT NULL UNIQUE,                    -- short opaque ID used in Discord custom_ids
  name          text NOT NULL,
  description   text,
  repo_id       bigint NOT NULL,
  repo_owner    text NOT NULL,
  repo_name     text NOT NULL,
  repo_private  boolean NOT NULL,
  labels        text[] NOT NULL DEFAULT '{}',
  enabled       boolean NOT NULL DEFAULT true,
  position      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX apps_workspace_name_idx ON apps(workspace_id, lower(name));
CREATE INDEX apps_workspace_idx ON apps(workspace_id, position);

CREATE TABLE panels (
  workspace_id     uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id       text NOT NULL,
  message_id       text NOT NULL,
  content_hash     text NOT NULL,                        -- hash of the payload last published
  status           text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'missing')),
  published_at     timestamptz NOT NULL DEFAULT now(),
  published_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  last_checked_at  timestamptz,
  last_error       text
);

CREATE TABLE submissions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ref                        text NOT NULL UNIQUE,      -- stable submission identifier, e.g. TR-7KQ2M9XA4D
  source                     text NOT NULL CHECK (source IN ('discord', 'admin_test')),

  -- Routing snapshot taken when the submission was accepted. Later configuration
  -- changes never redirect an accepted submission.
  app_id                     uuid REFERENCES apps(id) ON DELETE SET NULL,
  app_name                   text NOT NULL,
  installation_id            bigint NOT NULL,
  repo_id                    bigint NOT NULL,
  repo_owner                 text NOT NULL,
  repo_name                  text NOT NULL,
  repo_private               boolean NOT NULL,
  labels                     text[] NOT NULL DEFAULT '{}',

  discord_interaction_id     text UNIQUE,
  discord_guild_id           text,
  discord_guild_name         text,
  discord_channel_id         text,
  reporter_discord_id        text NOT NULL,
  reporter_display_name      text NOT NULL,
  reporter_username          text,

  payload_enc                text,                      -- encrypted {title, description}; purged after retention
  payload_purged_at          timestamptz,
  content_hash               text NOT NULL,             -- for accidental duplicate detection (keyed HMAC)

  status                     text NOT NULL CHECK (status IN ('pending', 'processing', 'created', 'failed', 'uncertain', 'dismissed')),
  attempts                   integer NOT NULL DEFAULT 0,
  next_attempt_at            timestamptz,
  lease_owner                text,
  lease_until                timestamptz,
  github_request_started_at  timestamptz,               -- set right before a create-issue request is sent
  reconcile_attempts         integer NOT NULL DEFAULT 0,
  last_reconciled_at         timestamptz,

  issue_number               integer,
  issue_url                  text,
  error_code                 text,
  error_message              text,                      -- admin-facing, sanitized
  warnings                   text[] NOT NULL DEFAULT '{}',

  interaction_token_enc      text,                      -- encrypted; lets us edit the member's private reply
  interaction_token_expires_at timestamptz,
  member_notice              text,                      -- last state shown to the member

  resolved_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution_note            text,

  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz
);
CREATE INDEX submissions_workspace_created_idx ON submissions(workspace_id, created_at DESC);
CREATE INDEX submissions_reporter_idx ON submissions(workspace_id, reporter_discord_id, created_at DESC);
CREATE INDEX submissions_queue_idx ON submissions(next_attempt_at) WHERE status IN ('pending', 'uncertain');
CREATE INDEX submissions_lease_idx ON submissions(lease_until) WHERE status = 'processing';

CREATE TABLE submission_events (
  id             bigserial PRIMARY KEY,
  submission_id  uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  at             timestamptz NOT NULL DEFAULT now(),
  kind           text NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX submission_events_submission_idx ON submission_events(submission_id, id);
