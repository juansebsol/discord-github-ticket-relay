import type { Role } from './types.js';

/** The pages of Tickets › Triage, each with its own access for moderators. */
export const TRIAGE_AREAS = ['actions', 'labels', 'prompt', 'runs', 'activity'] as const;
export type TriageArea = (typeof TRIAGE_AREAS)[number];
export type AccessLevel = 'none' | 'view' | 'edit';
/** Activity is a log: there's nothing to edit. */
export const VIEW_ONLY_AREAS: ReadonlySet<TriageArea> = new Set(['activity']);
export const TRIAGE_AREA_NAMES: Record<TriageArea, string> = { actions: 'Actions', labels: 'Label groups', prompt: 'Prompt', runs: 'Re-run', activity: 'Activity' };

/** Setup pages an admin can open to moderators, each with no access, view or edit. */
export const PAGE_AREAS = ['apps'] as const;
export type PageArea = (typeof PAGE_AREAS)[number];
export const PAGE_AREA_NAMES: Record<PageArea, string> = { apps: 'Apps & repositories' };

/** A moderator's level on a setup page (none when unset or unknown). */
export function pageLevel(access: Partial<Record<string, unknown>> | null | undefined, area: PageArea): AccessLevel {
  const v = access?.[area];
  return v === 'edit' || v === 'view' ? v : 'none';
}

/** A moderator's level on a Triage page (none when unset or unknown). */
export function triageLevel(access: Partial<Record<string, unknown>> | null | undefined, area: TriageArea): AccessLevel {
  const v = access?.[area];
  if (v === 'edit') return VIEW_ONLY_AREAS.has(area) ? 'view' : 'edit';
  return v === 'view' ? 'view' : 'none';
}

/**
 * What a workspace member may do. Owners and admins can do everything except that only
 * owners manage people; moderators can always see tickets and, if an admin allows it, act on
 * them, see contributor verifications, and see or change Apps & repositories and the Triage
 * pages. GitHub, Discord, panels and settings stay with admins.
 */
export type Permission =
  | 'view' // overview
  | 'tickets.view' // inbox and ticket details
  | 'tickets.act' // re-check, retry, link an existing issue, close
  | 'contrib.view' // contributor verification history
  | 'issues.view' // the Issues tab: search every issue in the connected repositories
  | 'files.manage' // the Files tab: see stored files, scan and delete (cleanup rules stay with admins)
  | 'health.view' // the Server health page
  | 'manage' // setup, apps, panels, ticket types, contributor roles, settings, moderator permissions
  | 'members' // invite people, change roles, remove people
  | `triage.${TriageArea}.${'view' | 'edit'}` // a Triage page: see it, or change it
  | `${PageArea}.${'view' | 'edit'}`; // a setup page opened to moderators: see it, or change it

export interface MemberAccess {
  role: Role;
  can_act_tickets: boolean;
  can_view_contributors: boolean;
  can_search_issues: boolean;
  can_manage_files: boolean;
  can_view_health: boolean;
  /** Per Triage page: none, view or edit. */
  triage_access: Partial<Record<TriageArea, AccessLevel>>;
  /** Per setup page (Apps & repositories): none, view or edit. */
  page_access: Partial<Record<PageArea, AccessLevel>>;
}

export function can(m: MemberAccess, p: Permission): boolean {
  if (m.role === 'owner') return true;
  if (m.role === 'admin') return p !== 'members';
  switch (p) {
    case 'view':
    case 'tickets.view':
      return true;
    case 'tickets.act':
      return m.can_act_tickets;
    case 'contrib.view':
      return m.can_view_contributors;
    case 'issues.view':
      return m.can_search_issues;
    case 'files.manage':
      return m.can_manage_files;
    case 'health.view':
      return m.can_view_health;
    default: {
      const page = /^(\w+)\.(view|edit)$/.exec(p);
      if (page && (PAGE_AREAS as readonly string[]).includes(page[1]!)) {
        const level = pageLevel(m.page_access, page[1] as PageArea);
        return page[2] === 'view' ? level !== 'none' : level === 'edit';
      }
      const t = /^triage\.(\w+)\.(view|edit)$/.exec(p);
      if (!t || !(TRIAGE_AREAS as readonly string[]).includes(t[1]!)) return false;
      const level = triageLevel(m.triage_access, t[1] as TriageArea);
      return t[2] === 'view' ? level !== 'none' : level === 'edit';
    }
  }
}

/** Whether this person can see any Triage page (the Triage tab), and the first one they can. */
export function firstTriageArea(m: MemberAccess): TriageArea | null {
  return TRIAGE_AREAS.find((a) => can(m, `triage.${a}.view`)) ?? null;
}

export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', admin: 'Admin', moderator: 'Moderator' };
