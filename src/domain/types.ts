import type { Config } from '../config.js';
import type { Db } from '../db/database.js';
import type { DiscordClient } from '../discord/client.js';
import type { GitHubClient } from '../github/client.js';
import type { SecretBox } from '../lib/crypto.js';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Shared dependencies. Provider clients are null until deployment config provides credentials. */
export interface Deps {
  config: Config;
  db: Db;
  box: SecretBox;
  github: GitHubClient | null;
  discord: DiscordClient | null;
  log: Logger;
  /** Identifies this process when claiming work, so several instances can run side by side. */
  instanceId: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  rate_limit_count: number;
  rate_limit_window_minutes: number;
  duplicate_window_minutes: number;
  retention_days: number;
  panel_title: string | null;
  panel_intro: string | null;
  created_at: Date;
}

export interface UserRow {
  id: string;
  discord_user_id: string;
  username: string;
  display_name: string | null;
  avatar: string | null;
}

export type Role = 'owner' | 'admin';

export interface GitHubConnectionRow {
  workspace_id: string;
  installation_id: number;
  account_login: string;
  account_type: string;
  account_avatar_url: string | null;
  repository_selection: string | null;
  status: 'active' | 'suspended' | 'removed' | 'error';
  status_detail: string | null;
  connected_at: Date;
}

export interface DiscordConnectionRow {
  workspace_id: string;
  guild_id: string;
  guild_name: string;
  guild_icon: string | null;
  tickets_channel_id: string | null;
  tickets_channel_name: string | null;
  status: 'active' | 'removed' | 'error';
  status_detail: string | null;
  connected_at: Date;
}

export interface AppRow {
  id: string;
  workspace_id: string;
  public_id: string;
  name: string;
  description: string | null;
  repo_id: number;
  repo_owner: string;
  repo_name: string;
  repo_private: boolean;
  labels: string[];
  enabled: boolean;
  position: number;
  created_at: Date;
  updated_at: Date;
}

export interface PanelRow {
  workspace_id: string;
  channel_id: string;
  message_id: string;
  content_hash: string;
  status: 'published' | 'missing';
  published_at: Date;
  last_checked_at: Date | null;
  last_error: string | null;
}

export type SubmissionStatus = 'pending' | 'processing' | 'created' | 'failed' | 'uncertain' | 'dismissed';

export interface SubmissionRow {
  id: string;
  workspace_id: string;
  ref: string;
  source: 'discord' | 'admin_test';
  app_id: string | null;
  app_name: string;
  installation_id: number;
  repo_id: number;
  repo_owner: string;
  repo_name: string;
  repo_private: boolean;
  labels: string[];
  discord_interaction_id: string | null;
  discord_guild_id: string | null;
  discord_guild_name: string | null;
  discord_channel_id: string | null;
  reporter_discord_id: string;
  reporter_display_name: string;
  reporter_username: string | null;
  payload_enc: string | null;
  payload_purged_at: Date | null;
  content_hash: string;
  status: SubmissionStatus;
  attempts: number;
  next_attempt_at: Date | null;
  lease_owner: string | null;
  lease_until_at: Date | null;
  github_request_started_at: Date | null;
  reconcile_attempts: number;
  last_reconciled_at: Date | null;
  issue_number: number | null;
  issue_url: string | null;
  error_code: string | null;
  error_message: string | null;
  warnings: string[];
  interaction_token_enc: string | null;
  interaction_token_expires_at: Date | null;
  member_notice: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface TicketPayload {
  title: string;
  description?: string;
}

/** An error whose message is safe to show to admins. */
export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
