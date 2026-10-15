import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ACCEPT_ATTR,
  addTeamFile,
  cleanFilename,
  cleanUpNow,
  deleteFiles,
  FILE_ID,
  fileUrl,
  formatBytes,
  getFileSettings,
  markScanned,
  MAX_FILE_BYTES,
  refreshIssueStates,
  saveFileSettings,
  storageUsage,
  syncIssueFiles,
  ticketsWithFiles,
  type CleanupRow,
  type DeleteSummary,
  type TicketFile,
} from '../../domain/files.js';
import { can } from '../../domain/permissions.js';
import { addEvent, decryptPayload, getSubmission } from '../../domain/submissions.js';
import { safeEqual } from '../../lib/crypto.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import { simplePage } from '../layout.js';
import { setFlash } from '../session.js';
import type { Web } from '../server.js';
import { csrfField, empty, icon, linkBtn, notice, pill, plural, postBtn, segLinks, setting, statusPill, submitBtn, switchInput, timeAgo, viewOnlyTag, when } from '../ui.js';
import { ticketsHeader } from './tickets.js';

/** The ticket page's upload form (multipart). Its CSRF token is checked by the route itself. */
export const UPLOAD_ROUTE = /^\/w\/[^/]+\/tickets\/[0-9a-f-]{36}\/files$/i;

const PAGE_SIZE = 50;
const GB = 1024;

type View = 'suggested' | 'all' | 'open' | 'closed';

function isOpen(r: CleanupRow): boolean {
  return r.sub.status === 'created' && r.sub.issue_state === 'open';
}
function isClosed(r: CleanupRow): boolean {
  return r.sub.status === 'dismissed' || (r.sub.status === 'created' && (r.sub.issue_state === 'closed' || r.sub.issue_state === 'missing'));
}

/** The GitHub issue's state as last scanned. */
function issueState(r: CleanupRow): SafeHtml {
  const s = r.sub;
  if (s.status === 'dismissed') return pill('Closed without filing', 'closed');
  if (s.status !== 'created') return statusPill(s.status);
  if (s.issue_state === 'open') return pill('Open', 'ok');
  if (s.issue_state === 'closed') return pill(s.issue_state_reason === 'not_planned' ? 'Closed · not planned' : s.issue_state_reason === 'duplicate' ? 'Closed · duplicate' : 'Closed', 'closed');
  if (s.issue_state === 'missing') return pill('Issue deleted', 'warn');
  return pill('Not checked yet', 'neutral');
}

const settingsSchema = z.object({
  auto_cleanup: z.string().optional(),
  closed_enabled: z.string().optional(),
  closed_days: z.coerce.number().int().min(0).max(3650),
  spam_enabled: z.string().optional(),
  age_enabled: z.string().optional(),
  age_days: z.coerce.number().int().min(1).max(3650),
  storage_limit_gb: z.coerce.number().min(0.1).max(1024),
});

function summary(r: DeleteSummary): string {
  if (!r.files) return 'Nothing was deleted.';
  return `Deleted ${plural(r.files, 'file')} from ${plural(r.tickets, 'ticket')} (${formatBytes(r.bytes)}).${r.issueErrors ? ` ${plural(r.issueErrors, 'GitHub issue')} couldn’t be updated right now; the files are gone from the server either way.` : ''}`;
}

export function registerFileRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  // ---- Public file links (shown in GitHub issues) ----------------------------------------------

  async function serve(req: FastifyRequest, reply: FastifyReply) {
    const id = (req.params as { id: string }).id;
    const { rows } = FILE_ID.test(id)
      ? await deps.db.query<TicketFile>(`SELECT * FROM ticket_files WHERE id = $1 AND status = 'stored'`, [id])
      : { rows: [] as TicketFile[] };
    const f = rows[0];
    if (!f?.ext || !f.content_type) return reply.code(404).header('Cache-Control', 'no-store').type('text/plain').send('Not found');
    // Files are only ever shown, never run: no scripts, no frames, no guessing the type.
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('Content-Disposition', `inline; filename="${f.filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"`);
    reply.type(f.content_type);
    return reply.sendFile(`${f.id}.${f.ext}`, deps.config.filesDir, { maxAge: 300_000 });
  }
  app.get('/f/:id', serve);
  app.get('/f/:id/:name', serve);

  // ---- Ticket page: add and delete files ---------------------------------------------------------

  const forbidden = (reply: FastifyReply) =>
    reply.code(403).type('text/html').send(simplePage('Session expired', html`<h1>Your session expired</h1><p class="muted">For your security this action wasn’t performed. Go back, reload the page and try again.</p>${linkBtn('/', 'Back to the app', { block: true })}`));

  app.post('/w/:wid/tickets/:id/files', { bodyLimit: MAX_FILE_BYTES * 11 }, async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'tickets.act' });
    if (!ctx) return reply;
    const sub = await getSubmission(deps.db, ctx.workspace.id, (req.params as { id: string }).id);
    if (!sub) return reply.callNotFound();
    const back = `${ctx.base}/tickets/${sub.id}#files`;
    if (!req.isMultipart()) {
      setFlash(reply, 'error', 'Choose the files to add first.');
      return reply.redirect(back);
    }
    let csrfOk = false;
    let added = 0;
    const errors: string[] = [];
    try {
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === '_csrf' && typeof part.value === 'string') csrfOk = safeEqual(part.value, req.auth!.session.csrf_token);
          continue;
        }
        // The token comes first in the form, so no file is read without it.
        if (!csrfOk) return forbidden(reply);
        if (!part.filename) {
          part.file.resume();
          continue;
        }
        if (sub.status !== 'created') {
          part.file.resume();
          errors.push('Files can be added once the ticket is filed on GitHub.');
          continue;
        }
        const data = await part.toBuffer();
        if (part.file.truncated) {
          errors.push(`${cleanFilename(part.filename)}: larger than 10 MB.`);
          continue;
        }
        const result = await addTeamFile(deps, sub, ctx.user.id, part.filename, data);
        if (result.ok) added++;
        else errors.push(`${cleanFilename(part.filename)}: ${result.error}`);
      }
    } catch (err) {
      if (err instanceof app.multipartErrors.FilesLimitError) errors.push('Add at most 10 files at a time.');
      else throw err;
    }
    if (!csrfOk) return forbidden(reply);
    let issueError = false;
    if (added) {
      await addEvent(deps.db, sub.id, 'files_added', { by: ctx.user.id, count: added });
      try {
        await syncIssueFiles(deps, sub);
      } catch (err) {
        issueError = true;
        deps.log.warn({ submission: sub.ref, err: (err as Error).message }, 'could not add files to the issue');
      }
    }
    const done = added ? `Added ${plural(added, 'file')}${issueError ? '. The GitHub issue couldn’t be updated right now; add another file or delete one later to retry.' : ' to the ticket and its GitHub issue.'}` : '';
    if (errors.length) setFlash(reply, 'error', [done, `${errors.length === 1 ? 'Not added' : 'Some files weren’t added'}: ${[...new Set(errors)].join(' ')}`].filter(Boolean).join(' '));
    else if (added) setFlash(reply, 'success', done);
    else setFlash(reply, 'error', 'Choose the files to add first.');
    return reply.redirect(back);
  });

  app.post('/w/:wid/tickets/:id/files/:fid/delete', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'tickets.act' });
    if (!ctx) return reply;
    const p = req.params as { id: string; fid: string };
    const sub = await getSubmission(deps.db, ctx.workspace.id, p.id);
    if (!sub) return reply.callNotFound();
    const { rows } = FILE_ID.test(p.fid)
      ? await deps.db.query<TicketFile>('SELECT * FROM ticket_files WHERE id = $1 AND submission_id = $2', [p.fid, sub.id])
      : { rows: [] as TicketFile[] };
    const f = rows[0];
    if (!f || f.status !== 'stored') {
      setFlash(reply, 'error', 'That file was already deleted.');
      return reply.redirect(`${ctx.base}/tickets/${sub.id}#files`);
    }
    const r = await deleteFiles(deps, ctx.workspace.id, { fileIds: [f.id] }, ctx.user.id, 'manual');
    setFlash(reply, r.issueErrors ? 'error' : 'success', r.issueErrors
      ? `Deleted “${f.filename}” from the server. The GitHub issue couldn’t be updated right now, so it shows a broken image there.`
      : `Deleted “${f.filename}” from the server and the GitHub issue.`);
    return reply.redirect(`${ctx.base}/tickets/${sub.id}#files`);
  });

  // ---- Files tab ---------------------------------------------------------------------------------

  app.get('/w/:wid/tickets/files', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'files.manage' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const b = ctx.base;
    const admin = can(ctx.membership, 'manage');
    const q = req.query as { view?: string; q?: string; page?: string };
    const [settings, usage] = await Promise.all([getFileSettings(deps.db, wid), storageUsage(deps.db, wid)]);
    const all = await ticketsWithFiles(deps.db, wid, settings);
    const titleOf = (r: CleanupRow) => decryptPayload(deps.box, r.sub)?.title ?? r.sub.ref;
    const counts: Record<View, number> = {
      suggested: all.filter((r) => r.reason).length,
      all: all.length,
      open: all.filter(isOpen).length,
      closed: all.filter(isClosed).length,
    };
    const views: { key: View; label: string }[] = [
      { key: 'suggested', label: 'Suggested for cleanup' },
      { key: 'all', label: 'All' },
      { key: 'open', label: 'Open' },
      { key: 'closed', label: 'Closed' },
    ];
    const view: View = views.some((v) => v.key === q.view) ? (q.view as View) : counts.suggested ? 'suggested' : 'all';
    const search = (q.q ?? '').trim().slice(0, 100).toLowerCase();
    const filtered = all
      .filter((r) => (view === 'suggested' ? r.reason : view === 'open' ? isOpen(r) : view === 'closed' ? isClosed(r) : true))
      .filter((r) => !search || [titleOf(r), r.sub.reporter_display_name, r.sub.reporter_username, r.sub.reporter_discord_id, r.sub.ref].filter(Boolean).join(' ').toLowerCase().includes(search));
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const page = Math.min(pages, Math.max(1, Number(q.page) || 1));
    const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const { rows: fileRows } = await deps.db.query<TicketFile>(
      `SELECT * FROM ticket_files WHERE status = 'stored' AND submission_id IN (SELECT value FROM json_each($1)) ORDER BY created_at`,
      [JSON.stringify(rows.map((r) => r.sub.id))],
    );
    const filesBySub = new Map<string, TicketFile[]>();
    for (const f of fileRows) filesBySub.set(f.submission_id, [...(filesBySub.get(f.submission_id) ?? []), f]);
    const link = (o: { view?: View; page?: number; q?: string }) => {
      const params = new URLSearchParams();
      params.set('view', o.view ?? view);
      if ((o.q ?? search)) params.set('q', o.q ?? search);
      if (o.page && o.page > 1) params.set('page', String(o.page));
      return `${b}/tickets/files?${params.toString()}`;
    };
    const suggested = all.filter((r) => r.reason);
    const suggestedBytes = suggested.reduce((n, r) => n + r.sub.file_bytes, 0);
    const limitBytes = settings.storage_limit_mb * 1024 * 1024;
    const nearLimit = usage.bytes >= limitBytes * 0.9;

    const thumbs = (r: CleanupRow) => {
      const files = filesBySub.get(r.sub.id) ?? [];
      return html`<span class="thumbs">${files.slice(0, 3).map((f) => f.kind === 'image'
        ? html`<img class="thumb" src="${fileUrl('', f)}" alt="" loading="lazy" width="28" height="28">`
        : html`<span class="thumb">${icon('paperclip', 14)}</span>`)}${files.length > 3 ? html`<span class="thumb more">+${String(files.length - 3)}</span>` : ''}</span>`;
    };

    const scanBtn = postBtn(`${b}/tickets/files/scan`, 'Scan for cleanup', ctx.csrf, { icon: 'scan-search', loading: 'Scanning…', title: 'Checks every ticket’s GitHub issue and shows what the rules would delete. Nothing is deleted yet.' });
    const num = (name: string, value: number, min: number, max: number, label: string, step?: string) =>
      html`<input type="number" id="${name}" name="${name}" value="${String(value)}" min="${String(min)}" max="${String(max)}" ${step ? html`step="${step}"` : ''} required aria-label="${label}">`;
    const lastRun = settings.last_run_at
      ? `Last run ${timeAgo(settings.last_run_at)}${settings.last_run_summary ? `: deleted ${plural(settings.last_run_summary.files, 'file')} (${formatBytes(settings.last_run_summary.bytes)})` : ''}.`
      : 'Hasn’t run yet.';

    const table = rows.length
      ? html`<div class="table-wrap wide"><table>
          <thead><tr>
            <th class="check-col"><input type="checkbox" class="rule-check" data-select-all="bulk-files" aria-label="Select every ticket on this page"></th>
            <th class="col-main">Ticket</th><th>GitHub issue</th><th>Files</th><th class="num">Size</th><th>Cleanup reason</th><th class="num">Latest file</th></tr></thead>
          <tbody>${rows.map((r) => html`<tr>
            <td class="check-col"><input type="checkbox" class="rule-check" name="ticket" value="${r.sub.id}" form="bulk-files" aria-label="Select ${titleOf(r)}"></td>
            <td><a class="cell-title" href="${b}/tickets/${r.sub.id}#files">${titleOf(r)}</a><div class="sub">${[r.sub.app_name, r.sub.ticket_type_name, r.sub.reporter_display_name].filter(Boolean).join(' · ')}</div></td>
            <td><div class="row gap-4">${issueState(r)}</div>${r.sub.issue_url ? html`<div class="sub"><a href="${r.sub.issue_url}" target="_blank" rel="noopener noreferrer">${r.sub.repo_name}#${String(r.sub.issue_number)}</a></div>` : ''}</td>
            <td><div class="row gap-4">${thumbs(r)}<span class="small muted">${String(r.sub.file_count)}</span></div></td>
            <td class="num">${formatBytes(r.sub.file_bytes)}</td>
            <td>${r.reason ? html`<span class="small">${r.reason}</span>` : html`<span class="em">—</span>`}</td>
            <td class="num">${when(r.sub.newest_file_at)}</td></tr>`)}</tbody></table></div>`
      : search
        ? empty('search-x', 'No tickets match', 'Try another title, reporter or reference.', linkBtn(link({ q: '', page: 1 }), 'Clear search'))
        : view === 'suggested'
          ? empty('circle-check', settings.last_scan_at ? 'Nothing to clean up' : 'Not scanned yet', settings.last_scan_at
              ? 'No ticket’s files match your cleanup rules right now.'
              : 'Scan for cleanup checks which GitHub issues are closed, then lists the files your rules would delete. Nothing is deleted until you confirm.', settings.last_scan_at ? null : scanBtn, settings.last_scan_at ? 'ok' : 'muted')
          : all.length
            ? empty('paperclip', 'No tickets here', 'Nothing matches this filter.')
            : empty('paperclip', 'No files yet', 'Screenshots that members attach in Discord, or that you add on a ticket page, show up here.');

    const body = html`
      ${await ticketsHeader(web, ctx, 'files', { actions: scanBtn })}
      ${nearLimit ? notice(usage.bytes >= limitBytes ? 'danger' : 'warn', usage.bytes >= limitBytes ? 'The storage limit is reached' : 'Storage is almost full', `${formatBytes(usage.bytes)} of ${formatBytes(limitBytes)} used. ${usage.bytes >= limitBytes ? 'New tickets are filed without their files until you free up space or raise the limit.' : 'Clean up old files or raise the limit below.'}`) : ''}
      <div class="card">
        <div class="stats">
          <div class="stat"><div class="l">Stored files</div><div class="v">${String(usage.files)}</div><div class="sub">on ${plural(usage.tickets, 'ticket')}</div></div>
          <div class="stat"><div class="l">Disk used</div><div class="v">${formatBytes(usage.bytes)}</div>
            <progress class="bar${nearLimit ? ' warn' : ''}" value="${String(Math.min(usage.bytes, limitBytes))}" max="${String(limitBytes)}" aria-label="Storage used">${formatBytes(usage.bytes)}</progress>
            <div class="sub">of ${formatBytes(limitBytes)} limit</div></div>
          <div class="stat"><div class="l">Suggested for cleanup</div><div class="v">${String(suggested.length)}</div><div class="sub">${suggested.length ? `${formatBytes(suggestedBytes)} · ` : ''}${settings.last_scan_at ? `scanned ${timeAgo(settings.last_scan_at)}` : 'not scanned yet'}</div></div>
        </div>
        <div class="card-note">Files are kept on this server and shown in GitHub issues from a long random link. Location and camera data is removed from photos before they’re saved.</div>
      </div>

      <div class="card">
        <div class="toolbar">
          ${segLinks('Filter tickets with files', views.map((v) => ({ href: link({ view: v.key, page: 1 }), label: v.label, count: counts[v.key], current: v.key === view })))}
          <form method="get" action="${b}/tickets/files" class="tools" role="search">
            <input type="hidden" name="view" value="${view}">
            <span class="search sm">${icon('search', 14)}<input type="search" name="q" value="${search}" placeholder="Title, reporter or reference" aria-label="Search tickets with files"></span>
            <button type="submit" class="btn sm nojs">Search</button>
          </form>
        </div>
        ${rows.length ? html`<div class="bulk-bar">
          <span class="small muted" data-selected-text="bulk-files">Select tickets to delete their files.</span>
          <div class="row">
            ${submitBtn('Delete selected', { size: 'sm', variant: 'ghost danger', icon: 'trash-2', form: 'bulk-files', attrs: raw('data-needs-selection="bulk-files"') })}
            ${view === 'suggested' && suggested.length
              ? postBtn(`${b}/tickets/files/delete`, `Delete all suggested (${formatBytes(suggestedBytes)})`, ctx.csrf, {
                  size: 'sm', variant: 'danger-solid', icon: 'trash-2', loading: 'Deleting…', fields: { all: 'suggested' },
                  confirm: { title: `Delete the files of ${plural(suggested.length, 'ticket')}?`, body: `${formatBytes(suggestedBytes)} of files are deleted from this server and removed from their GitHub issues. This can’t be undone.`, label: 'Delete files', danger: true },
                })
              : ''}
          </div></div>` : ''}
        <div class="card-b flush">${table}</div>
        ${pages > 1 ? html`<div class="pager"><span>Page ${String(page)} of ${String(pages)} · ${plural(filtered.length, 'ticket')}</span><div class="row">
          ${page > 1 ? linkBtn(link({ page: page - 1 }), 'Previous', { size: 'sm', icon: 'chevron-left' }) : ''}${page < pages ? linkBtn(link({ page: page + 1 }), 'Next', { size: 'sm', trail: 'chevron-right' }) : ''}</div></div>` : ''}
      </div>
      <form method="post" action="${b}/tickets/files/delete" id="bulk-files" hidden data-confirm-title="Delete the selected tickets’ files?" data-confirm-body="Their files are deleted from this server and removed from their GitHub issues. This can’t be undone." data-confirm-label="Delete files" data-confirm-danger>${csrfField(ctx.csrf)}</form>

      <form method="post" action="${b}/tickets/files/settings" class="card readable" id="rules" data-dirty>
        ${csrfField(ctx.csrf)}
        <div class="card-h"><div><h2>Cleanup rules</h2><div class="desc">Used by Scan for cleanup, and every day by automatic cleanup when it’s on.</div></div>${admin ? '' : viewOnlyTag('Only owners and admins can change the cleanup rules and the storage limit.')}</div>
        <fieldset class="plain" ${admin ? '' : raw('disabled')}>
        ${setting('Automatic cleanup', html`Once a day, delete the files of tickets that match the rules below. ${lastRun}`, switchInput({ name: 'auto_cleanup', checked: settings.auto_cleanup, label: 'Automatic cleanup' }), { switchRow: true })}
        ${setting('Closed tickets', 'Files of tickets whose GitHub issue was closed or deleted, or that were closed without filing.',
          html`<label class="check"><input type="checkbox" name="closed_enabled" value="1" ${settings.closed_enabled ? raw('checked') : ''}> Delete</label>${num('closed_days', settings.closed_days, 0, 3650, 'Days after closing')}<span class="connector">days after closing</span>`)}
        ${setting('Spam', 'Files of tickets closed as spam by triage or by a moderator. With automatic cleanup on, they’re deleted as soon as triage closes the ticket.',
          switchInput({ name: 'spam_enabled', checked: settings.spam_enabled, label: 'Delete spam files' }), { switchRow: true })}
        ${setting('Old files', 'Files older than this, whether the ticket is open or closed.',
          html`<label class="check"><input type="checkbox" name="age_enabled" value="1" ${settings.age_enabled ? raw('checked') : ''}> Delete after</label>${num('age_days', settings.age_days, 1, 3650, 'Days')}<span class="connector">days</span>`)}
        ${setting('Storage limit', 'New files aren’t saved once this much is used. Tickets are still filed, with a note that the file couldn’t be attached.',
          html`${num('storage_limit_gb', Math.round((settings.storage_limit_mb / GB) * 10) / 10, 0.1, 1024, 'Storage limit in GB', '0.1')}<span class="connector">GB</span>`)}
        </fieldset>
        ${admin
          ? html`<div class="card-f"><div class="end">
              <button type="button" class="btn" data-discard data-dirty-enable>Cancel</button>
              ${submitBtn('Save rules', { variant: 'primary', loading: 'Saving…', attrs: raw('data-dirty-enable') })}
            </div></div>`
          : html`<div class="card-note">Only owners and admins can change these.</div>`}
      </form>`;
    return web.render(reply, ctx, 'Files', 'tickets', body, { width: 'full' });
  });

  app.post('/w/:wid/tickets/files/settings', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply);
    if (!ctx) return reply;
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      setFlash(reply, 'error', 'Check the values: days after closing 0–3650, old files 1–3650 days, storage limit 0.1–1024 GB.');
      return reply.redirect(`${ctx.base}/tickets/files#rules`);
    }
    const d = parsed.data;
    await saveFileSettings(deps.db, ctx.workspace.id, {
      auto_cleanup: d.auto_cleanup !== undefined,
      closed_enabled: d.closed_enabled !== undefined,
      closed_days: d.closed_days,
      spam_enabled: d.spam_enabled !== undefined,
      age_enabled: d.age_enabled !== undefined,
      age_days: d.age_days,
      storage_limit_mb: Math.max(100, Math.round(d.storage_limit_gb * GB)),
    });
    setFlash(reply, 'success', d.auto_cleanup !== undefined ? 'Rules saved. Automatic cleanup runs once a day.' : 'Rules saved.');
    return reply.redirect(`${ctx.base}/tickets/files#rules`);
  });

  app.post('/w/:wid/tickets/files/scan', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'files.manage' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const r = await refreshIssueStates(deps, wid);
    await markScanned(deps.db, wid);
    const matches = (await ticketsWithFiles(deps.db, wid, await getFileSettings(deps.db, wid))).filter((x) => x.reason);
    const bytes = matches.reduce((n, x) => n + x.sub.file_bytes, 0);
    const parts = [
      r.total ? `Checked ${plural(r.checked, 'GitHub issue')}.` : '',
      matches.length ? `${plural(matches.length, 'ticket')} match your cleanup rules (${formatBytes(bytes)}). Nothing was deleted yet.` : 'No files match your cleanup rules.',
      r.total > r.checked + r.errors ? `${r.total - r.checked - r.errors} more weren’t checked yet; scan again to check them.` : '',
      r.errors ? `${plural(r.errors, 'issue')} couldn’t be checked right now.` : '',
    ];
    setFlash(reply, r.errors ? 'error' : 'success', parts.filter(Boolean).join(' '));
    return reply.redirect(`${ctx.base}/tickets/files?view=suggested`);
  });

  app.post('/w/:wid/tickets/files/delete', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'files.manage' });
    if (!ctx) return reply;
    const body = (req.body ?? {}) as { all?: string; ticket?: string | string[] };
    const tickets = Array.isArray(body.ticket) ? body.ticket : body.ticket ? [body.ticket] : [];
    if (body.all !== 'suggested' && !tickets.length) {
      setFlash(reply, 'error', 'Select the tickets whose files you want to delete.');
      return reply.redirect(`${ctx.base}/tickets/files`);
    }
    const r = body.all === 'suggested'
      ? await cleanUpNow(deps, ctx.workspace.id, ctx.user.id)
      : await deleteFiles(deps, ctx.workspace.id, { submissionIds: tickets.slice(0, 500) }, ctx.user.id, 'cleanup');
    setFlash(reply, r.issueErrors ? 'error' : 'success', summary(r));
    return reply.redirect(`${ctx.base}/tickets/files${body.all === 'suggested' ? '?view=suggested' : ''}`);
  });
}

/** The Files card on a ticket page. */
export function filesCard(o: {
  files: TicketFile[];
  actionBase: string;
  csrf: string;
  canAct: boolean;
  filed: boolean;
  names: Map<string, string>;
}): SafeHtml {
  const live = o.files.filter((f) => f.status !== 'deleted');
  const tile = (f: TicketFile) => {
    const url = fileUrl('', f);
    const who = f.source === 'team' ? (f.added_by ? `Added by ${o.names.get(f.added_by) ?? 'a moderator'}` : 'Added by the team') : 'From the member';
    if (f.status === 'stored') {
      return html`<li class="file-tile">
        <a class="file-thumb" href="${url}" target="_blank" rel="noopener noreferrer" title="Open ${f.filename}">${f.kind === 'image' ? html`<img src="${url}" alt="${f.filename}" loading="lazy">` : html`<span class="file-icon">${icon('paperclip', 20)}</span>`}</a>
        <div class="file-meta"><div class="grow"><div class="file-name" title="${f.filename}">${f.filename}</div><div class="sub">${formatBytes(f.size)} · ${who}</div></div>
          ${o.canAct ? html`<form method="post" action="${o.actionBase}/files/${f.id}/delete" class="inline-form" data-confirm-title="Delete “${f.filename}”?" data-confirm-body="It’s deleted from this server and removed from the GitHub issue. This can’t be undone." data-confirm-label="Delete file" data-confirm-danger>${csrfField(o.csrf)}<button type="submit" class="icon-btn sm" aria-label="Delete ${f.filename}" title="Delete">${icon('trash-2')}</button></form>` : ''}</div></li>`;
    }
    const by = f.deleted_by ? o.names.get(f.deleted_by) : null;
    const state = f.status === 'pending'
      ? 'Saving…'
      : f.status === 'failed'
        ? `Couldn’t be attached: ${f.error ?? 'unknown error'}`
        : `Deleted${f.delete_reason === 'manual' ? (by ? ` by ${by}` : '') : f.delete_reason === 'spam' ? ' as spam' : ' during cleanup'}${f.deleted_at ? ` · ${timeAgo(f.deleted_at)}` : ''}`;
    return html`<li class="file-tile off">
      <span class="file-thumb">${icon(f.status === 'failed' ? 'file-x' : f.status === 'pending' ? 'clock' : 'trash-2', 20, f.status === 'failed' ? 'warn' : 'muted')}</span>
      <div class="file-meta"><div class="grow"><div class="file-name" title="${f.filename}">${f.filename}</div><div class="sub">${state}</div></div></div></li>`;
  };
  const upload = o.canAct && o.filed
    ? html`<form method="post" action="${o.actionBase}/files" enctype="multipart/form-data" class="upload" data-upload>
        ${csrfField(o.csrf)}
        <input type="file" id="file-input" name="files" multiple accept="${ACCEPT_ATTR}" class="sr-only-input">
        <label for="file-input" class="dropzone" data-dropzone>${icon('upload', 20, 'muted')}<span><span class="dz-title" data-dz-text>Drop screenshots here, or choose files</span><span class="sub">PNG or JPG, up to 10 at a time, 10 MB each.</span></span></label>
        <div class="upload-f">${submitBtn('Add files', { size: 'sm', variant: 'primary', icon: 'upload', loading: 'Uploading…' })}</div>
      </form>`
    : '';
  return html`<div class="card" id="files">
    <div class="card-h"><div class="title">${icon('paperclip', 16)}<h2>Files</h2>${live.length ? html`<span class="badge">${String(live.filter((f) => f.status === 'stored').length)}</span>` : ''}</div></div>
    <div class="card-b">${o.files.length ? html`<ul class="file-grid">${o.files.map(tile)}</ul>` : html`<p class="small muted">${o.filed ? 'No files yet.' : 'Files can be added once the ticket is filed on GitHub.'}</p>`}
      ${upload}</div>
    <div class="card-note">Files are kept on this server and shown in the Attachments section of the GitHub issue. Deleting one removes it from both.</div>
  </div>`;
}

