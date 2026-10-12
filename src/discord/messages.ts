/**
 * Builders for every Discord payload the bot sends. Kept pure so they can be previewed in
 * the admin UI and tested without Discord.
 *
 * Limits (Discord docs): select menus hold 25 options; option label/value/description
 * max 100 chars; custom_id max 100; modal title max 45; modals hold 1-5 top-level
 * components; Label label max 45 / description max 100; text input placeholder max 100,
 * value max 4000; embed title 256, description 4096.
 */

export const NO_MENTIONS = { parse: [] as string[] };
export const EPHEMERAL = 1 << 6;

export const ComponentType = {
  ActionRow: 1,
  Button: 2,
  StringSelect: 3,
  TextInput: 4,
  TextDisplay: 10,
  Label: 18,
} as const;

export const CustomId = {
  panelSelect: 'tr:pick',
  pickerSelect: 'tr:pickp',
  pickerPage: (page: number) => `tr:page:${page}`,
  form: (appPublicId: string, repoId: number) => `tr:form:${appPublicId}:${repoId}`,
  titleInput: 'title',
  descriptionInput: 'description',
  // Contributor panel (separate prefix so it never collides with the ticket flow).
  contributorSelect: 'cv:pick',
  contributorPickerSelect: 'cv:pickp',
  contributorPage: (page: number) => `cv:page:${page}`,
};

export const MORE_APPS_VALUE = '__more';
export const SELECT_MAX = 25;
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 4000;

const COLORS = { brand: 0x5865f2, success: 0x2e9e5b, warning: 0xd99a1e, danger: 0xd2453b };

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Escapes Discord markdown so user text is displayed literally. */
export function escapeMarkdown(value: string): string {
  return value.replace(/([\\*_~`|>#\[\]()-])/g, '\\$1').replace(/@/g, '@\u200b');
}

export interface PanelApp {
  publicId: string;
  name: string;
  description: string | null;
}

export interface PanelOptions {
  title: string | null;
  intro: string | null;
  apps: PanelApp[];
}

export const DEFAULT_PANEL_TITLE = 'Need help? Open a ticket';
export const DEFAULT_PANEL_INTRO =
  'Pick the app you need help with from the menu below. A short form will open where you can describe the problem.';

function appOption(app: PanelApp) {
  return {
    label: truncate(app.name, 100),
    value: app.publicId,
    ...(app.description ? { description: truncate(app.description, 100) } : {}),
  };
}

export function buildPanelMessage(opts: PanelOptions) {
  const overflow = opts.apps.length > SELECT_MAX;
  const shown = overflow ? opts.apps.slice(0, SELECT_MAX - 1) : opts.apps;
  const options = shown.map(appOption);
  if (overflow) {
    options.push({
      label: 'More apps…',
      value: MORE_APPS_VALUE,
      description: `Browse all ${opts.apps.length} apps`,
    });
  }
  const description = [
    opts.intro?.trim() || DEFAULT_PANEL_INTRO,
    '',
    '**How it works**',
    '1. Choose your app from the menu.',
    '2. Fill in a title and a description. Steps to reproduce, what you expected and what actually happened help a lot.',
    '3. Submit. You will get a private confirmation with your ticket number.',
    '',
    'You do not need a GitHub account. Please never include passwords, tokens or other secrets.',
  ].join('\n');

  return {
    content: '',
    embeds: [
      {
        title: truncate(opts.title?.trim() || DEFAULT_PANEL_TITLE, 256),
        description: truncate(description, 4096),
        color: COLORS.brand,
      },
    ],
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: CustomId.panelSelect,
            placeholder: 'Choose an app…',
            min_values: 1,
            max_values: 1,
            options,
          },
        ],
      },
    ],
    allowed_mentions: NO_MENTIONS,
  };
}

/** Ephemeral, paginated picker used when there are more apps than one menu can hold. */
export interface PickerIds {
  select: string;
  page: (page: number) => string;
}

const TICKET_PICKER: PickerIds = { select: CustomId.pickerSelect, page: CustomId.pickerPage };
export const CONTRIBUTOR_PICKER: PickerIds = { select: CustomId.contributorPickerSelect, page: CustomId.contributorPage };

export function buildPickerPage(apps: PanelApp[], requestedPage: number, ids: PickerIds = TICKET_PICKER) {
  const pageCount = Math.max(1, Math.ceil(apps.length / SELECT_MAX));
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const slice = apps.slice(page * SELECT_MAX, (page + 1) * SELECT_MAX);
  return {
    content: `Choose the app you need help with (page ${page + 1} of ${pageCount}).`,
    embeds: [],
    flags: EPHEMERAL,
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.StringSelect,
            custom_id: ids.select,
            placeholder: 'Choose an app…',
            options: slice.map(appOption),
          },
        ],
      },
      {
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.Button, style: 2, label: 'Previous', custom_id: ids.page(page - 1), disabled: page === 0 },
          { type: ComponentType.Button, style: 2, label: 'Next', custom_id: ids.page(page + 1), disabled: page >= pageCount - 1 },
        ],
      },
    ],
    allowed_mentions: NO_MENTIONS,
  };
}

export function visibilityNotice(repoPrivate: boolean): string {
  return repoPrivate
    ? 'Your report goes to a private repository, so only the team and people with access to it can see it.'
    : 'Your report will be posted publicly on GitHub, where anyone can read it.';
}

export function buildTicketModal(app: { publicId: string; name: string; repoId: number; repoPrivate: boolean }) {
  return {
    custom_id: CustomId.form(app.publicId, app.repoId),
    title: truncate(`New ticket: ${app.name}`, 45),
    components: [
      {
        type: ComponentType.TextDisplay,
        content: [
          `Describe your problem with **${escapeMarkdown(app.name)}**. When it applies, include the steps to reproduce it, what you expected to happen and what actually happened.`,
          '',
          `${visibilityNotice(app.repoPrivate)} Do not include passwords, tokens or other secrets.`,
        ].join('\n'),
      },
      {
        type: ComponentType.Label,
        label: 'Title',
        description: 'A short summary of the problem.',
        component: {
          type: ComponentType.TextInput,
          custom_id: CustomId.titleInput,
          style: 1,
          min_length: 3,
          max_length: TITLE_MAX,
          required: true,
          placeholder: 'e.g. Export button does nothing on the reports page',
        },
      },
      {
        type: ComponentType.Label,
        label: 'Description',
        description: 'Steps to reproduce, expected behavior and actual behavior.',
        component: {
          type: ComponentType.TextInput,
          custom_id: CustomId.descriptionInput,
          style: 2,
          min_length: 10,
          max_length: DESCRIPTION_MAX,
          required: true,
          placeholder: '1. Go to…  2. Click…  Expected: …  Actual: …',
        },
      },
    ],
  };
}

// ---- Member-facing results (always private/ephemeral) -----------------------------------

interface Embed {
  title: string;
  description: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
}

function reply(embed: Embed, components: unknown[] = []) {
  return { content: '', embeds: [embed], components, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS };
}

export function createdMessage(s: { appName: string; ref: string; issueNumber: number; issueUrl: string; repoPrivate: boolean }) {
  return reply(
    {
      title: 'Ticket submitted',
      description: [
        `Thanks! Your ticket was received and the team has it. You do not need to do anything else.`,
        '',
        s.repoPrivate
          ? 'The ticket is stored in a private repository. The link below only works for people with access to that repository.'
          : 'The ticket is public on GitHub, so anyone with the link can read it.',
      ].join('\n'),
      color: COLORS.success,
      fields: [
        { name: 'App', value: escapeMarkdown(s.appName), inline: true },
        { name: 'Ticket number', value: `#${s.issueNumber}`, inline: true },
        { name: 'Reference', value: `\`${s.ref}\``, inline: true },
      ],
    },
    [
      {
        type: ComponentType.ActionRow,
        components: [{ type: ComponentType.Button, style: 5, label: `Open ticket #${s.issueNumber}`, url: s.issueUrl }],
      },
    ],
  );
}

export function queuedMessage(s: { appName: string; ref: string }) {
  return reply({
    title: 'Ticket received, still being filed',
    description:
      'Your ticket was saved but GitHub is busy right now, so filing it is taking longer than usual. It will be filed automatically and this message will update when it is. You do not need to submit it again.',
    color: COLORS.warning,
    fields: [
      { name: 'App', value: escapeMarkdown(s.appName), inline: true },
      { name: 'Reference', value: `\`${s.ref}\``, inline: true },
    ],
  });
}

export function uncertainMessage(s: { appName: string; ref: string }) {
  return reply({
    title: 'Ticket received, confirmation pending',
    description:
      'Your ticket was saved, but we could not confirm with GitHub whether it was filed. The team has been alerted and will check it. **Please do not submit it again.** If you follow up, mention the reference below.',
    color: COLORS.warning,
    fields: [
      { name: 'App', value: escapeMarkdown(s.appName), inline: true },
      { name: 'Reference', value: `\`${s.ref}\``, inline: true },
    ],
  });
}

export function failedMessage(s: { appName: string; ref: string }) {
  return reply({
    title: 'Ticket could not be filed yet',
    description:
      'Something went wrong while filing your ticket. Your text was saved and the team has been alerted, so they can file it for you. If you follow up, mention the reference below.',
    color: COLORS.danger,
    fields: [
      { name: 'App', value: escapeMarkdown(s.appName), inline: true },
      { name: 'Reference', value: `\`${s.ref}\``, inline: true },
    ],
  });
}

export function noticeMessage(title: string, description: string, tone: 'warning' | 'danger' = 'warning') {
  return reply({ title, description: truncate(description, 4096), color: COLORS[tone] });
}

/** Shown when a form can't be accepted; echoes the member's text so it isn't lost. */
export function textEchoMessage(title: string, explanation: string, ticket: { title: string; description: string }) {
  const echo = `**Your title:** ${escapeMarkdown(ticket.title)}\n\n**Your description:**\n${escapeMarkdown(ticket.description)}`;
  return reply({
    title,
    description: truncate(`${explanation}\n\nHere is what you wrote, so you can copy it:\n\n${echo}`, 4096),
    color: COLORS.warning,
  });
}

// ---- Contributor roles ---------------------------------------------------------------------

export function buildContributorPanel(opts: { roleName: string; apps: PanelApp[] }) {
  const overflow = opts.apps.length > SELECT_MAX;
  const options = (overflow ? opts.apps.slice(0, SELECT_MAX - 1) : opts.apps).map(appOption);
  if (overflow) options.push({ label: 'More apps…', value: MORE_APPS_VALUE, description: `Browse all ${opts.apps.length} apps` });
  const description = [
    `Contributed to one of our apps on GitHub? Get the **${escapeMarkdown(opts.roleName)}** role.`,
    '',
    '**How it works**',
    '1. Choose the app you contributed to.',
    '2. Sign in with GitHub to confirm which account is yours.',
    '3. If you have a merged pull request or a commit in its repository, the role is added right away.',
    '',
    'We only use the sign-in to confirm your GitHub username. Nothing is posted on your behalf.',
  ].join('\n');
  return {
    content: '',
    embeds: [{ title: 'Verify as a contributor', description, color: COLORS.success }],
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          { type: ComponentType.StringSelect, custom_id: CustomId.contributorSelect, placeholder: 'Choose the app you contributed to…', min_values: 1, max_values: 1, options },
        ],
      },
    ],
    allowed_mentions: NO_MENTIONS,
  };
}

export function contributorVerifyPrompt(s: { appName: string; roleName: string; url: string }) {
  return reply(
    {
      title: 'Confirm your GitHub account',
      description: `Sign in with GitHub to check your contributions to **${escapeMarkdown(s.appName)}**. If you have a merged pull request or a commit there, you get the **${escapeMarkdown(s.roleName)}** role.\n\nThis link is just for you and expires in 10 minutes.`,
      color: COLORS.brand,
    },
    [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: 5, label: 'Verify with GitHub', url: s.url }] }],
  );
}

export type ContributorOutcome = 'verified' | 'not_contributor' | 'conflict' | 'error';

export function contributorResultMessage(s: { outcome: ContributorOutcome; appName: string; roleName: string; login: string | null; explanation: string }) {
  const titles: Record<ContributorOutcome, string> = {
    verified: 'Verified: role added',
    not_contributor: 'No contributions found',
    conflict: 'GitHub account already linked',
    error: 'Verification failed',
  };
  return reply(
    {
      title: titles[s.outcome],
      description: truncate(s.explanation, 4096),
      color: s.outcome === 'verified' ? COLORS.success : s.outcome === 'error' ? COLORS.danger : COLORS.warning,
      fields: [
        { name: 'App', value: escapeMarkdown(s.appName), inline: true },
        ...(s.login ? [{ name: 'GitHub', value: escapeMarkdown(s.login), inline: true }] : []),
      ],
    },
  );
}
