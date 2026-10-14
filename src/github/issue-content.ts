export const MARKER_PREFIX = 'ticket-relay:submission=';

export function submissionMarker(ref: string): string {
  return `<!-- ${MARKER_PREFIX}${ref} -->`;
}

export interface IssueContentInput {
  ref: string;
  appName: string;
  title: string;
  description: string;
  reporterDisplayName: string;
  reporterUsername: string | null;
  reporterDiscordId: string;
  submittedAt: Date;
  guildName: string | null;
  guildId: string | null;
  channelId: string | null;
  isTest: boolean;
  ticketType?: string | null;
  /** Answers to the ticket type's own questions; each becomes a section. */
  answers?: { question: string; value: string }[];
  /** The Attachments section (see domain/files.ts). */
  filesBlock?: string | null;
}

const GITHUB_TITLE_MAX = 256;

/**
 * Stops user-written text from @-mentioning GitHub users/teams or closing issues by
 * keyword, while leaving fenced and inline code untouched.
 */
export function neutralizeGitHubMentions(text: string): string {
  const lines = text.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((part, i) => (i % 2 === 1 ? part : part.replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, '$1@\u200b')))
        .join('');
    })
    .join('\n');
}

/** Table cells must not contain pipes or newlines. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
}

/** A question used as a heading: one line, no Markdown heading marks. */
function headingText(q: string): string {
  return neutralizeGitHubMentions(q.replace(/[\r\n#]+/g, ' ').replace(/\s+/g, ' ').trim()) || 'Answer';
}

export function buildIssueTitle(appName: string, title: string, isTest: boolean, typePrefix: string | null = null): string {
  const prefix = `${isTest ? '[Test] ' : ''}${typePrefix ? `[${typePrefix.replace(/[\[\]\r\n]/g, '').trim()}] ` : ''}[${appName}] `;
  const full = prefix + title.replace(/[\r\n]+/g, ' ').trim();
  return full.length > GITHUB_TITLE_MAX ? `${full.slice(0, GITHUB_TITLE_MAX - 1)}…` : full;
}

export function buildIssueBody(input: IssueContentInput): string {
  const who = input.reporterUsername && input.reporterUsername !== input.reporterDisplayName
    ? `${input.reporterDisplayName} (Discord username: ${input.reporterUsername})`
    : input.reporterDisplayName;
  const rows: [string, string][] = [
    ['App', cell(input.appName)],
    ...(input.ticketType ? ([['Type', cell(input.ticketType)]] as [string, string][]) : []),
    ['Reported by', `${cell(neutralizeGitHubMentions(who))} — Discord user ID \`${input.reporterDiscordId}\``],
    ['Submitted', input.submittedAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')],
  ];
  if (input.guildName || input.guildId) {
    rows.push(['Discord server', `${cell(input.guildName ?? 'Unknown')}${input.guildId ? ` (\`${input.guildId}\`)` : ''}`]);
  }
  if (input.channelId) rows.push(['Submitted from channel', `\`${input.channelId}\``]);
  rows.push(['Submission ID', `\`${input.ref}\``]);

  const parts = [
    input.isTest
      ? '> [!NOTE]\n> This is a test ticket created by an administrator from the Ticket Relay admin interface. It can be closed.'
      : null,
    '### Description',
    '',
    neutralizeGitHubMentions(input.description.trim()),
    '',
    ...(input.answers ?? []).flatMap((a) => [`### ${headingText(a.question)}`, '', neutralizeGitHubMentions(a.value.trim()), '']),
    ...(input.filesBlock ? [input.filesBlock, ''] : []),
    '### Ticket details',
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([k, v]) => `| **${k}** | ${v} |`),
    '',
    `<sub>Submitted through Discord by **${cell(neutralizeGitHubMentions(input.reporterDisplayName))}** and created by the Ticket Relay integration on their behalf. ` +
      'The reporter may not have a GitHub account, so replies here will not reach them automatically.</sub>',
    '',
    submissionMarker(input.ref),
  ];
  return parts.filter((p) => p !== null).join('\n');
}
