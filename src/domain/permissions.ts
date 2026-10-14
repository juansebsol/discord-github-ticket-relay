import type { Role } from './types.js';

/**
 * What a workspace member may do. Owners and admins can do everything except that only
 * owners manage people; moderators can always see tickets and, if an admin allows it, act on
 * them and see contributor verifications. Moderators never change setup, panels or settings.
 */
export type Permission =
  | 'view' // overview
  | 'tickets.view' // inbox and ticket details
  | 'tickets.act' // re-check, retry, link an existing issue, close
  | 'contrib.view' // contributor verification history
  | 'issues.view' // the Issues tab: search every issue in the connected repositories
  | 'files.manage' // the Files tab: see stored files, scan and delete (cleanup rules stay with admins)
  | 'manage' // setup, apps, panels, ticket types, contributor roles, settings, moderator permissions
  | 'members'; // invite people, change roles, remove people

export interface MemberAccess {
  role: Role;
  can_act_tickets: boolean;
  can_view_contributors: boolean;
  can_search_issues: boolean;
  can_manage_files: boolean;
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
    default:
      return false;
  }
}

export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', admin: 'Admin', moderator: 'Moderator' };
