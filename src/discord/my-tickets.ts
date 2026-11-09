/**
 * My tickets in Discord: the member's list, one ticket's page, and what they can do on an open one
 * (add details, add screenshots, close it) when admins allow it. Every reply is private, and every
 * ticket is checked to be theirs. An action answers at once ("Adding your details…") and fills in
 * how it went when GitHub has answered.
 */
import {
  addDetails, addScreenshots, closeMine, memberActions, ownSubmission, waitMinutes, MAX_NEW_FILES, MEMBER_CLOSE, type MemberCloseKey,
} from '../domain/member-actions.js';
import { panelWorkspaces, withScope } from '../domain/linked.js';
import { closeConfirm, detailsModal, myTicketDetail, myTicketsPage, panelTickets, screenshotsModal, statusWords, type MemberTicket } from '../domain/my-tickets.js';
import { UserFacingError, type Deps, type WorkspaceRow } from '../domain/types.js';
import { GitHubApiError } from '../github/client.js';
import { modalFiles, modalValues, type Interaction, type InteractionResult } from './interactions.js';
import * as m from './messages.js';

const R = { ChannelMessage: 4, UpdateMessage: 7, Modal: 9 } as const;

/** The message the button was on, changed in place (a reply's private flag can't change). */
function update(data: { flags?: number }): InteractionResult {
  const { flags: _flags, ...rest } = data;
  return { response: { type: R.UpdateMessage, data: rest } };
}

function edited(data: { flags?: number }) {
  const { flags: _flags, ...rest } = data;
  return rest;
}

const ACTION = /^tr:mine:(v|d|f|c|cw|cn):([A-Za-z0-9-]{1,40}):(\d+)$/;

/**
 * Clicks and forms from My tickets (custom_id "tr:mine…") on a panel: the main's lists the tickets
 * of its linked workspaces on it too. Each ticket follows its own workspace's switches and limits.
 */
export async function handleMyTickets(deps: Deps, i: Interaction, panel: WorkspaceRow, customId: string): Promise<InteractionResult> {
  if (!panel.my_tickets) {
    return { response: { type: R.ChannelMessage, data: m.noticeMessage('Not available', 'My tickets is turned off on this server. The panel may be out of date; please ask a server admin.') } };
  }
  const userId = i.member!.user.id;
  const family = await panelWorkspaces(deps.db, panel);
  const [tickets, words] = await Promise.all([panelTickets(deps, family.map((w) => w.id), userId), statusWords(deps, panel.id)]);
  // The ticket's workspace: what members may do on it, its notice, and where it's changed.
  const home = (t: MemberTicket) => family.find((w) => w.id === t.workspaceId) ?? panel;
  const pageMatch = /^tr:mine:p:(\d+)$/.exec(customId);
  if (pageMatch) return update(myTicketsPage(tickets, Number(pageMatch[1]), words));
  const pickMatch = /^tr:mine:t:(\d+)$/.exec(customId);
  if (pickMatch) {
    // Only one of their own: anything else shows the list again.
    const ticket = tickets.find((t) => t.ref === i.data?.values?.[0]);
    return update(ticket ? myTicketDetail(ticket, Number(pickMatch[1]), words, { actions: memberActions(home(ticket)) }) : myTicketsPage(tickets, Number(pickMatch[1]), words));
  }
  const match = ACTION.exec(customId);
  if (!match) return { response: { type: R.ChannelMessage, data: myTicketsPage(tickets, 0, words) } };

  const [, action, ref, pageText] = match;
  const page = Number(pageText);
  const t = tickets.find((x) => x.ref === ref);
  if (!t) return update(myTicketsPage(tickets, page, words));
  const workspace = home(t);
  const actions = memberActions(workspace);
  const isModal = i.type === 5;
  // Details they wrote come back whenever they can't be added, so nothing typed is lost.
  const details = isModal && action === 'd' ? (modalValues(i.data?.components)[m.CustomId.detailsInput] ?? '').trim() : '';
  const echo = details ? `\nHere’s what you wrote, so you can copy it:\n${quote(details)}` : '';
  const show = (banner?: string) => myTicketDetail(t, page, words, { actions, banner: banner && `${banner}${echo}` });
  if (action === 'v') return update(show());

  // Each action: still allowed, still open, and not too many updates lately.
  const allowed = action === 'd' ? actions.details : action === 'f' ? actions.files : actions.close;
  if (!allowed) return update(show('This isn’t available anymore. A server admin turned it off.'));
  if (!t.issueOpen) return update(show('This ticket is closed, so it can’t be changed from here anymore.'));
  // Others' reports follow this one: closing it would close theirs too.
  if ((action === 'c' || action === 'cw' || action === 'cn') && t.shared) return update(show('Other people reported the same problem, so the team will close this ticket when it’s sorted out.'));
  if (action === 'd' || action === 'f') {
    const wait = await waitMinutes(deps.db, workspace.id, userId);
    if (wait) return update(show(`You’ve added to your tickets several times in the last hour. You can add more in about ${wait} minute${wait === 1 ? '' : 's'}.`));
  }
  const notice = m.visibilityNotice(t.repoPrivate, workspace);

  if (action === 'd' && !isModal) return { response: { type: R.Modal, data: detailsModal(t, page, notice) } };
  if (action === 'f' && !isModal) return { response: { type: R.Modal, data: screenshotsModal(t, page, notice) } };
  if (action === 'c') return update(closeConfirm(t, page));

  const sub = await ownSubmission(deps.db, workspace.id, userId, t.ref);
  if (!sub) return update(show('This ticket can’t be changed from here.'));
  const name = i.member!.nick || i.member!.user.global_name || i.member!.user.username;

  // The work, done after answering; then the ticket's page shows how it went.
  const finish = (work: () => Promise<string>, failed: (err: unknown) => string) => async () => {
    let banner: string;
    try {
      banner = await work();
    } catch (err) {
      if (!(err instanceof UserFacingError) && !(err instanceof GitHubApiError)) deps.log.error({ err: (err as Error).message, submission: t.ref }, 'my tickets action failed');
      else deps.log.warn({ err: (err as Error).message, submission: t.ref }, 'my tickets action failed');
      banner = failed(err);
    }
    const fresh = (await panelTickets(deps, [workspace.id], userId).catch(() => [] as MemberTicket[])).find((x) => x.ref === t.ref) ?? t;
    // A linked workspace's own panel: its buttons keep the panel's tag.
    await deps.discord?.editOriginalResponse(i.token, withScope(edited(myTicketDetail(fresh, page, words, { actions, banner })), panel.parent_id ? panel.id : null))
      .catch((err) => deps.log.warn({ err: (err as Error).message }, 'my tickets reply failed'));
  };
  const later = 'Please try again in a few minutes.';

  if (action === 'd') {
    if (details.length < 10) return update(show('Please write a little more: at least 10 characters.'));
    return {
      response: update(myTicketDetail(t, page, words, { banner: '⏳ Adding your details…', busy: true })).response,
      after: finish(
        async () => ((await addDetails(deps, workspace, sub, details)) === 'repeat' ? 'You already added these details.' : '✅ Your details were added to the ticket. Thanks!'),
        // Their words back, so nothing they wrote is lost.
        () => `⚠️ Your details couldn’t be added right now. ${later}${echo}`,
      ),
    };
  }

  if (action === 'f') {
    const ids = (modalFiles(i.data?.components)[m.CustomId.screenshotsInput] ?? []).slice(0, MAX_NEW_FILES);
    const resolved = i.data?.resolved?.attachments ?? {};
    const files = ids.map((id) => resolved[id]).filter((a) => a?.url).map((a) => ({ filename: a!.filename ?? 'file', size: a!.size ?? 0, url: a!.url!, contentType: a!.content_type ?? null }));
    if (!files.length) return update(show('Please add at least one screenshot.'));
    return {
      response: update(myTicketDetail(t, page, words, { banner: `⏳ Adding your screenshot${files.length === 1 ? '' : 's'}…`, busy: true })).response,
      after: finish(async () => {
        const r = await addScreenshots(deps, workspace, sub, files);
        const failed = r.failed.map((f) => `- ${m.escapeMarkdown(f.filename)}: ${f.error}`).join('\n');
        if (!r.added) return `⚠️ Your screenshot${files.length === 1 ? ' wasn’t' : 's weren’t'} added:\n${failed}`;
        const added = `✅ Added ${r.added} screenshot${r.added === 1 ? '' : 's'} to the ticket. Thanks!`;
        return failed ? `${added}\n${r.failed.length === 1 ? 'One wasn’t' : `${r.failed.length} weren’t`} added:\n${failed}` : added;
      }, () => `⚠️ Your screenshots couldn’t be added right now. ${later}`),
    };
  }

  // cw / cn: close it, for that reason.
  const why: MemberCloseKey = action === 'cw' ? 'works' : 'notNeeded';
  return {
    response: update(myTicketDetail(t, page, words, { banner: '⏳ Closing your ticket…', busy: true })).response,
    after: finish(async () => {
      const r = await closeMine(deps, workspace, sub, why, name);
      if (r.status === 'skipped') return r.note === 'It was already closed' ? 'This ticket was already closed.' : `It couldn’t be closed: ${r.note.toLowerCase()}.`;
      return `✅ Your ticket was closed (${MEMBER_CLOSE[why].story}). Thanks for letting the team know.`;
    }, () => `⚠️ Your ticket couldn’t be closed right now. ${later}`),
  };
}

/** Their text as a Discord quote, so it reads as theirs and copies cleanly. */
function quote(text: string): string {
  return m.truncate(text.split('\n').map((l) => `> ${l}`).join('\n'), 1500);
}
