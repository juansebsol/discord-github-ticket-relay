import type { FastifyInstance } from 'fastify';
import { decryptPayload, getSubmission, listEvents, listSubmissions } from '../../domain/submissions.js';
import { UserFacingError, type SubmissionRow, type SubmissionStatus } from '../../domain/types.js';
import { html } from '../../lib/html.js';
import { alert, badge, button, csrfField, formatDate, pageHead, postButton, statusBadge, timeAgo } from '../layout.js';
import { setFlash } from '../session.js';
import type { Web } from '../server.js';
import { submissionsTable } from './workspace.js';

const PAGE_SIZE = 25;

const TABS: [string, string][] = [
  ['', 'All'],
  ['attention', 'Needs attention'],
  ['created', 'Created'],
  ['pending', 'Queued'],
  ['uncertain', 'Needs check'],
  ['failed', 'Failed'],
  ['dismissed', 'Closed'],
];

const EVENT_LABELS: Record<string, string> = {
  accepted: 'Submitted from Discord and saved',
  labels_skipped: 'Some configured labels no longer exist and were skipped',
  github_request_sent: 'Sent to GitHub',
  issue_created: 'GitHub issue created',
  retry_scheduled: 'Will retry automatically',
  retry_without_labels: 'Retrying without labels',
  failed: 'Failed',
  uncertain: 'Result unknown — checking GitHub',
  reconciled_found: 'Found the issue on GitHub',
  reconciled_not_found: 'Checked GitHub: no matching issue yet',
  reconcile_error: 'Could not check GitHub',
  admin_recheck: 'Admin asked to check GitHub',
  admin_retry: 'Admin retried',
  admin_linked_issue: 'Admin linked an existing issue',
  admin_dismissed: 'Admin closed it without filing',
};

function explain(s: SubmissionRow): string {
  switch (s.status) {
    case 'created':
      return 'The GitHub issue was created and the member was told.';
    case 'pending':
      return s.next_attempt_at && s.next_attempt_at.getTime() > Date.now()
        ? `Waiting to retry (${timeAgo(s.next_attempt_at)}). This happens automatically.`
        : 'Queued; it will be filed in a moment.';
    case 'processing':
      return 'Being filed or checked right now.';
    case 'failed':
      return 'This ticket could not be filed. Fix the cause below, then retry. The member was told the team has it.';
    case 'uncertain':
      return s.next_attempt_at
        ? `GitHub may or may not have created the issue. It is checked automatically using the submission ID (${s.reconcile_attempts} check${s.reconcile_attempts === 1 ? '' : 's'} so far; next ${timeAgo(s.next_attempt_at)}).`
        : `GitHub may or may not have created the issue. Automatic checks found no matching issue (${s.reconcile_attempts} checks). Search the repository for “${s.ref}”, then link the issue, retry or close this submission.`;
    case 'dismissed':
      return 'Closed by an admin without filing.';
  }
}

export function registerSubmissionRoutes(app: FastifyInstance, web: Web): void {
  const { deps, processor } = web;

  app.get('/w/:wid/submissions', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const q = req.query as { status?: string; q?: string; page?: string };
    const status = TABS.some(([k]) => k === q.status) ? q.status || undefined : undefined;
    const search = (q.q ?? '').trim().slice(0, 100);
    const page = Math.max(1, Number(q.page) || 1);
    const { rows, total } = await listSubmissions(deps.db, ctx.workspace.id, {
      status: status as SubmissionStatus | 'attention' | undefined,
      search: search || undefined,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    });
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const link = (p: Record<string, string | number | undefined>) => {
      const params = new URLSearchParams();
      const merged = { status, q: search || undefined, ...p };
      for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== '') params.set(k, String(v));
      const s = params.toString();
      return `${ctx.base}/submissions${s ? `?${s}` : ''}`;
    };
    const body = html`
      ${pageHead('Submissions', 'Every ticket submitted through Discord, with its status and GitHub issue.')}
      <nav class="tabs" aria-label="Filter by status">${TABS.map(([k, label]) => html`<a href="${link({ status: k || undefined, page: undefined })}" class="${(status ?? '') === k ? 'active' : ''}">${label}</a>`)}</nav>
      <form method="get" action="${ctx.base}/submissions" class="row" role="search">
        ${status ? html`<input type="hidden" name="status" value="${status}">` : ''}
        <input type="search" name="q" value="${search}" placeholder="Search by reference, reporter or app" aria-label="Search submissions">
        <button class="btn" type="submit">Search</button>
      </form>
      <div class="card">${submissionsTable(ctx.base, rows, (s) => decryptPayload(deps.box, s)?.title ?? null)}
        ${pages > 1 ? html`<div class="spread"><span class="small muted">Page ${String(page)} of ${String(pages)} · ${String(total)} submissions</span><div class="row">
          ${page > 1 ? html`<a class="btn sm" href="${link({ page: page - 1 })}">Previous</a>` : ''}${page < pages ? html`<a class="btn sm" href="${link({ page: page + 1 })}">Next</a>` : ''}</div></div>` : ''}
      </div>`;
    return web.render(reply, ctx, 'Submissions', 'submissions', body);
  });

  app.get('/w/:wid/submissions/:id', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const s = await getSubmission(deps.db, ctx.workspace.id, (req.params as { id: string }).id);
    if (!s) return reply.callNotFound();
    const events = await listEvents(deps.db, s.id);
    const payload = decryptPayload(deps.box, s);
    const actionBase = `${ctx.base}/submissions/${s.id}`;
    const unresolved = s.status === 'failed' || s.status === 'uncertain';
    const canResend = Boolean(payload?.description);

    const body = html`
      ${pageHead(payload?.title ?? `Submission ${s.ref}`, undefined, html`${statusBadge(s.status)}${s.source === 'admin_test' ? badge('Test', 'info') : ''}`)}
      ${alert(s.status === 'failed' ? 'error' : s.status === 'uncertain' ? 'warn' : s.status === 'created' ? 'success' : 'info', html`<p>${explain(s)}</p>${s.issue_url ? html`<p><a href="${s.issue_url}" target="_blank" rel="noopener noreferrer">Open ${s.repo_owner}/${s.repo_name}#${String(s.issue_number)} on GitHub</a></p>` : ''}`)}

      ${unresolved ? html`<div class="card"><div class="card-head"><h2>Resolve</h2></div>
        <div class="stack">
          ${s.status === 'uncertain' ? html`<div class="spread"><div><strong>Check GitHub now</strong><div class="small muted">Looks for an issue containing <code>${s.ref}</code> in ${s.repo_owner}/${s.repo_name}.</div></div>${postButton(`${actionBase}/recheck`, 'Check now', ctx.csrf, { loading: 'Checking…' })}</div>` : ''}
          <div class="spread"><div><strong>Retry</strong><div class="small muted">${s.status === 'uncertain' ? 'Checks GitHub first and only creates the issue if none exists, so it is never filed twice.' : 'Files the ticket again with the same text and the same repository.'}${canResend ? '' : ' Not available: the ticket text is no longer stored.'}</div></div>
            ${postButton(`${actionBase}/retry`, 'Retry', ctx.csrf, { variant: 'primary', loading: 'Working…', disabled: !canResend, confirm: s.status === 'uncertain' ? 'Check GitHub and create the issue only if it does not exist yet?' : 'Try to file this ticket again?' })}</div>
          <form method="post" action="${actionBase}/link" class="spread">${csrfField(ctx.csrf)}<div><label for="issue-number">Link an existing issue</label><div class="small muted">If you found or filed the issue yourself.</div></div>
            <div class="row"><input id="issue-number" type="number" name="issue_number" min="1" required placeholder="Issue #"> ${button('Link', { loading: 'Verifying…' })}</div></form>
          <form method="post" action="${actionBase}/dismiss" class="spread" data-confirm="Close this submission without filing an issue?">${csrfField(ctx.csrf)}<div><label for="note">Close without filing</label><div class="small muted">For spam or tickets handled elsewhere.</div></div>
            <div class="row"><input id="note" type="text" name="note" maxlength="300" placeholder="Reason (optional)"> ${button('Close', { variant: 'danger' })}</div></form>
        </div></div>` : ''}

      <div class="grid grid-2">
        <div class="card"><div class="card-head"><h2>Details</h2></div>
          <dl class="kv">
            <dt>Submission ID</dt><dd><code>${s.ref}</code></dd>
            <dt>App</dt><dd>${s.app_name}</dd>
            <dt>Repository</dt><dd><span class="mono">${s.repo_owner}/${s.repo_name}</span> (${s.repo_private ? 'private' : 'public'})</dd>
            ${s.labels.length ? html`<dt>Labels</dt><dd>${s.labels.join(', ')}</dd>` : ''}
            <dt>Reporter</dt><dd>${s.reporter_display_name}${s.reporter_username ? html` <span class="muted">@${s.reporter_username}</span>` : ''}<div class="small muted">Discord ID ${s.reporter_discord_id}</div></dd>
            <dt>Submitted</dt><dd>${formatDate(s.created_at)}</dd>
            ${s.discord_guild_name ? html`<dt>Discord server</dt><dd>${s.discord_guild_name}</dd>` : ''}
            <dt>Attempts</dt><dd>${String(s.attempts)}</dd>
            ${s.error_code ? html`<dt>Last error</dt><dd><code>${s.error_code}</code><div class="small">${s.error_message ?? ''}</div></dd>` : ''}
            ${s.warnings.length ? html`<dt>Warnings</dt><dd>${s.warnings.map((w) => html`<div class="small">${w}</div>`)}</dd>` : ''}
            ${s.resolution_note ? html`<dt>Resolution</dt><dd>${s.resolution_note}</dd>` : ''}
            <dt>Member notified</dt><dd>${s.member_notice ? s.member_notice : s.source === 'admin_test' ? 'Not applicable (test)' : 'Not yet'}</dd>
          </dl>
        </div>
        <div class="card"><div class="card-head"><h2>Timeline</h2></div>
          <ul class="timeline">${events.map((e) => html`<li><span class="muted small nowrap">${formatDate(e.at)}</span><span>${EVENT_LABELS[e.kind] ?? e.kind}${e.detail.issue_number ? ` (#${String(e.detail.issue_number)})` : ''}${e.detail.code ? html` <code>${String(e.detail.code)}</code>` : ''}</span></li>`)}</ul>
        </div>
      </div>

      <div class="card"><div class="card-head"><h2>Ticket text</h2></div>
        ${payload?.description
          ? html`<details><summary>Show the submitted description</summary><pre class="ticket-text">${payload.description}</pre></details>
              <p class="small muted">Stored encrypted for recovery. ${s.status === 'created' ? '' : 'Kept until resolved (at most 90 days).'}</p>`
          : html`<p class="muted small">${s.status === 'created' ? 'The description now lives in the GitHub issue; only the title is kept here.' : s.payload_purged_at ? `Deleted after the retention period (${formatDate(s.payload_purged_at)}).` : 'Not available.'}</p>`}
      </div>
      <p><a href="${ctx.base}/submissions">← All submissions</a></p>`;
    return web.render(reply, ctx, `Submission ${s.ref}`, 'submissions', body);
  });

  function action(name: string, run: (wid: string, id: string, userId: string, body: Record<string, string>) => Promise<string>) {
    app.post(`/w/:wid/submissions/:id/${name}`, async (req, reply) => {
      const ctx = await web.requireWorkspace(req, reply);
      if (!ctx) return reply;
      const id = (req.params as { id: string }).id;
      try {
        setFlash(reply, 'success', await run(ctx.workspace.id, id, ctx.user.id, (req.body ?? {}) as Record<string, string>));
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
        setFlash(reply, 'error', err.message);
      }
      return reply.redirect(`${ctx.base}/submissions/${id}`);
    });
  }

  action('recheck', async (wid, id, uid) => {
    const r = await processor.recheck(wid, id, uid);
    return r === 'found' ? 'Found the issue on GitHub. The submission is now marked as created.' : r === 'not_found' ? 'No matching issue was found on GitHub.' : 'GitHub could not be reached. Try again later.';
  });
  action('retry', async (wid, id, uid) => {
    const r = await processor.retry(wid, id, uid);
    return {
      created: 'The issue was created.',
      found_existing: 'The issue already existed on GitHub, so nothing new was created. It is now linked.',
      queued: 'GitHub is busy; the ticket was queued and will be filed automatically.',
      failed: 'The retry failed. See the error below.',
      uncertain: 'GitHub did not confirm the result. It will be checked automatically.',
    }[r];
  });
  action('link', async (wid, id, uid, body) => {
    const n = Number(body.issue_number);
    if (!Number.isInteger(n) || n < 1) throw new UserFacingError('Enter a valid issue number.');
    await processor.linkIssue(wid, id, n, uid);
    return `Linked to issue #${n}.`;
  });
  action('dismiss', async (wid, id, uid, body) => {
    await processor.dismiss(wid, id, String(body.note ?? '').trim().slice(0, 300), uid);
    return 'Submission closed.';
  });
}
