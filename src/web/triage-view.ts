/**
 * How triage actions are shown: on the ticket page, in the inbox and in re-run results. Every
 * suggestion says exactly what Apply does (labels, the comment text, closing, Discord).
 */
import { html, type SafeHtml } from '../lib/html.js';
import { actionLabels, commentFor, type TriageAction } from '../triage/engine.js';
import { MISSING_SHORT, type Priority } from '../triage/settings.js';
import { icon, labelTag } from './ui.js';

const PRIORITY_NAMES: Record<Priority, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

export function priorityTag(p: Priority): SafeHtml {
  return html`<span class="tag"><span class="dot p-${p}" aria-hidden="true"></span>${PRIORITY_NAMES[p]}</span>`;
}

type Repo = { owner: string; name: string };

function issueLink(repo: Repo, n: number | undefined): SafeHtml {
  return html`<a href="https://github.com/${repo.owner}/${repo.name}/issues/${String(n)}" target="_blank" rel="noopener noreferrer">#${String(n)}</a>`;
}

/** "owner/repo#12" as a link, shortened to "#12" in the ticket's own repository. */
function refLink(repo: Repo, ref: string): SafeHtml {
  const m = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(ref);
  if (!m) return html`${ref}`;
  const own = `${m[1]}/${m[2]}`.toLowerCase() === `${repo.owner}/${repo.name}`.toLowerCase();
  return html`<a href="https://github.com/${m[1]}/${m[2]}/issues/${m[3]}" target="_blank" rel="noopener noreferrer">${own ? `#${m[3]}` : ref}</a>`;
}

function joined(items: SafeHtml[]): SafeHtml {
  return html`${items.map((x, i) => html`${i ? (i === items.length - 1 ? ' and ' : ', ') : ''}${x}`)}`;
}

/** What triage found, in a few words (with links). */
export function actionTitle(a: TriageAction, repo: Repo): SafeHtml {
  switch (a.kind) {
    case 'priority':
      return a.priority ? html`${priorityTag(a.priority)} priority` : html`Priority`;
    case 'duplicate':
      return html`Duplicate of ${issueLink(repo, a.duplicateOf)}${a.originalClosed ? html`<span class="muted"> · the original is closed, so this is only suggested</span>` : ''}`;
    case 'regression':
      return html`Regression of ${issueLink(repo, a.regressionOf)}<span class="muted"> · closed as fixed, reported again</span>`;
    case 'needsInfo':
      return html`Needs more info${a.missing?.length ? html`<span class="muted"> · ${a.missing.map((m) => MISSING_SHORT[m]).join(', ')}</span>` : ''}`;
    case 'multiple':
      return html`Reports ${String(a.parts?.length ?? 'several')} separate problems`;
    case 'related':
      return html`Related to ${joined((a.related ?? []).map((r) => refLink(repo, r)))}`;
    case 'shared':
      return html`Shared problem${a.sharedApps?.length ? html` with ${a.sharedApps.join(', ')}` : ''}${a.sharedIssue ? html`<span class="muted"> · tracked in ${refLink(repo, a.sharedIssue)}</span>` : ''}`;
    case 'wrongRepo':
      return html`Belongs to ${a.rightApp ?? 'another app'}${a.rightRepo ? html`<span class="muted"> · ${a.rightRepo}</span>` : ''}`;
    case 'spam':
      return html`Spam`;
    case 'support':
      return html`Not a development issue`;
    case 'noAction':
      return html`No action needed`;
    default:
      return html`${a.groupName ?? 'Labels'}: <span class="tags">${(a.labels ?? []).map(labelTag)}</span>`;
  }
}

/** What Apply does, step by step (the comment in full). */
export function actionEffects(a: TriageAction, o: { done?: boolean } = {}): SafeHtml {
  const labels = actionLabels(a);
  const comment = commentFor([a]);
  const steps: SafeHtml[] = [];
  if (labels.length) steps.push(html`<li>${icon('tag', 14)}<span>${o.done ? 'Added' : 'Adds'} ${labels.length === 1 ? 'the label' : 'the labels'} <span class="tags">${labels.map(labelTag)}</span></span></li>`);
  if (comment) steps.push(html`<li>${icon('message-square', 14)}<span>${o.done ? 'Posted' : 'Posts'} this comment on GitHub:<span class="tri-comment">${comment}</span></span></li>`);
  if (a.close) steps.push(html`<li>${icon('circle-x', 14)}<span>${o.done ? 'Closed' : 'Closes'} the issue as not planned</span></li>`);
  if (a.memberNote) steps.push(html`<li>${icon('bell', 14)}<span>${o.done ? 'Told' : 'Tells'} the member in Discord, if the ticket was filed less than 15 minutes ago (Discord’s limit)</span></li>`);
  if (a.kind === 'spam' && a.close) steps.push(html`<li>${icon('trash-2', 14)}<span>Deletes the ticket’s files if your Files cleanup rules delete spam</span></li>`);
  if (!steps.length) steps.push(html`<li>${icon('info', 14)}<span>Nothing changes on GitHub: this action has no label, comment or closing set up.</span></li>`);
  return html`<ul class="tri-effects">${steps}</ul>`;
}

/** A short line of what Apply does, for summaries and tooltips. */
export function actionEffectsShort(a: TriageAction): string {
  const labels = actionLabels(a);
  return [
    labels.length ? `adds ${labels.map((l) => `“${l}”`).join(', ')}` : '',
    commentFor([a]) ? 'comments' : '',
    a.close ? 'closes the issue' : '',
    a.memberNote ? 'tells the member' : '',
  ].filter(Boolean).join(' · ') || 'no change on GitHub';
}
