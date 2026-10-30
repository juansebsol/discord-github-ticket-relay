import type { Role } from './types.js';

/** The tools in the sidebar, in order. Each one has pages (areas) an admin can open to moderators. */
export const TOOLS = ['analytics', 'repos', 'tickets', 'issues', 'triage', 'moderation', 'contributors', 'announcements', 'bot', 'setup', 'workspace'] as const;
export type Tool = (typeof TOOLS)[number];
export type AccessLevel = 'none' | 'view' | 'edit';

export interface AreaDef {
  tool: Tool;
  name: string;
  desc: string;
  /** The levels this page offers moderators (a log only has View). */
  levels: readonly ('view' | 'edit')[];
  /** Moderators always have at least this level (the Inbox). */
  min?: 'view';
}

/**
 * Every page a moderator can be given, in sidebar and tab order. View shows the page with its
 * controls turned off; Edit lets them change it. GitHub and Discord setup, workspace settings,
 * deployment and members aren't here: they stay with admins.
 */
export const AREAS = {
  'inbox': { tool: 'tickets', name: 'Inbox', desc: 'Tickets, their text and GitHub link. Edit: retry, link, close, add or delete files.', levels: ['view', 'edit'], min: 'view' },
  'panel': { tool: 'tickets', name: 'Panel', desc: 'The ticket panel in Discord. Edit: change, publish or remove it.', levels: ['view', 'edit'] },
  'types': { tool: 'tickets', name: 'Ticket types', desc: 'Ticket types and their forms. Edit: add, change and remove them.', levels: ['view', 'edit'] },
  'files': { tool: 'tickets', name: 'Files', desc: 'Files attached to tickets. Edit: scan and delete them. Cleanup rules stay with admins.', levels: ['view', 'edit'] },
  'ticket-settings': { tool: 'tickets', name: 'Settings', desc: 'Spam and duplicate limits for tickets.', levels: ['view', 'edit'] },
  'issues': { tool: 'issues', name: 'All issues', desc: 'Search every issue in the connected repositories.', levels: ['view'] },
  'issues-github': { tool: 'issues', name: 'Opened on GitHub', desc: 'Issues opened directly on GitHub, with their triage.', levels: ['view'] },
  'issues-sync': { tool: 'issues', name: 'Sync', desc: 'How up to date each repository is. Edit: Sync now.', levels: ['view', 'edit'] },
  'repo-status': { tool: 'repos', name: 'Repo status', desc: 'Open PRs and issues, recent activity, builds and what to fix first, per repository. Edit: choose the repositories, turn it on, refresh.', levels: ['view', 'edit'] },
  'analytics': { tool: 'analytics', name: 'Analytics', desc: 'Downloads every 30 minutes, with tickets, issues, pull requests and stars over time. Edit: turn it on or off.', levels: ['view', 'edit'] },
  'triage.overview': { tool: 'triage', name: 'Overview', desc: 'Charts of what triage did, and every label on your open issues.', levels: ['view'] },
  'triage.review': { tool: 'triage', name: 'Review', desc: 'Suggestions waiting for someone. Edit: apply and dismiss them, here and on tickets and issues.', levels: ['view', 'edit'] },
  'triage.actions': { tool: 'triage', name: 'Actions', desc: 'Switches, actions, rules and limits.', levels: ['view', 'edit'] },
  'triage.labels': { tool: 'triage', name: 'Custom labels', desc: 'Your own labels, in categories Claude sorts every ticket into.', levels: ['view', 'edit'] },
  'triage.prompt': { tool: 'triage', name: 'Prompt', desc: 'What Claude is told.', levels: ['view', 'edit'] },
  'triage.knowledge': { tool: 'triage', name: 'Knowledge', desc: 'Each app’s TRIAGE.md and the questions Claude asks. Edit: write them.', levels: ['view', 'edit'] },
  'triage.runs': { tool: 'triage', name: 'Re-run', desc: 'Previews and applying their results.', levels: ['view', 'edit'] },
  'triage.activity': { tool: 'triage', name: 'Activity', desc: 'What triage did, live.', levels: ['view'] },
  'moderation': { tool: 'moderation', name: 'Ticket management', desc: 'Open tickets and issues with their whole history, duplicates and fixes. Edit: close, reopen, mark duplicates, reply from saved replies and change labels.', levels: ['view', 'edit'] },
  'mod-log': { tool: 'moderation', name: 'Mod log', desc: 'What moderators closed, reopened, marked and replied, and undoing it.', levels: ['view'] },
  'mod-replies': { tool: 'moderation', name: 'Replies & reasons', desc: 'The close reasons and saved replies moderators post on GitHub. Only admins change them.', levels: ['view'] },
  'verifications': { tool: 'contributors', name: 'Verifications', desc: 'Who verified and their role. Edit: revoke roles.', levels: ['view', 'edit'] },
  'contributor-roles': { tool: 'contributors', name: 'Roles', desc: 'Roles and the contributions they need.', levels: ['view', 'edit'] },
  'contributor-panel': { tool: 'contributors', name: 'Panel', desc: 'The verify panel in Discord. Edit: change, publish or remove it.', levels: ['view', 'edit'] },
  'announcements': { tool: 'announcements', name: 'Announcements', desc: 'Messages the team writes and the bot posts in Discord channels. Edit: write, post, change and delete them.', levels: ['view', 'edit'] },
  'known-issues': { tool: 'bot', name: 'Known-issues board', desc: 'The known-issues board in Discord. Edit: turn it on or off, its settings, pinning, hiding and notes on issues, and publishing or removing it.', levels: ['view', 'edit'] },
  'releases': { tool: 'bot', name: 'GitHub releases', desc: 'New releases and their posts in Discord. Edit: post, edit, rewrite and skip them, and announce a release by hand.', levels: ['view', 'edit'] },
  'release-settings': { tool: 'bot', name: 'Release settings', desc: 'GitHub releases on or off, review first or automatic, the channel, the notes, the message and pings.', levels: ['view', 'edit'] },
  'release-pings': { tool: 'bot', name: 'Release pings panel', desc: 'The “Get update pings” message in Discord. Edit: change, publish or remove it.', levels: ['view', 'edit'] },
  'apps': { tool: 'setup', name: 'Apps & repositories', desc: 'Apps and their repositories.', levels: ['view', 'edit'] },
  'health': { tool: 'workspace', name: 'Server health', desc: 'Processes, memory and alerts. Edit: Dev mode.', levels: ['view', 'edit'] },
} as const satisfies Record<string, AreaDef>;
export type Area = keyof typeof AREAS;
export const AREA_KEYS = Object.keys(AREAS) as Area[];

export const TOOL_NAMES: Record<Tool, string> = { tickets: 'Discord tickets', issues: 'GitHub issues', repos: 'Repo status', analytics: 'Analytics', triage: 'AI triage', moderation: 'Moderation', contributors: 'Contributor roles', announcements: 'Announcements', bot: 'Bot features', setup: 'Setup', workspace: 'Workspace' };

/** A tool's pages, in order. */
export function areasOf(tool: Tool): Area[] {
  return AREA_KEYS.filter((a) => AREAS[a].tool === tool);
}

export function isArea(s: string): s is Area {
  return Object.hasOwn(AREAS, s);
}

/** Whether a page has anything to change (Activity and the issue lists don't). */
export function hasEdit(area: Area): boolean {
  return (AREAS[area].levels as readonly string[]).includes('edit');
}

/** A page's name where it could be confused with another: "AI triage › Prompt", "Apps & repositories". */
export function areaLabel(area: Area): string {
  const def: AreaDef = AREAS[area];
  return areasOf(def.tool).length > 1 ? `${TOOL_NAMES[def.tool]} › ${def.name}` : def.name;
}

/**
 * What a person can do on a page: none when unset or unknown; Edit on a page without anything
 * to change counts as View; and never below the page's minimum (the Inbox is always View).
 */
export function levelOf(access: Partial<Record<string, unknown>> | null | undefined, area: Area): AccessLevel {
  const def: AreaDef = AREAS[area];
  const v = access?.[area];
  const level: AccessLevel = v === 'edit' ? (hasEdit(area) ? 'edit' : 'view') : v === 'view' ? 'view' : 'none';
  return level === 'none' && def.min ? def.min : level;
}

/**
 * What a workspace member may do. Owners can do everything; admins everything except managing
 * people; moderators see the overview, and each page as their access map says (Inbox always).
 */
export type Permission =
  | 'view' // overview
  | 'manage' // setup, panels, ticket types, contributor roles, settings, moderator access
  | 'members' // invite people, change roles, remove people
  | `${Area}.${'view' | 'edit'}`; // a page: see it, or change it

export interface MemberAccess {
  role: Role;
  /** Moderators: per page, view or edit (pages left out: no access); and the MCP tools switched on. */
  access: Partial<Record<Area, 'view' | 'edit'>> & { mcp?: string[] };
}

/**
 * The MCP's tools (what a coding agent can do), each a switch of its own per moderator, apart
 * from the pages: seeing Ticket management doesn't let an agent find tickets. Some switches cover
 * two tools that are halves of one thing (claim and release). Owners and admins have them all.
 */
export const MCP_GROUPS = [
  { key: 'read', name: 'Read', desc: 'Find and read tickets, pull requests and releases. Nothing changes.' },
  { key: 'write', name: 'Write', desc: 'Claims stay in Ticket Relay. The rest change the issue on GitHub as this person, with your close reasons and saved replies, and are listed in the Mod log. GitHub changes need Moderation on.' },
] as const;
export type McpGroup = (typeof MCP_GROUPS)[number]['key'];

/** `github`: changes the issue on GitHub (the other writes stay in Ticket Relay). */
export const MCP_SWITCHES = {
  find_tickets: { group: 'read', name: 'Find tickets', desc: 'Lists tickets and issues with filters (app, priority, labels, lists like Repeat bugs, claimed, has a pull request) and sorting.' },
  count_tickets: { group: 'read', name: 'Count tickets', desc: 'How many tickets per app, priority, label, list or week, largest first.' },
  get_ticket: { group: 'read', name: 'Read a ticket', desc: 'One ticket with its text, comments, history, triage’s verdict, duplicates and pull requests.' },
  get_ticket_files: { group: 'read', name: 'See screenshots', desc: 'A ticket’s screenshots, as images the agent can look at.' },
  find_related: { group: 'read', name: 'Find related', desc: 'Pull requests for a bug, tickets for a change or an error message, and similar issues.' },
  find_prs: { group: 'read', name: 'Find pull requests', desc: 'Open, merged or closed pull requests with the tickets they fix or mention.' },
  get_pr: { group: 'read', name: 'Read a pull request', desc: 'One pull request: its files, its release, and the tickets it fixes or probably fixes.' },
  get_release: { group: 'read', name: 'Releases', desc: 'What a release fixed, what’s fixed but not released, and tickets opened since.' },
  get_knowledge: { group: 'read', name: 'Knowledge', desc: 'An app’s TRIAGE.md: known issues, what works as intended, names members use.' },
  mod_log: { group: 'read', name: 'Mod log', desc: 'What moderators closed, reopened, marked and replied.' },
  my_work: { group: 'read', name: 'My work', desc: 'Their claims and what they did lately.' },
  claim: { group: 'write', name: 'Claim and release', desc: '“I’m on it”, so nobody else takes the ticket. Kept in Ticket Relay; nothing is written to GitHub.' },
  close_ticket: { group: 'write', github: true, name: 'Close', desc: 'Closes for one of your close reasons, with its comment. Can be undone for 15 minutes.' },
  reopen_ticket: { group: 'write', github: true, name: 'Reopen', desc: 'Reopens a closed ticket.' },
  duplicates: { group: 'write', github: true, name: 'Mark duplicates', desc: 'Marks a ticket as a repeat of another, or not a duplicate.' },
  set_labels: { group: 'write', github: true, name: 'Labels', desc: 'Adds and takes off labels the repository has.' },
  post_reply: { group: 'write', github: true, name: 'Saved replies', desc: 'Posts one of your saved replies. Never text of its own.' },
} as const satisfies Record<string, { group: McpGroup; github?: true; name: string; desc: string }>;
export type McpSwitch = keyof typeof MCP_SWITCHES;
export const MCP_SWITCH_KEYS = Object.keys(MCP_SWITCHES) as McpSwitch[];

export function isMcpSwitch(s: unknown): s is McpSwitch {
  return typeof s === 'string' && Object.hasOwn(MCP_SWITCHES, s);
}

/** Whether this person's agents may use an MCP switch (owners and admins: all of them). */
export function canMcp(m: MemberAccess, s: McpSwitch): boolean {
  if (m.role !== 'moderator') return true;
  return Array.isArray(m.access.mcp) && m.access.mcp.includes(s);
}

/** The switches a moderator has on, in order. */
export function mcpSwitches(m: MemberAccess): McpSwitch[] {
  return MCP_SWITCH_KEYS.filter((s) => canMcp(m, s));
}

/** The person's agent can change something (claims or GitHub): they choose, per token, read only or read and write. */
export function canWriteMcp(m: MemberAccess): boolean {
  return MCP_SWITCH_KEYS.some((s) => MCP_SWITCHES[s].group === 'write' && canMcp(m, s));
}

/** Who sees the MCP page and can make tokens: owners, admins, and moderators with at least one tool. */
export function canUseMcp(m: MemberAccess): boolean {
  return m.role !== 'moderator' || mcpSwitches(m).length > 0;
}

export function can(m: MemberAccess, p: Permission): boolean {
  if (m.role === 'owner') return true;
  if (m.role === 'admin') return p !== 'members';
  if (p === 'view') return true;
  const x = /^(.+)\.(view|edit)$/.exec(p);
  const area = x?.[1] ?? '';
  if (!isArea(area)) return false;
  const level = levelOf(m.access, area);
  return x![2] === 'view' ? level !== 'none' : level === 'edit';
}

/** The first page of a tool this person can open, in AREAS order (null: none). */
export function firstArea(m: MemberAccess, tool: Tool): Area | null {
  return areasOf(tool).find((a) => can(m, `${a}.view`)) ?? null;
}

export function canSeeTool(m: MemberAccess, tool: Tool): boolean {
  return firstArea(m, tool) !== null;
}

/** The level a page gets when a whole tool (or every page) is set to `level`, within what it offers. */
export function capLevel(area: Area, level: AccessLevel): AccessLevel {
  if (level === 'edit') return hasEdit(area) ? 'edit' : 'view';
  if (level === 'none') return (AREAS[area] as AreaDef).min ?? 'none';
  return 'view';
}

/** The one level these pages share ("No access", "View all", "Edit all"), or null when they differ. */
export function uniformLevel(m: MemberAccess, areas: readonly Area[]): AccessLevel | null {
  return (['none', 'view', 'edit'] as const).find((l) => areas.every((a) => levelOf(m.access, a) === capLevel(a, l))) ?? null;
}

/** A moderator's access to one tool, for short summaries: how many pages they can open or change. */
export function toolAccess(m: MemberAccess, tool: Tool): { level: AccessLevel | null; open: number; edit: number; pages: number } {
  const areas = areasOf(tool);
  return {
    level: uniformLevel(m, areas),
    open: areas.filter((a) => can(m, `${a}.view`)).length,
    edit: areas.filter((a) => hasEdit(a) && can(m, `${a}.edit`)).length,
    pages: areas.length,
  };
}

export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', admin: 'Admin', moderator: 'Moderator' };
