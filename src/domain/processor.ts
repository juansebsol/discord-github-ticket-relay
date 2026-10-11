import * as messages from '../discord/messages.js';
import { GitHubApiError, type CreatedIssue } from '../github/client.js';
import { buildIssueBody, buildIssueTitle, submissionMarker } from '../github/issue-content.js';
import { NetworkError } from '../lib/http.js';
import { setGitHubStatus } from './store.js';
import { addEvent, claimById, decryptPayload, getSubmission, updateLeased } from './submissions.js';
import { UserFacingError, type Deps, type SubmissionRow } from './types.js';

export const MAX_ATTEMPTS = 10;
/** First reconciliation runs shortly after an uncertain result, then backs off. */
export const FIRST_RECONCILE_DELAY_S = 20;
export const RECONCILE_DELAYS_S = [60, 300, 900];

type Outcome =
  | { type: 'retry'; code: string; message: string; delaySeconds: number }
  | { type: 'failed'; code: string; message: string }
  | { type: 'uncertain'; code: string; message: string }
  | { type: 'retry_without_labels'; code: string; message: string };

type Phase = 'token' | 'labels' | 'create';

function backoffSeconds(attempts: number): number {
  return Math.min(15 * 2 ** Math.max(0, attempts - 1), 900);
}

function repoName(sub: SubmissionRow): string {
  return `${sub.repo_owner}/${sub.repo_name}`;
}

/**
 * Decides what to do after a GitHub call failed. The key rule: when the create-issue
 * request may have reached GitHub (timeouts, dropped connections, 5xx), the outcome is
 * uncertain and we reconcile using the submission marker instead of retrying.
 */
export function classifyError(err: unknown, phase: Phase, sub: SubmissionRow): Outcome {
  const repo = repoName(sub);
  if (err instanceof NetworkError) {
    if (phase === 'create' && err.maybeSent) {
      return {
        type: 'uncertain',
        code: err.code === 'TIMEOUT' ? 'github_timeout' : 'github_connection_lost',
        message: `The request to GitHub ${err.code === 'TIMEOUT' ? 'timed out' : 'was interrupted'} after it was sent, so GitHub may or may not have created the issue.`,
      };
    }
    return { type: 'retry', code: 'github_unreachable', message: `Could not reach GitHub (${err.code ?? 'network error'}).`, delaySeconds: backoffSeconds(sub.attempts) };
  }
  if (err instanceof GitHubApiError) {
    if (err.isRateLimit) {
      return { type: 'retry', code: 'github_rate_limited', message: 'GitHub rate limit reached; will retry automatically.', delaySeconds: Math.min(Math.max(err.retryAfterSeconds ?? 60, 5), 3600) };
    }
    if (phase === 'token') {
      if (err.status === 404) return { type: 'failed', code: 'installation_missing', message: 'The GitHub App is no longer installed on the connected account. Reconnect GitHub, then retry this ticket.' };
      if (err.status === 403) return { type: 'failed', code: 'installation_suspended', message: 'The GitHub App installation is suspended. Unsuspend it in GitHub settings, then retry this ticket.' };
      if (err.status === 401) return { type: 'failed', code: 'app_credentials_invalid', message: 'GitHub rejected the app credentials. The deployment’s GitHub App ID or private key needs to be checked.' };
    }
    if (err.status === 401) {
      return { type: 'retry', code: 'github_auth_failed', message: 'GitHub rejected the access token; a new token will be requested.', delaySeconds: 5 };
    }
    if (err.status >= 500) {
      if (phase === 'create') return { type: 'uncertain', code: 'github_server_error', message: `GitHub returned ${err.status} while creating the issue, so it may or may not have been created.` };
      return { type: 'retry', code: 'github_server_error', message: `GitHub returned ${err.status}.`, delaySeconds: backoffSeconds(sub.attempts) };
    }
    if (err.status === 403) return { type: 'failed', code: 'missing_permission', message: `The GitHub App is not allowed to create issues in ${repo}. Make sure it has “Issues: Read and write” permission and access to this repository.` };
    if (err.status === 404) return { type: 'failed', code: 'repo_not_accessible', message: `Repository ${repo} was not found or the GitHub App no longer has access to it.` };
    if (err.status === 410) return { type: 'failed', code: 'issues_disabled', message: `Issues are disabled in ${repo}. Enable Issues in the repository settings, then retry.` };
    if (err.status === 422 && phase === 'create' && sub.labels.length) {
      return { type: 'retry_without_labels', code: 'invalid_labels', message: `GitHub rejected the request (${err.githubMessage}); retrying without labels.` };
    }
    return { type: 'failed', code: 'github_rejected', message: `GitHub rejected the request (${err.status}: ${err.githubMessage}).` };
  }
  return { type: 'failed', code: 'internal_error', message: 'An unexpected error occurred while filing the ticket.' };
}

export class Processor {
  private readonly labelCache = new Map<string, { labels: Set<string>; at: number }>();

  constructor(private readonly deps: Deps) {}

  /** Processes a submission this worker has just claimed. */
  async processClaimed(sub: SubmissionRow): Promise<void> {
    try {
      if (sub.github_request_started_at) await this.reconcile(sub);
      else await this.create(sub);
    } catch (err) {
      // Never leave a claimed row in limbo: the lease expiry makes it claimable again,
      // and github_request_started_at decides whether that will reconcile or create.
      this.deps.log.error({ err: (err as Error).message, submission: sub.ref }, 'submission processing crashed');
    }
  }

  /** Claims and processes one submission by ID if it is due (used right after accepting it). */
  async processNow(id: string): Promise<void> {
    const sub = await claimById(this.deps.db, id, this.deps.instanceId);
    if (sub) await this.processClaimed(sub);
  }

  /** Repository labels, cached briefly; refetched whenever a configured label seems missing. */
  private async labelsFor(sub: SubmissionRow): Promise<Set<string>> {
    const key = `${sub.installation_id}:${sub.repo_id}`;
    const cached = this.labelCache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60_000 && sub.labels.every((l) => cached.labels.has(l))) return cached.labels;
    const labels = new Set(await this.deps.github!.listLabels(sub.installation_id, sub.repo_owner, sub.repo_name));
    this.labelCache.set(key, { labels, at: Date.now() });
    return labels;
  }

  private async create(sub: SubmissionRow): Promise<void> {
    const { deps } = this;
    const github = deps.github;
    if (!github) {
      await this.apply(sub, { type: 'retry', code: 'github_not_configured', message: 'GitHub is not configured on this deployment yet.', delaySeconds: 300 });
      return;
    }
    const payload = decryptPayload(deps.box, sub);
    if (!payload?.description) {
      await this.apply(sub, { type: 'failed', code: 'payload_missing', message: 'The ticket text is no longer available (it may have been purged after the retention period).' });
      return;
    }

    let phase: Phase = 'token';
    try {
      await github.installationToken(sub.installation_id);

      phase = 'labels';
      let labels = sub.labels;
      if (labels.length) {
        // Filter out labels deleted since configuration: GitHub would otherwise create them.
        const existing = await this.labelsFor(sub);
        const missing = labels.filter((l) => !existing.has(l));
        if (missing.length) {
          labels = labels.filter((l) => existing.has(l));
          await updateLeased(deps.db, sub, deps.instanceId, { warnings: [...sub.warnings, `Skipped missing labels: ${missing.join(', ')}`], labels }, false);
          await addEvent(deps.db, sub.id, 'labels_skipped', { missing });
        }
      }

      phase = 'create';
      const started = await updateLeased(deps.db, sub, deps.instanceId, { github_request_started_at: new Date(), attempts: sub.attempts + 1 }, false);
      if (!started) return; // lease lost; another worker owns it now
      sub = { ...sub, attempts: sub.attempts + 1, labels };
      await addEvent(deps.db, sub.id, 'github_request_sent', { attempt: sub.attempts, labels });

      const issue = await github.createIssue(sub.installation_id, sub.repo_owner, sub.repo_name, {
        title: buildIssueTitle(sub.app_name, payload.title, sub.source === 'admin_test'),
        body: buildIssueBody({
          ref: sub.ref,
          appName: sub.app_name,
          title: payload.title,
          description: payload.description,
          reporterDisplayName: sub.reporter_display_name,
          reporterUsername: sub.reporter_username,
          reporterDiscordId: sub.reporter_discord_id,
          submittedAt: sub.created_at,
          guildName: sub.discord_guild_name,
          guildId: sub.discord_guild_id,
          channelId: sub.discord_channel_id,
          isTest: sub.source === 'admin_test',
        }),
        labels,
      });
      await this.markCreated(sub, issue, 'issue_created');
    } catch (err) {
      const outcome = classifyError(err, phase, sub);
      if (err instanceof GitHubApiError && err.status === 401) github.invalidateToken(sub.installation_id);
      if (phase === 'token' && outcome.type === 'failed') {
        await setGitHubStatus(deps.db, sub.workspace_id, outcome.code === 'installation_suspended' ? 'suspended' : 'error', outcome.message);
      }
      deps.log.warn({ submission: sub.ref, phase, outcome: outcome.type, code: outcome.code, status: (err as GitHubApiError).status }, 'issue creation did not succeed');
      await this.apply(sub, outcome);
    }
  }

  private async apply(sub: SubmissionRow, outcome: Outcome): Promise<void> {
    const { db, instanceId } = this.deps;
    const base = { error_code: outcome.code, error_message: outcome.message };
    switch (outcome.type) {
      case 'retry': {
        if (sub.attempts >= MAX_ATTEMPTS) {
          return this.apply(sub, { type: 'failed', code: outcome.code, message: `${outcome.message} Gave up after ${sub.attempts} attempts.` });
        }
        const ok = await updateLeased(db, sub, instanceId, {
          ...base,
          status: 'pending',
          github_request_started_at: null,
          next_attempt_at: new Date(Date.now() + outcome.delaySeconds * 1000),
        }, true);
        if (!ok) return;
        await addEvent(db, sub.id, 'retry_scheduled', { code: outcome.code, delay_seconds: outcome.delaySeconds });
        await this.notifyMember(sub, 'queued');
        return;
      }
      case 'retry_without_labels': {
        const ok = await updateLeased(db, sub, instanceId, {
          ...base,
          status: 'pending',
          labels: [],
          github_request_started_at: null,
          next_attempt_at: new Date(),
          warnings: [...sub.warnings, 'GitHub rejected the configured labels; the issue was filed without labels.'],
        }, true);
        if (!ok) return;
        await addEvent(db, sub.id, 'retry_without_labels', { code: outcome.code });
        setImmediate(() => void this.processNow(sub.id));
        return;
      }
      case 'failed': {
        const ok = await updateLeased(db, sub, instanceId, { ...base, status: 'failed', github_request_started_at: null, next_attempt_at: null }, true);
        if (!ok) return;
        await addEvent(db, sub.id, 'failed', { code: outcome.code });
        await this.notifyMember(sub, 'failed');
        return;
      }
      case 'uncertain': {
        const ok = await updateLeased(db, sub, instanceId, {
          ...base,
          status: 'uncertain',
          reconcile_attempts: 0,
          next_attempt_at: new Date(Date.now() + FIRST_RECONCILE_DELAY_S * 1000),
        }, true);
        if (!ok) return;
        await addEvent(db, sub.id, 'uncertain', { code: outcome.code });
        await this.notifyMember(sub, 'uncertain');
        return;
      }
    }
  }

  private async markCreated(sub: SubmissionRow, issue: CreatedIssue, eventKind: string, extra: Record<string, unknown> = {}): Promise<boolean> {
    const { deps } = this;
    const payload = decryptPayload(deps.box, sub);
    const ok = await updateLeased(deps.db, sub, deps.instanceId, {
      status: 'created',
      issue_number: issue.number,
      issue_url: issue.url,
      completed_at: new Date(),
      next_attempt_at: null,
      error_code: null,
      error_message: null,
      // GitHub now holds the description; keep only the title for the admin history.
      payload_enc: payload ? deps.box.encryptJson({ title: payload.title }) : sub.payload_enc,
      ...extra,
    }, true);
    if (!ok) return false;
    await addEvent(deps.db, sub.id, eventKind, { issue_number: issue.number });
    deps.log.info({ submission: sub.ref, repo: repoName(sub), issue: issue.number }, 'ticket filed');
    await this.notifyMember({ ...sub, issue_number: issue.number, issue_url: issue.url }, 'created');
    return true;
  }

  /** Looks for the issue on GitHub by its submission marker. */
  private async reconcile(sub: SubmissionRow): Promise<'found' | 'not_found' | 'error'> {
    const { deps } = this;
    const attempt = sub.reconcile_attempts + 1;
    if (!deps.github) {
      await updateLeased(deps.db, sub, deps.instanceId, { status: 'uncertain', next_attempt_at: new Date(Date.now() + 300_000) }, true);
      return 'error';
    }
    try {
      const since = sub.github_request_started_at ?? sub.created_at;
      const found = await deps.github.findIssueByMarker(sub.installation_id, sub.repo_owner, sub.repo_name, submissionMarker(sub.ref), since);
      if (found) {
        await this.markCreated(sub, found, 'reconciled_found', { reconcile_attempts: attempt, last_reconciled_at: new Date() });
        return 'found';
      }
      const delay = RECONCILE_DELAYS_S[attempt - 1];
      await updateLeased(deps.db, sub, deps.instanceId, {
        status: 'uncertain',
        reconcile_attempts: attempt,
        last_reconciled_at: new Date(),
        next_attempt_at: delay !== undefined ? new Date(Date.now() + delay * 1000) : null,
      }, true);
      await addEvent(deps.db, sub.id, 'reconciled_not_found', { attempt, next_check_seconds: delay ?? null });
      await this.notifyMember(sub, 'uncertain');
      return 'not_found';
    } catch (err) {
      const delay = attempt < 8 ? 120 : null;
      await updateLeased(deps.db, sub, deps.instanceId, {
        status: 'uncertain',
        reconcile_attempts: attempt,
        last_reconciled_at: new Date(),
        next_attempt_at: delay ? new Date(Date.now() + delay * 1000) : null,
      }, true);
      await addEvent(deps.db, sub.id, 'reconcile_error', {
        attempt,
        status: err instanceof GitHubApiError ? err.status : null,
        code: err instanceof NetworkError ? err.code : null,
      });
      return 'error';
    }
  }

  /** Edits the member's private reply while the Discord interaction token is still valid. */
  async notifyMember(sub: SubmissionRow, kind: 'created' | 'queued' | 'uncertain' | 'failed'): Promise<void> {
    const { deps } = this;
    if (!deps.discord || !sub.interaction_token_enc || !sub.interaction_token_expires_at) return;
    if (sub.interaction_token_expires_at.getTime() < Date.now() || sub.member_notice === kind) return;
    let payload: ReturnType<typeof messages.createdMessage>;
    if (kind === 'created') {
      payload = messages.createdMessage({ appName: sub.app_name, ref: sub.ref, issueNumber: sub.issue_number!, issueUrl: sub.issue_url!, repoPrivate: sub.repo_private });
    } else if (kind === 'queued') payload = messages.queuedMessage({ appName: sub.app_name, ref: sub.ref });
    else if (kind === 'uncertain') payload = messages.uncertainMessage({ appName: sub.app_name, ref: sub.ref });
    else payload = messages.failedMessage({ appName: sub.app_name, ref: sub.ref });
    const { flags: _ephemeralIsFixedAtCreation, ...edit } = payload;
    try {
      await deps.discord.editOriginalResponse(deps.box.decrypt(sub.interaction_token_enc), edit);
      await deps.db.query('UPDATE submissions SET member_notice = $2 WHERE id = $1', [sub.id, kind]);
    } catch (err) {
      deps.log.warn({ submission: sub.ref, err: (err as Error).message }, 'could not update member reply');
    }
  }

  // ---- Admin actions ------------------------------------------------------------------------

  /** Admin-initiated check of an uncertain submission against GitHub. */
  async recheck(workspaceId: string, id: string, userId: string): Promise<'found' | 'not_found' | 'error'> {
    const current = await getSubmission(this.deps.db, workspaceId, id);
    if (!current) throw new UserFacingError('Submission not found.', 404);
    if (current.status !== 'uncertain') throw new UserFacingError('Only submissions with an unconfirmed result can be checked.');
    const sub = await claimById(this.deps.db, id, this.deps.instanceId, { force: true });
    if (!sub) throw new UserFacingError('This submission is being processed right now. Try again in a moment.', 409);
    await addEvent(this.deps.db, id, 'admin_recheck', { by: userId });
    return this.reconcile({ ...sub, github_request_started_at: sub.github_request_started_at ?? sub.created_at });
  }

  /**
   * Admin-initiated retry. For uncertain submissions it first checks GitHub for an
   * existing issue, and only creates a new one if none is found.
   */
  async retry(workspaceId: string, id: string, userId: string): Promise<'created' | 'found_existing' | 'queued' | 'failed' | 'uncertain'> {
    const { deps } = this;
    const current = await getSubmission(deps.db, workspaceId, id);
    if (!current) throw new UserFacingError('Submission not found.', 404);
    if (current.status !== 'failed' && current.status !== 'uncertain') throw new UserFacingError('Only failed or unconfirmed submissions can be retried.');
    if (!decryptPayload(deps.box, current)?.description) throw new UserFacingError('The ticket text is no longer stored, so it cannot be re-sent.');

    let sub = await claimById(deps.db, id, deps.instanceId, { force: true });
    if (!sub) throw new UserFacingError('This submission is being processed right now. Try again in a moment.', 409);

    if (current.status === 'uncertain') {
      const result = await this.reconcile({ ...sub, github_request_started_at: sub.github_request_started_at ?? sub.created_at });
      if (result === 'found') return 'found_existing';
      if (result === 'error') throw new UserFacingError('Could not check GitHub for an existing issue, so nothing was re-sent. Try again later.', 502);
      sub = await claimById(deps.db, id, deps.instanceId, { force: true });
      if (!sub) throw new UserFacingError('This submission is being processed right now. Try again in a moment.', 409);
    }

    await updateLeased(deps.db, sub, deps.instanceId, { github_request_started_at: null, attempts: 0, error_code: null, error_message: null, resolution_note: null }, false);
    await addEvent(deps.db, id, 'admin_retry', { by: userId, previous_status: current.status });
    await this.create({ ...sub, github_request_started_at: null, attempts: 0 });
    const after = await getSubmission(deps.db, workspaceId, id);
    return after!.status === 'created' ? 'created' : after!.status === 'pending' ? 'queued' : (after!.status as 'failed' | 'uncertain');
  }

  /** Records an issue the admin found or filed manually. */
  async linkIssue(workspaceId: string, id: string, issueNumber: number, userId: string): Promise<void> {
    const { deps } = this;
    const current = await getSubmission(deps.db, workspaceId, id);
    if (!current) throw new UserFacingError('Submission not found.', 404);
    if (current.status !== 'failed' && current.status !== 'uncertain') throw new UserFacingError('Only failed or unconfirmed submissions can be linked to an issue.');
    if (!deps.github) throw new UserFacingError('GitHub is not configured.');
    let issue;
    try {
      issue = await deps.github.getIssue(current.installation_id, current.repo_owner, current.repo_name, issueNumber);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) throw new UserFacingError(`Issue #${issueNumber} was not found in ${repoName(current)}.`);
      throw new UserFacingError('Could not reach GitHub to verify that issue. Try again later.', 502);
    }
    if (issue.isPullRequest) throw new UserFacingError(`#${issueNumber} is a pull request, not an issue.`);
    const sub = await claimById(deps.db, id, deps.instanceId, { force: true });
    if (!sub) throw new UserFacingError('This submission is being processed right now. Try again in a moment.', 409);
    await this.markCreated(sub, issue, 'admin_linked_issue', { resolved_by: userId, resolution_note: `Linked to #${issueNumber} by an admin.` });
  }

  /** Closes an unresolved submission without filing it. */
  async dismiss(workspaceId: string, id: string, note: string, userId: string): Promise<void> {
    const { deps } = this;
    const current = await getSubmission(deps.db, workspaceId, id);
    if (!current) throw new UserFacingError('Submission not found.', 404);
    if (current.status !== 'failed' && current.status !== 'uncertain') throw new UserFacingError('Only failed or unconfirmed submissions can be closed.');
    const sub = await claimById(deps.db, id, deps.instanceId, { force: true });
    if (!sub) throw new UserFacingError('This submission is being processed right now. Try again in a moment.', 409);
    await updateLeased(deps.db, sub, deps.instanceId, {
      status: 'dismissed',
      next_attempt_at: null,
      github_request_started_at: null,
      resolved_by: userId,
      resolution_note: note || null,
      completed_at: new Date(),
    }, true);
    await addEvent(deps.db, id, 'admin_dismissed', { by: userId });
  }
}
