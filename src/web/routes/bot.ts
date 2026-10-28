/**
 * Bot features: the extra things the bot does in Discord. Its page lists every feature as a row
 * (what it is, whether it's on, a few facts) with a switch to turn it on or off and a gear that
 * opens it; each feature's own pages share a header with a way back and their tabs.
 */
import type { FastifyInstance } from 'fastify';
import { announcedRepos, announcementCounts, appAnnounceSettings, getAnnouncementSettings, type AnnouncementSettings } from '../../announcements/settings.js';
import { checkBoard, computeBoard, getKnownIssuesSettings, type BoardState, type KnownIssuesSettings } from '../../bot-features/known-issues.js';
import { AREAS, can, canSeeTool, hasEdit, isArea, type Area } from '../../domain/permissions.js';
import { getDiscordConnection, listApps } from '../../domain/store.js';
import { html, raw, type SafeHtml } from '../../lib/html.js';
import type { Web, WorkspaceRequestContext } from '../server.js';
import { csrfField, icon, pageHeader, pill, plural, switchInput, tabs, timeAgo, viewOnlyTag, type IconName } from '../ui.js';
import { areaHref, canOpen, lockedText, viewOnlyText } from './tool.js';

type Content = SafeHtml | string;

/** The features, in the order they're listed. Each one's pages are its tabs, the first is where it opens. */
export const FEATURES = {
  'known-issues': {
    name: 'Known-issues board',
    icon: 'clipboard-list',
    about: 'A message with the problems members report most and where each fix is.',
    tabs: [{ area: 'known-issues', label: 'Board' }],
    settings: 'known-issues',
    power: '/bot/known-issues/settings',
  },
  'releases': {
    name: 'GitHub releases',
    icon: 'package',
    about: 'Posts each app’s new GitHub releases in Discord, with friendlier notes and a role ping.',
    tabs: [{ area: 'releases', label: 'Posts' }, { area: 'release-settings', label: 'Settings' }, { area: 'release-pings', label: 'Pings panel' }],
    settings: 'release-settings',
    power: '/bot/releases/settings',
  },
} as const satisfies Record<string, { name: string; icon: IconName; about: string; tabs: readonly { area: Area; label: string }[]; settings: Area; power: string }>;
export type Feature = keyof typeof FEATURES;
const FEATURE_IDS = Object.keys(FEATURES) as Feature[];

/** Where a feature opens: its first page this person can open (null: none). */
function featureHref(ctx: Pick<WorkspaceRequestContext, 'base' | 'membership'>, f: Feature): string | null {
  const tab = FEATURES[f].tabs.find((t) => canOpen(ctx.membership, t.area));
  return tab ? areaHref(ctx, tab.area) : null;
}

export function knownIssuesPill(s: KnownIssuesSettings, state: BoardState): SafeHtml {
  if (!s.enabled) return pill('Off', 'neutral');
  if (state.state === 'published') return state.channelChanged ? pill('Channel changed', 'warn') : pill('Live', 'ok');
  if (state.state === 'missing') return pill('Deleted in Discord', 'warn');
  return pill('Not published', 'neutral');
}

export function releasesPill(s: Pick<AnnouncementSettings, 'enabled' | 'mode'>): SafeHtml {
  return !s.enabled ? pill('Off', 'neutral') : s.mode === 'auto' ? pill('Automatic', 'ok') : pill('Review first', 'ok');
}

/**
 * The header of a feature's pages: back to Bot features, its name and whether it's on, and a tab
 * per page (pages this person can't open are shown locked).
 */
export async function featureHeader(web: Web, ctx: WorkspaceRequestContext, f: Feature, current: Area, o: { actions?: (SafeHtml | false | null | undefined)[]; counts?: Partial<Record<Area, number>>; description?: Content } = {}): Promise<SafeHtml> {
  const { db } = web.deps;
  const wid = ctx.workspace.id;
  const def = FEATURES[f];
  let status: SafeHtml;
  let power: { on: boolean; channel: boolean };
  const counts: Partial<Record<Area, number>> = { ...o.counts };
  if (f === 'known-issues') {
    const [s, conn] = await Promise.all([getKnownIssuesSettings(db, wid), getDiscordConnection(db, wid)]);
    status = knownIssuesPill(s, await checkBoard(web.deps, wid, conn, { live: false }));
    power = { on: s.enabled, channel: Boolean(s.channelId) };
  } else {
    const [s, n] = await Promise.all([getAnnouncementSettings(db, wid), announcementCounts(db, wid)]);
    status = releasesPill(s);
    power = { on: s.enabled, channel: Boolean(s.channelId) };
    counts.releases ??= n.waiting + n.failed;
  }
  const m = ctx.membership;
  const toggle = can(m, `${def.settings}.edit`)
    ? powerSwitch(ctx, `${ctx.base}${def.power}`, power.on, { label: `${def.name} turned on`, blocked: power.channel ? undefined : 'Choose a channel in its settings first', back: current })
    : null;
  const viewOnly = hasEdit(current) && !can(m, `${current}.edit`);
  return html`${pageHeader({
    crumbs: [{ href: `${ctx.base}/bot`, label: 'Bot features' }, { label: def.name }],
    title: def.name,
    after: [status, viewOnly ? viewOnlyTag(viewOnlyText(current)) : ''],
    description: o.description ?? def.about,
    actions: [toggle, ...(o.actions ?? [])],
  })}
  ${tabs(def.name, def.tabs.map((t) => ({
    href: areaHref(ctx, t.area),
    label: t.label,
    current: t.area === current,
    count: counts[t.area] || undefined,
    tone: 'accent' as const,
    locked: canOpen(m, t.area) ? undefined : lockedText(t.area),
  })))}`;
}

/** A feature's on/off switch: saves right away, and comes back to the page it's on. */
function powerSwitch(ctx: WorkspaceRequestContext, action: string, on: boolean, o: { label: string; blocked?: string; back?: Area }): SafeHtml {
  return html`<form method="post" action="${action}" class="bf-power">${csrfField(ctx.csrf)}<input type="hidden" name="section" value="power"><input type="hidden" name="back" value="${o.back ?? 'bot'}">
    <label class="row small" ${o.blocked ? html`title="${o.blocked}"` : ''}>${switchInput({ name: 'enabled', checked: on, label: o.label, disabled: Boolean(o.blocked) && !on, attrs: raw('data-autosubmit') })}<span>${on ? 'On' : 'Off'}</span></label>
  </form>`;
}

export function registerBotRoutes(app: FastifyInstance, web: Web): void {
  const { deps } = web;

  app.get('/w/:wid/bot', async (req, reply) => {
    const first = await web.requireWorkspace(req, reply, { permission: 'view' });
    if (!first) return reply;
    // No feature to open: the usual "no access" page.
    const ctx = canSeeTool(first.membership, 'bot') ? first : await web.requireWorkspace(req, reply, { permission: 'known-issues.view' });
    if (!ctx) return reply;
    const wid = ctx.workspace.id;
    const m = ctx.membership;
    const fact = (text: Content, o: { href?: string | null; tone?: 'accent' | 'warn'; mono?: boolean } = {}) => {
      const cls = `bf-fact${o.tone ? ` ${o.tone}` : ''}${o.mono ? ' mono' : ''}`;
      return o.href ? html`<a class="${cls}" href="${o.href}">${text}</a>` : html`<span class="${cls}">${text}</span>`;
    };

    const rows: SafeHtml[] = [];
    for (const f of FEATURE_IDS) {
      const href = featureHref(ctx, f);
      if (!href) continue;
      const def = FEATURES[f];
      const edit = can(m, `${def.settings}.edit`);
      let status: SafeHtml;
      let facts: SafeHtml[];
      let power: SafeHtml | '' = '';
      if (f === 'known-issues') {
        const [s, conn] = await Promise.all([getKnownIssuesSettings(deps.db, wid), getDiscordConnection(deps.db, wid)]);
        const [state, board] = await Promise.all([checkBoard(deps, wid, conn, { live: false }), computeBoard(deps, wid, s)]);
        const live = s.enabled && state.state === 'published';
        status = knownIssuesPill(s, state);
        facts = [
          fact(s.channelName ? `#${s.channelName}` : 'No channel yet', { mono: Boolean(s.channelName) }),
          fact(html`<b>${String(board.shown.length)}</b> ${live ? 'on the board' : 'would be on it'}`, { href: `${href}#on` }),
          board.hidden.length ? fact(html`<b>${String(board.hidden.length)}</b> hidden`, { href: `${href}#hidden` }) : null,
          state.state === 'published' ? fact(`changed ${timeAgo(state.changedAt)}`) : null,
        ].filter((x): x is SafeHtml => Boolean(x));
        if (edit) power = powerSwitch(ctx, `${ctx.base}/bot/known-issues/settings`, s.enabled, { label: 'Known-issues board turned on', blocked: s.channelId ? undefined : 'Choose its channel first: open it with the gear' });
      } else {
        const [s, counts, apps, appSettings] = await Promise.all([getAnnouncementSettings(deps.db, wid), announcementCounts(deps.db, wid), listApps(deps.db, wid), appAnnounceSettings(deps.db, wid)]);
        const posts = canOpen(m, 'releases') ? areaHref(ctx, 'releases') : null;
        status = releasesPill(s);
        facts = [
          fact(s.channelName ? `#${s.channelName}` : 'No channel yet', { mono: Boolean(s.channelName) }),
          fact(plural(announcedRepos(apps, appSettings).length, 'app')),
          fact(s.pingEnabled && s.roleName ? `pings @${s.roleName}` : 'no ping'),
          counts.waiting ? fact(html`<b>${String(counts.waiting)}</b> waiting to post`, { href: posts && `${posts}?show=waiting`, tone: 'accent' }) : null,
          counts.failed ? fact(html`<b>${String(counts.failed)}</b> failed`, { href: posts && `${posts}?show=waiting`, tone: 'warn' }) : null,
          fact(html`<b>${String(counts.posted30)}</b> posted in 30 days`, { href: posts && `${posts}?show=posted` }),
        ].filter((x): x is SafeHtml => Boolean(x));
        if (edit) power = powerSwitch(ctx, `${ctx.base}/bot/releases/settings`, s.enabled, { label: 'GitHub releases turned on', blocked: s.channelId ? undefined : 'Choose their channel first: open it with the gear' });
      }
      rows.push(html`<article class="bf-row" id="f-${f}" aria-labelledby="f-${f}-name">
        <span class="bf-icon" aria-hidden="true">${icon(def.icon, 20)}</span>
        <div class="bf-main">
          <div class="bf-title"><h2 id="f-${f}-name"><a href="${href}">${def.name}</a></h2>${status}</div>
          <p class="bf-about">${def.about}</p>
          <div class="bf-facts">${facts}</div>
        </div>
        <div class="bf-side">
          ${power}
          <a class="btn bf-gear" href="${href}" aria-label="${`Open ${def.name}: its settings and what it posted`}" title="Open and set up">${icon('settings', 16)}</a>
        </div>
      </article>`);
    }
    const locked = FEATURE_IDS.filter((f) => !featureHref(ctx, f));

    const body = html`
      ${pageHeader({ title: 'Bot features', description: 'Extra things the bot does in your Discord, each off until you turn it on. Switch them on or off here; the gear opens one to set it up.' })}
      <div class="bf-list">${rows}</div>
      ${locked.length ? html`<p class="xs muted bf-foot">${icon('lock', 12)} You don’t have access to ${locked.map((f) => FEATURES[f].name).join(' or ')}. Ask an admin if you need it.</p>` : ''}`;
    return web.render(reply, ctx, 'Bot features', 'bot', body);
  });
}

/** Where a feature's switch goes after saving: the page it was on (Bot features, or one of the feature's). */
export function backTo(ctx: Pick<WorkspaceRequestContext, 'base'>, body: Record<string, unknown>, fallback: string): string {
  const back = typeof body.back === 'string' ? body.back : '';
  if (back === 'bot') return `${ctx.base}/bot`;
  return isArea(back) && AREAS[back].tool === 'bot' ? areaHref(ctx, back) : fallback;
}
