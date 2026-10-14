import { handleContributorComponent } from '../domain/contributors.js';
import type { Processor } from '../domain/processor.js';
import { enabledTicketTypes, getTicketTypeByPublicId, type TicketType } from '../domain/ticket-types.js';
import { getAppByPublicId, getDiscordConnectionByGuild, getGitHubConnection, listApps } from '../domain/store.js';
import { answerMax, filesId, formFor, MAX_FILES_LIMIT, questionId } from '../domain/forms.js';
import { acceptSubmission, type IncomingFile, type TicketAnswer } from '../domain/submissions.js';
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

  const conn = await getDiscordConnectionByGuild(deps.db, i.guild_id);
  const workspace = conn ? await getWorkspace(deps.db, conn.workspace_id) : null;
  if (!conn || !workspace || conn.status !== 'active') {
    return notice('Not set up', 'Ticket submission is not set up for this server.');
  }
  const customId = i.data?.custom_id ?? '';

  // ---- App picker -------------------------------------------------------------------------
  if (i.type === InteractionType.MessageComponent) {
    // Contributor-role panel (separate feature, separate custom_id prefix).
    if (customId.startsWith('cv:')) return handleContributorComponent(deps, i, workspace);
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
      // With ticket types configured, members choose one before the form (required).
      const types = await enabledTicketTypes(deps.db, workspace.id);
      if (types.length) {
        const picker = m.buildTypePicker({ publicId: app.public_id, name: app.name, repoId: app.repo_id, repoPrivate: app.repo_private }, types.map(toFormTypeOption));
        return { response: { type: ResponseType.ChannelMessage, data: picker } };
      }
      return {
        response: {
          type: ResponseType.Modal,
          data: m.buildTicketModal({ publicId: app.public_id, name: app.name, repoId: app.repo_id, repoPrivate: app.repo_private }),
        },
      };
    }
    const typeMatch = /^tr:type:([0-9A-Z]{10}):(\d+)$/.exec(customId);
    if (typeMatch) {
      const app = await getAppByPublicId(deps.db, workspace.id, typeMatch[1]!);
      if (!app || !app.enabled || app.repo_id !== Number(typeMatch[2])) {
        return notice('App unavailable', 'That app is no longer accepting tickets here. Please start again from the ticket panel.');
      }
      const type = await getTicketTypeByPublicId(deps.db, workspace.id, i.data?.values?.[0] ?? '');
      if (!type || !type.enabled) return notice('Type unavailable', 'That ticket type is no longer available. Please start again from the ticket panel.');
      return {
        response: {
          type: ResponseType.Modal,
          data: m.buildTicketModal(
            { publicId: app.public_id, name: app.name, repoId: app.repo_id, repoPrivate: app.repo_private },
            { publicId: type.public_id, name: type.name, guidance: type.guidance, placeholder: type.placeholder },
            formFor(type),
          ),
        },
      };
    }
    return notice('Out of date', 'This button is no longer active. Please use the current ticket panel.');
  }

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
