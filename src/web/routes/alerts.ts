/**
 * Alerts that follow you around the console. When AI triage stops (paused, out of this month's
 * limit, or its worker isn't running), every page shows it in a corner panel until it's fixed.
 * The panel can be minimized to a small icon that stays in the corner, or an alert dismissed
 * until the next time it happens. app.js loads it on every page and checks again every minute.
 */
import type { FastifyInstance } from 'fastify';
import { can, firstTriageArea } from '../../domain/permissions.js';
import { html, type SafeHtml } from '../../lib/html.js';
import { autoChecked, AUTO_CHECK_MS, getTriageSettings, monthlyUsage, type TriageSettings } from '../../triage/settings.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { csrfField, icon, iconBtn, linkBtn, plural, submitBtn, timeAgo, type IconName } from '../ui.js';
import { triageHref } from './tickets.js';

/** The triage worker reports every 30 seconds; this long without a report (deploys included) means it's down. */
const WORKER_DOWN_MS = 3 * 60_000;
const ANTHROPIC_BILLING = 'https://console.anthropic.com/settings/billing';

export interface AppAlert {
  /** Changes when it happens again, so a dismissed alert comes back for a new problem. */
  id: string;
  tone: 'warn' | 'danger';
  icon: IconName;
  title: string;
  text: string;
  meta: { icon: IconName; text: string }[];
  actions: SafeHtml[];
  /** Shown as a toast when it's fixed while the page is open. */
  resolved: string;
  /** The page's own notice about the same thing, if it has one: the corner panel then leaves it out. */
  inline?: string;
}

/** Why triage stopped, in a sentence. */
function pausedText(p: NonNullable<TriageSettings['paused']>, model: string): string {
  if (autoChecked(p)) return 'The Anthropic account is out of credits.';
  switch (p.reason) {
    case 'no_key':
      return 'There’s no Claude API key.';
    case 'key_invalid':
      return 'Claude rejected the API key.';
    case 'model_unavailable':
      return `The model ${model} isn’t available to this API key.`;
    default:
      return `Claude rejected the request${p.detail ? `: ${p.detail.replace(/\.$/, '')}` : ''}.`;
  }
}

export async function appAlerts(web: Web, ctx: WorkspaceRequestContext): Promise<AppAlert[]> {
  const m = ctx.membership;
  // Only people who can see triage (or set it up) hear about it.
  const triagePage = firstTriageArea(m);
  if (!triagePage && !can(m, 'manage')) return [];
  const wid = ctx.workspace.id;
  const b = ctx.base;
  const [settings, usage, now] = await Promise.all([getTriageSettings(web.deps.db, wid), monthlyUsage(web.deps.db, wid), web.triage.activityNow(wid)]);
  const c = settings.config;
  const anyOn = settings.enabled || settings.githubEnabled;
  const runs = now.runs.filter((r) => r.pending || r.applying);
  const busy = anyOn || runs.length > 0 || now.bulks.some((x) => x.status === 'running');
  if (!busy) return [];

  const edit = can(m, 'triage.actions.edit');
  const admin = can(m, 'manage');
  const openTriage = triagePage ? linkBtn(triageHref(ctx, triagePage), 'Open Triage', { size: 'sm', variant: 'ghost', trail: 'arrow-right' }) : null;
  const waiting = [
    now.queued.tickets ? plural(now.queued.tickets, 'Discord ticket') : '',
    now.queued.issues ? plural(now.queued.issues, 'GitHub issue') : '',
    runs.length === 1 ? `the re-run “${runs[0]!.name || (runs[0]!.mode === 'preview' ? 'Preview' : 'Re-run')}” (${(runs[0]!.pending + runs[0]!.applying).toLocaleString('en-US')} to go)` : runs.length ? `${runs.length} re-runs` : '',
    now.bulks.some((x) => x.status === 'running') ? 'a bulk apply' : '',
  ].filter(Boolean);
  const out: AppAlert[] = [];

  const p = settings.paused;
  if (p) {
    const auto = autoChecked(p);
    const actions: SafeHtml[] = [];
    if (edit) actions.push(html`<form method="post" action="${b}/tickets/triage/resume" class="inline-form" data-async data-dock-action>${csrfField(ctx.csrf)}${submitBtn('Try again', { size: 'sm', variant: 'primary', icon: 'rotate-ccw', loading: 'Checking…' })}</form>`);
    if (auto && admin) actions.push(linkBtn(ANTHROPIC_BILLING, 'Add credits', { size: 'sm', trail: 'external-link', external: true }));
    else if ((p.reason === 'key_invalid' || p.reason === 'no_key') && admin) actions.push(linkBtn(`${b}/settings#claude`, p.reason === 'no_key' ? 'Add a key' : 'Replace the key', { size: 'sm', trail: 'arrow-right' }));
    else if (p.reason === 'model_unavailable' && edit) actions.push(linkBtn(`${b}/tickets/triage#limits`, 'Choose a model', { size: 'sm', trail: 'arrow-right' }));
    if (openTriage) actions.push(openTriage);
    const meta: AppAlert['meta'] = [{ icon: 'clock', text: `Paused ${timeAgo(p.at)}` }];
    if (waiting.length) meta.push({ icon: 'inbox', text: `Waiting: ${waiting.join(' · ')}` });
    if (auto) meta.push({ icon: 'refresh-cw', text: `Checks again every ${String(AUTO_CHECK_MS / 60_000)} minutes and carries on by itself${p.checkedAt ? ` · last checked ${timeAgo(p.checkedAt)}` : ''}` });
    if (!edit && !admin) meta.push({ icon: 'user-cog', text: auto ? 'An admin needs to add credits.' : 'An admin needs to fix this.' });
    out.push({
      id: `triage-paused:${String(p.at.getTime())}:${auto ? 'credits' : p.reason}`,
      tone: p.reason === 'key_invalid' || auto ? 'danger' : 'warn',
      icon: 'circle-pause',
      title: 'AI triage is paused',
      text: `${pausedText(p, c.model)} Tickets are still filed as usual; nothing is triaged until it’s fixed.`,
      meta,
      actions,
      resolved: 'AI triage is running again.',
      inline: 'triage-paused',
    });
  } else if (anyOn && usage.triaged >= c.monthlyLimit) {
    const next = new Date(Date.UTC(usage.since.getUTCFullYear(), usage.since.getUTCMonth() + 1, 1));
    out.push({
      id: `triage-limit:${usage.since.toISOString().slice(0, 7)}:${String(c.monthlyLimit)}`,
      tone: 'warn',
      icon: 'gauge',
      title: 'AI triage stopped for this month',
      text: `It reached this month’s limit of ${c.monthlyLimit.toLocaleString('en-US')} tickets, so new tickets aren’t triaged. It starts again on ${next.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })}, or raise the limit.`,
      meta: [],
      actions: [edit ? linkBtn(`${b}/tickets/triage#limits`, 'Raise the limit', { size: 'sm', variant: 'primary', trail: 'arrow-right' }) : null, edit ? null : openTriage].filter((x): x is SafeHtml => Boolean(x)),
      resolved: 'AI triage is running again.',
    });
  }

  const seen = now.workerSeenAt;
  if (seen && Date.now() - seen.getTime() > WORKER_DOWN_MS) {
    out.push({
      id: `triage-worker:${String(seen.getTime())}`,
      tone: 'danger',
      icon: 'server',
      title: 'The triage worker isn’t running',
      text: `It last checked in ${timeAgo(seen)}. Tickets are still filed; nothing is triaged until it’s back.${admin ? ' Check pm2 status on the server.' : ''}`,
      meta: waiting.length ? [{ icon: 'inbox', text: `Waiting: ${waiting.join(' · ')}` }] : [],
      actions: can(m, 'health.view') ? [linkBtn(`${b}/health`, 'Server health', { size: 'sm', trail: 'arrow-right' })] : [],
      resolved: 'The triage worker is running again.',
    });
  }
  return out;
}

/** The corner panel, and the small icon it shrinks to. */
export function dockMarkup(alerts: AppAlert[]): SafeHtml {
  if (!alerts.length) return html``;
  const worst = alerts.some((a) => a.tone === 'danger') ? 'danger' : 'warn';
  const tools = html`${iconBtn('minus', 'Minimize', { size: 'sm', attrs: html`data-dock-min` })}`;
  return html`<section class="dock" aria-label="Alerts">
    <div class="dock-panel">
      <div class="dock-h"><span data-dock-count>${plural(alerts.length, 'alert')}</span>${tools}</div>
      ${alerts.map((a) => html`<article class="dock-alert ${a.tone}" data-alert-id="${a.id}" data-title="${a.title}" data-resolved="${a.resolved}" ${a.inline ? html`data-inline="${a.inline}"` : ''}>
        <span class="da-ic">${icon(a.icon, 20)}</span>
        <div class="da-main">
          <div class="da-top"><h2 class="da-title">${a.title}</h2><div class="da-tools">${tools}${iconBtn('x', 'Dismiss until it happens again', { size: 'sm', attrs: html`data-alert-dismiss` })}</div></div>
          <p class="da-text">${a.text}</p>
          ${a.meta.length ? html`<ul class="da-meta">${a.meta.map((x) => html`<li>${icon(x.icon, 14)}<span>${x.text}</span></li>`)}</ul>` : ''}
          ${a.actions.length ? html`<div class="da-actions">${a.actions}</div>` : ''}
        </div>
      </article>`)}
    </div>
    <button type="button" class="dock-pill ${worst}" data-dock-open aria-label="Show alerts" title="Show alerts">${icon(worst === 'danger' ? 'circle-alert' : 'triangle-alert', 20)}<span class="n" data-dock-n>${String(alerts.length)}</span></button>
  </section>`;
}

export function registerAlertRoutes(app: FastifyInstance, web: Web): void {
  /** The corner panel for this person (empty when there's nothing), for app.js. */
  app.get('/w/:wid/alerts', async (req, reply) => {
    const ctx = await web.requireWorkspace(req, reply, { permission: 'view' });
    if (!ctx) return reply;
    const alerts = await appAlerts(web, ctx);
    return reply.header('x-live-partial', '1').header('Cache-Control', 'no-store').type('text/html').send(dockMarkup(alerts).toString());
  });
}
