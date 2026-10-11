import type { Processor } from '../domain/processor.js';
import { getAppByPublicId, getDiscordConnectionByGuild, getGitHubConnection, listApps } from '../domain/store.js';
import { acceptSubmission } from '../domain/submissions.js';
import type { Deps } from '../domain/types.js';
import { getWorkspace } from '../domain/workspaces.js';
import * as m from './messages.js';

export const InteractionType = { Ping: 1, ApplicationCommand: 2, MessageComponent: 3, Autocomplete: 4, ModalSubmit: 5 } as const;
export const ResponseType = { Pong: 1, ChannelMessage: 4, DeferredChannelMessage: 5, DeferredUpdate: 6, UpdateMessage: 7, Modal: 9 } as const;

export interface Interaction {
  id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { nick?: string | null; user: { id: string; username: string; global_name?: string | null } };
  user?: { id: string; username: string };
  data?: { custom_id?: string; values?: string[]; components?: unknown[] };
}

export interface InteractionResult {
  response: unknown;
  /** Work to start once the response has been sent (kept out of the 3-second window). */
  after?: () => Promise<void>;
}

function notice(title: string, description: string): InteractionResult {
  return { response: { type: ResponseType.ChannelMessage, data: m.noticeMessage(title, description) } };
}

function echo(title: string, explanation: string, ticket: { title: string; description: string }): InteractionResult {
  return { response: { type: ResponseType.ChannelMessage, data: m.textEchoMessage(title, explanation, ticket) } };
}

/** Collects text input values from a modal submission (Label-wrapped or legacy action rows). */
export function modalValues(components: unknown[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.custom_id === 'string' && typeof node.value === 'string') out[node.custom_id] = node.value;
    if (node.component) visit(node.component);
    if (Array.isArray(node.components)) node.components.forEach(visit);
  };
  (components ?? []).forEach(visit);
  return out;
}

const UNAVAILABLE =
  'Ticket submission is temporarily unavailable. The server admins have been shown what needs fixing; please try again later.';

export async function handleInteraction(deps: Deps, processor: Processor, i: Interaction): Promise<InteractionResult> {
  if (i.type === InteractionType.Ping) return { response: { type: ResponseType.Pong } };
  if (i.type !== InteractionType.MessageComponent && i.type !== InteractionType.ModalSubmit) {
    return notice('Not supported', 'This bot only handles the ticket panel.');
  }
  if (!i.guild_id || !i.member) {
    return notice('Use the server panel', 'Tickets can only be submitted from the ticket panel in a server.');
  }

  const conn = await getDiscordConnectionByGuild(deps.db, i.guild_id);
  const workspace = conn ? await getWorkspace(deps.db, conn.workspace_id) : null;
  if (!conn || !workspace || conn.status !== 'active') {
    return notice('Not set up', 'Ticket submission is not set up for this server.');
  }
  const customId = i.data?.custom_id ?? '';

  // ---- App picker -------------------------------------------------------------------------
  if (i.type === InteractionType.MessageComponent) {
    if (customId.startsWith('tr:page:')) {
      const apps = (await listApps(deps.db, workspace.id)).filter((a) => a.enabled);
      const page = Number(customId.slice('tr:page:'.length)) || 0;
      const { flags: _flags, ...data } = m.buildPickerPage(apps.map(toPanelApp), page);
      return { response: { type: ResponseType.UpdateMessage, data } };
    }
    if (customId === m.CustomId.panelSelect || customId === m.CustomId.pickerSelect) {
      const value = i.data?.values?.[0] ?? '';
      if (value === m.MORE_APPS_VALUE) {
        const apps = (await listApps(deps.db, workspace.id)).filter((a) => a.enabled);
        return { response: { type: ResponseType.ChannelMessage, data: m.buildPickerPage(apps.map(toPanelApp), 0) } };
      }
      const app = await getAppByPublicId(deps.db, workspace.id, value);
      if (!app || !app.enabled) {
        return notice('App unavailable', 'That app is no longer accepting tickets here. The menu may be out of date; please pick another app or ask a server admin.');
      }
      const gh = await getGitHubConnection(deps.db, workspace.id);
      if (!gh || gh.status !== 'active') return notice('Temporarily unavailable', UNAVAILABLE);
      return {
        response: {
          type: ResponseType.Modal,
          data: m.buildTicketModal({ publicId: app.public_id, name: app.name, repoId: app.repo_id, repoPrivate: app.repo_private }),
        },
      };
    }
    return notice('Out of date', 'This button is no longer active. Please use the current ticket panel.');
  }

  // ---- Ticket form submitted ----------------------------------------------------------------
  const match = /^tr:form:([0-9A-Z]{10}):(\d+)$/.exec(customId);
  if (!match) return notice('Out of date', 'This form is no longer active. Please use the current ticket panel.');
  const [, publicId, repoIdText] = match;
  const values = modalValues(i.data?.components);
  const ticket = {
    title: (values[m.CustomId.titleInput] ?? '').replace(/\s+/g, ' ').trim(),
    description: (values[m.CustomId.descriptionInput] ?? '').trim(),
  };
  if (ticket.title.length < 3 || ticket.title.length > m.TITLE_MAX || ticket.description.length < 10 || ticket.description.length > m.DESCRIPTION_MAX) {
    return echo('Please check your ticket', `The title needs 3–${m.TITLE_MAX} characters and the description 10–${m.DESCRIPTION_MAX} characters.`, ticket);
  }

  const app = await getAppByPublicId(deps.db, workspace.id, publicId!);
  if (!app || !app.enabled) {
    return echo('App unavailable', 'This app stopped accepting tickets while you were filling in the form, so your ticket was not sent.', ticket);
  }
  if (app.repo_id !== Number(repoIdText)) {
    // Don't silently send a ticket somewhere other than where it was routed when the form opened.
    return echo('Please submit again', 'The ticket settings for this app changed while you were filling in the form, so your ticket was not sent. Please open the form again from the panel.', ticket);
  }
  const gh = await getGitHubConnection(deps.db, workspace.id);
  if (!gh || gh.status !== 'active') return echo('Temporarily unavailable', UNAVAILABLE, ticket);

  const member = i.member;
  const result = await acceptSubmission(deps, {
    workspace,
    app,
    installationId: gh.installation_id,
    source: 'discord',
    interactionId: i.id,
    interactionToken: i.token,
    guildId: i.guild_id,
    guildName: conn.guild_name,
    channelId: i.channel_id ?? null,
    reporter: {
      id: member.user.id,
      displayName: member.nick || member.user.global_name || member.user.username,
      username: member.user.username,
    },
    title: ticket.title,
    description: ticket.description,
  });

  switch (result.kind) {
    case 'accepted':
      deps.log.info({ submission: result.submission.ref, workspace: workspace.id, app: app.public_id }, 'ticket accepted');
      return {
        response: { type: ResponseType.DeferredChannelMessage, data: { flags: m.EPHEMERAL } },
        after: () => processor.processNow(result.submission.id),
      };
    case 'duplicate_delivery':
      return { response: { type: ResponseType.DeferredChannelMessage, data: { flags: m.EPHEMERAL } } };
    case 'duplicate_content': {
      const e = result.existing;
      const where = e.issue_number ? ` It is ticket #${e.issue_number}.` : '';
      return notice('Already submitted', `You already sent this ticket a moment ago (reference \`${e.ref}\`).${where} There is no need to send it again.`);
    }
    case 'rate_limited': {
      const minutes = Math.ceil(result.retryAfterSeconds / 60);
      return echo(
        'Please wait a moment',
        `You have submitted several tickets in a short time. You can submit another in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        ticket,
      );
    }
  }
}

function toPanelApp(a: { public_id: string; name: string; description: string | null }): m.PanelApp {
  return { publicId: a.public_id, name: a.name, description: a.description };
}
