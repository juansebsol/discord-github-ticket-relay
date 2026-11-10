import { handlePingComponent, PING_PREFIX } from '../announcements/pings.js';
import { handleContributorComponent } from '../domain/contributors.js';
import type { Processor } from '../domain/processor.js';
import { enabledTicketTypes, getTicketTypeByPublicId, type TicketType } from '../domain/ticket-types.js';
import { panelScope, serverApp, splitScope, withScope } from '../domain/linked.js';
import { panelSections } from '../domain/panel.js';
import { getDiscordConnectionByGuild, getGitHubConnection } from '../domain/store.js';
import { answerMax, filesId, formFor, MAX_FILES_LIMIT, questionId } from '../domain/forms.js';
import { acceptSubmission, type IncomingFile, type TicketAnswer } from '../domain/submissions.js';
import type { AppRow, Deps, DiscordConnectionRow, WorkspaceRow } from '../domain/types.js';
import { getWorkspace } from '../domain/workspaces.js';
import * as m from './messages.js';
import { handleMyTickets } from './my-tickets.js';

export const InteractionType = { Ping: 1, ApplicationCommand: 2, MessageComponent: 3, Autocomplete: 4, ModalSubmit: 5 } as const;
export const ResponseType = { Pong: 1, ChannelMessage: 4, DeferredChannelMessage: 5, DeferredUpdate: 6, UpdateMessage: 7, Modal: 9 } as const;

export interface Interaction {
  id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: { nick?: string | null; roles?: string[]; user: { id: string; username: string; global_name?: string | null } };
  user?: { id: string; username: string };
  data?: {
    custom_id?: string;
    values?: string[];
    components?: unknown[];
    resolved?: { attachments?: Record<string, { id: string; filename?: string; size?: number; url?: string; content_type?: string }> };
  };
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

/** Collects file upload values (attachment IDs) from a modal submission, by custom_id. */
export function modalFiles(components: unknown[] | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.custom_id === 'string' && Array.isArray(node.values)) out[node.custom_id] = node.values.filter((v: unknown) => typeof v === 'string');
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

  // The server's workspace (a main); a linked workspace's own panel tags its custom_ids with its ID.
  const conn = await getDiscordConnectionByGuild(deps.db, i.guild_id);
  const main = conn ? await getWorkspace(deps.db, conn.workspace_id) : null;
  if (!conn || !main || conn.status !== 'active') {
    return notice('Not set up', 'Ticket submission is not set up for this server.');
  }
  const [customId, scopeId] = splitScope(i.data?.custom_id ?? '');
  const scope = await panelScope(deps.db, main, scopeId);
  if (!scope) return notice('Out of date', 'This button is no longer active. Please use the current ticket panel.');
  const result = await route(deps, processor, i, { conn, main, scope, customId });
  // Replies to a linked workspace's own panel keep its tag, so the next click comes back to it too.
  if (scope.id === main.id) return result;
  const response = result.response as { data?: unknown };
  return { ...result, response: response.data ? { ...response, data: withScope(response.data, scope.id) } : response };
}

interface Route {
  conn: DiscordConnectionRow;
  /** The server's workspace: contributor roles and update pings are its. */
  main: WorkspaceRow;
  /** The panel the click came from: the main's, or a linked workspace's own. Its apps are listed. */
  scope: WorkspaceRow;
  customId: string;
}

async function route(deps: Deps, processor: Processor, i: Interaction, { conn, main, scope, customId }: Route): Promise<InteractionResult> {
  // ---- App picker -------------------------------------------------------------------------
  if (i.type === InteractionType.MessageComponent) {
    // Contributor-role panel (separate feature, separate custom_id prefix).
    if (customId.startsWith('cv:')) return handleContributorComponent(deps, i, main);
    // Release announcements: a member turns update pings on or off.
    if (customId.startsWith(PING_PREFIX)) return handlePingComponent(deps, i, main);
    // A page of the private menu: all the panel's apps, or one workspace's ("More apps…" in its menu).
    const pageMatch = /^tr:page:(-?\d+)(?::([0-9a-f-]{36}))?$/.exec(customId);
    if (pageMatch) {
      const { apps, sections } = await panelSections(deps.db, scope);
      const page = Number(pageMatch[1]) || 0;
      const section = pageMatch[2] ? sections.find((s) => s.id === pageMatch[2]) : undefined;
      if (pageMatch[2] && !section) return notice('Out of date', 'This menu is no longer active. Please use the current ticket panel.');
      const { flags: _flags, ...data } = section ? m.buildSectionPage(section, page) : m.buildPickerPage(apps.map(toPanelApp), page);
      return { response: { type: ResponseType.UpdateMessage, data } };
    }
    // Panel buttons: Open a ticket (the app menu, privately; one app goes straight on) and My tickets.
    if (customId === m.CustomId.openTicket) {
      const { apps, sections } = await panelSections(deps.db, scope);
      if (!apps.length) return notice('No apps yet', 'No app is taking tickets here right now. Please ask a server admin.');
      if (apps.length === 1) {
        const only = await serverApp(deps.db, main, apps[0]!.public_id);
        if (only) return startTicket(deps, only.workspace, only.app, { update: false });
      }
      return { response: { type: ResponseType.ChannelMessage, data: m.buildAppPicker(apps.map(toPanelApp), sections) } };
    }
    if (customId === m.CustomId.myTickets || customId.startsWith('tr:mine:')) return handleMyTickets(deps, i, scope, customId);
    // An app menu: the panel's (one, or one per workspace) or the private one's.
    const fromPicker = customId === m.CustomId.pickerSelect || customId.startsWith(`${m.CustomId.pickerSelect}:`);
    if (fromPicker || customId === m.CustomId.panelSelect || customId.startsWith(`${m.CustomId.panelSelect}:`)) {
      const value = i.data?.values?.[0] ?? '';
      if (value === m.MORE_APPS_VALUE || value.startsWith(`${m.MORE_APPS_VALUE}:`)) {
        const { apps, sections } = await panelSections(deps.db, scope);
        const id = value.slice(m.MORE_APPS_VALUE.length + 1);
        const section = id ? sections.find((s) => s.id === id) : undefined;
        if (id && !section) return notice('Out of date', 'This menu is no longer active. Please use the current ticket panel.');
        const data = section ? m.buildSectionPage(section, 0) : m.buildPickerPage(apps.map(toPanelApp), 0);
        // From the private menu, the list replaces it; from the panel, it's a new private message.
        if (fromPicker) {
          const { flags: _flags, ...update } = data;
          return { response: { type: ResponseType.UpdateMessage, data: update } };
        }
        return { response: { type: ResponseType.ChannelMessage, data } };
      }
      // The app files in its own workspace (a linked workspace's app on the main's panel too).
      const picked = await serverApp(deps.db, main, value);
      if (!picked || !picked.app.enabled) {
        return notice('App unavailable', 'That app is no longer accepting tickets here. The menu may be out of date; please pick another app or ask a server admin.');
      }
      // From the private menu, the next step replaces it rather than stacking under it.
      return startTicket(deps, picked.workspace, picked.app, { update: fromPicker });
    }
    const typeMatch = /^tr:type:([0-9A-Z]{10}):(\d+)$/.exec(customId);
    if (typeMatch) {
      const picked = await serverApp(deps.db, main, typeMatch[1]!);
      if (!picked || !picked.app.enabled || picked.app.repo_id !== Number(typeMatch[2])) {
        return notice('App unavailable', 'That app is no longer accepting tickets here. Please start again from the ticket panel.');
      }
      const { app, workspace } = picked;
      const type = await getTicketTypeByPublicId(deps.db, workspace.id, i.data?.values?.[0] ?? '');
      if (!type || !type.enabled) return notice('Type unavailable', 'That ticket type is no longer available. Please start again from the ticket panel.');
      return {
        response: {
          type: ResponseType.Modal,
          data: m.buildTicketModal(
            ticketApp(app, workspace),
            { publicId: type.public_id, name: type.name, guidance: type.guidance, placeholder: type.placeholder },
            formFor(type),
          ),
        },
      };
    }
    return notice('Out of date', 'This button is no longer active. Please use the current ticket panel.');
  }

  // ---- My tickets: details or screenshots added to a ticket -----------------------------------
  if (customId.startsWith('tr:mine:')) return handleMyTickets(deps, i, scope, customId);

  // ---- Ticket form submitted ----------------------------------------------------------------
  const match = /^tr:form:([0-9A-Z]{10}):(\d+)(?::([0-9A-Z]{8}))?$/.exec(customId);
  if (!match) return notice('Out of date', 'This form is no longer active. Please use the current ticket panel.');
  const [, publicId, repoIdText, typePublicId] = match;
  const values = modalValues(i.data?.components);
  const ticket = {
    title: (values[m.CustomId.titleInput] ?? '').replace(/\s+/g, ' ').trim(),
    description: (values[m.CustomId.descriptionInput] ?? '').trim(),
  };
  if (ticket.title.length < 3 || ticket.title.length > m.TITLE_MAX || ticket.description.length < 10 || ticket.description.length > m.DESCRIPTION_MAX) {
    return echo('Please check your ticket', `The title needs 3–${m.TITLE_MAX} characters and the description 10–${m.DESCRIPTION_MAX} characters.`, ticket);
  }

  const picked = await serverApp(deps.db, main, publicId!);
  if (!picked || !picked.app.enabled) {
    return echo('App unavailable', 'This app stopped accepting tickets while you were filling in the form, so your ticket was not sent.', ticket);
  }
  // Filed in the app's own workspace: its GitHub connection, ticket types, limits and tickets.
  const { app, workspace } = picked;
  if (app.repo_id !== Number(repoIdText)) {
    // Don't silently send a ticket somewhere other than where it was routed when the form opened.
    return echo('Please submit again', 'The ticket settings for this app changed while you were filling in the form, so your ticket was not sent. Please open the form again from the panel.', ticket);
  }
  const gh = await getGitHubConnection(deps.db, workspace.id);
  if (!gh || gh.status !== 'active') return echo('Temporarily unavailable', UNAVAILABLE, ticket);
  // A type removed or disabled while the form was open: file the ticket anyway, without it.
  const type: TicketType | null = typePublicId ? await getTicketTypeByPublicId(deps.db, workspace.id, typePublicId) : null;

  // Answers to the type's own questions, labelled with the question as it reads now. A
  // question removed while the form was open is dropped; empty optional answers are skipped.
  const form = formFor(type);
  const answers: TicketAnswer[] = [];
  const files: IncomingFile[] = [];
  const uploads = modalFiles(i.data?.components);
  const resolved = i.data?.resolved?.attachments ?? {};
  for (const s of form) {
    if (s.kind === 'short' || s.kind === 'paragraph') {
      const value = (values[questionId(s.key)] ?? '').trim().slice(0, answerMax(s.kind));
      if (value) answers.push({ question: s.label, value });
    } else if (s.kind === 'files') {
      for (const id of (uploads[filesId(s.key)] ?? []).slice(0, Math.min(s.maxFiles, MAX_FILES_LIMIT))) {
        const a = resolved[id];
        if (a?.url) files.push({ filename: a.filename ?? 'file', size: a.size ?? 0, url: a.url, contentType: a.content_type ?? null });
      }
    }
  }

  const member = i.member!;
  const result = await acceptSubmission(deps, {
    workspace,
    app,
    installationId: gh.installation_id,
    source: 'discord',
    interactionId: i.id,
    interactionToken: i.token,
    guildId: i.guild_id!,
    guildName: conn.guild_name,
    channelId: i.channel_id ?? null,
    reporter: {
      id: member.user.id,
      displayName: member.nick || member.user.global_name || member.user.username,
      username: member.user.username,
    },
    title: ticket.title,
    description: ticket.description,
    answers,
    files,
    ticketType: type && type.enabled ? { name: type.name, label: type.label, titlePrefix: type.title_prefix || type.name } : null,
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

function toFormTypeOption(t: TicketType) {
  return { publicId: t.public_id, name: t.name, description: t.description };
}

function toPanelApp(a: { public_id: string; name: string; description: string | null }): m.PanelApp {
  return { publicId: a.public_id, name: a.name, description: a.description };
}

/** An app was chosen: its ticket types to choose from (required when there are any), else its form. */
async function startTicket(deps: Deps, workspace: WorkspaceRow, app: AppRow, o: { update: boolean }): Promise<InteractionResult> {
  const gh = await getGitHubConnection(deps.db, workspace.id);
  if (!gh || gh.status !== 'active') return notice('Temporarily unavailable', UNAVAILABLE);
  const types = await enabledTicketTypes(deps.db, workspace.id);
  if (!types.length) return { response: { type: ResponseType.Modal, data: m.buildTicketModal(ticketApp(app, workspace)) } };
  const { flags, ...picker } = m.buildTypePicker(ticketApp(app, workspace), types.map(toFormTypeOption));
  return { response: o.update ? { type: ResponseType.UpdateMessage, data: picker } : { type: ResponseType.ChannelMessage, data: { ...picker, flags } } };
}

/** The app for the type picker and the form, with the workspace's notice for its repository. */
function ticketApp(a: { public_id: string; name: string; repo_id: number; repo_private: boolean }, ws: WorkspaceRow): m.TicketApp {
  return { publicId: a.public_id, name: a.name, repoId: a.repo_id, repoPrivate: a.repo_private, notice: m.visibilityNotice(a.repo_private, ws) };
}
