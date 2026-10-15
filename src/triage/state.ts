/**
 * Where a ticket (or an issue opened on GitHub) stands in triage, and the triage filters for
 * lists: by status, priority, what triage flagged, and label-group labels. Separate from a
 * ticket's filing status (Filed means the GitHub issue exists; triage is the step after).
 */
import { FLAGS, PRIORITIES, groupKind, type Flag, type TriageConfig } from './settings.js';

export type TriageState = 'queued' | 'review' | 'applied' | 'reviewed' | 'nothing' | 'skipped' | 'failed';

export const TRIAGE_STATES: Record<TriageState, { label: string; desc: string }> = {
  queued: { label: 'Queued', desc: 'Waiting to be triaged.' },
  review: { label: 'To review', desc: 'Suggestions are waiting for someone to apply or dismiss them.' },
  applied: { label: 'Applied', desc: 'Triage actions were applied on GitHub (automatically or by someone), and nothing is waiting.' },
  reviewed: { label: 'Reviewed', desc: 'The suggestions were dismissed; nothing was applied.' },
  nothing: { label: 'Nothing to do', desc: 'Triage found nothing to flag.' },
  skipped: { label: 'Skipped', desc: 'Triage didn’t run on it (for example the issue was closed, or it was out of scope).' },
  failed: { label: 'Failed', desc: 'Triage couldn’t finish after several tries.' },
};

/** The fields of a triage result the status comes from. */
export interface StateFields {
  status: string;
  suggestion_count: number;
  applied_count?: number | null;
  applied_actions?: unknown[] | null;
  dismissed_count?: number | null;
}

export function triageState(r: StateFields): TriageState {
  if (r.status === 'pending') return 'queued';
  if (r.status === 'skipped') return 'skipped';
  if (r.status === 'failed') return 'failed';
  if (r.suggestion_count > 0) return 'review';
  if ((r.applied_count ?? r.applied_actions?.length ?? 0) > 0) return 'applied';
  return (r.dismissed_count ?? 0) > 0 ? 'reviewed' : 'nothing';
}

const APPLIED = `json_array_length(COALESCE(t.applied_actions, '[]'))`;

/** Each status as SQL on a triage result aliased t. */
const STATE_SQL: Record<TriageState, string> = {
  queued: `t.status = 'pending'`,
  review: `t.status = 'done' AND t.suggestion_count > 0`,
  applied: `t.status = 'done' AND t.suggestion_count = 0 AND ${APPLIED} > 0`,
  reviewed: `t.status = 'done' AND t.suggestion_count = 0 AND ${APPLIED} = 0 AND t.dismissed_count > 0`,
  nothing: `t.status = 'done' AND t.suggestion_count = 0 AND ${APPLIED} = 0 AND t.dismissed_count = 0`,
  skipped: `t.status = 'skipped'`,
  failed: `t.status = 'failed'`,
};

/** What triage flagged, as the filter names it. */
const FLAG_FILTER_NAMES: Record<Flag, string> = {
  duplicate: 'Duplicate',
  regression: 'Regression',
  needsInfo: 'Needs more info',
  multiple: 'Several problems',
  related: 'Related issues',
  shared: 'Shared across apps',
  wrongRepo: 'Wrong repository',
  support: 'Not a development issue',
  spam: 'Spam',
  noAction: 'No action needed',
};

const PRIORITY_NAMES = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' } as const;

/** Filter values from before these filters existed (bookmarked links). */
const LEGACY: Record<string, string> = { review: 's:review', high: 'p:urgent', duplicate: 'f:duplicate', spam: 'f:spam', support: 'f:support' };

export interface FilterGroup {
  label: string;
  options: { value: string; label: string }[];
}

/** The triage filters for a list, grouped: status, priority, what was flagged, and labels. */
export function triageFilterGroups(c: TriageConfig, o: { untriaged?: boolean } = {}): FilterGroup[] {
  return [
    {
      label: 'Triage status',
      options: [
        ...(['review', 'applied', 'reviewed', 'nothing', 'queued'] as const).map((s) => ({ value: `s:${s}`, label: TRIAGE_STATES[s].label })),
        { value: 's:skipped', label: 'Skipped or failed' },
        ...(o.untriaged ? [{ value: 's:untriaged', label: 'Not triaged' }] : []),
      ],
    },
    {
      label: 'Priority',
      options: [{ value: 'p:urgent', label: 'Critical or high' }, ...PRIORITIES.map((p) => ({ value: `p:${p}`, label: PRIORITY_NAMES[p] }))],
    },
    { label: 'Flagged as', options: FLAGS.map((f) => ({ value: `f:${f}`, label: FLAG_FILTER_NAMES[f] })) },
    ...c.labelGroups.map((g) => ({ label: `${g.name} labels`, options: g.options.map((x) => ({ value: `l:${g.id}:${x.label}`, label: `${g.name}: ${x.label}` })) })),
  ];
}

export interface TriageFilter {
  /** The canonical value (legacy values are translated). */
  value: string;
  /** Only items triage never looked at (no result at all). */
  untriaged: boolean;
  /** The condition on a triage result aliased t; bind adds a parameter and returns its placeholder. */
  where: (bind: (v: unknown) => string) => string;
}

/**
 * Turns a filter value into SQL, or null if it isn't one of the filters. "Flagged as" and labels
 * match whether the action was applied or is still suggested.
 */
export function triageFilter(raw: string | undefined, c: TriageConfig): TriageFilter | null {
  if (!raw) return null;
  const value = LEGACY[raw] ?? raw;
  const hasAction = (kind: string, extra: (alias: string) => string = () => '') =>
    ['suggestions', 'applied_actions']
      .map((col) => `EXISTS (SELECT 1 FROM json_each(COALESCE(t.${col}, '[]')) a WHERE json_extract(a.value, '$.kind') = '${kind}'${extra('a')})`)
      .join(' OR ');
  const [type, ...rest] = value.split(':');
  const arg = rest.join(':');
  if (type === 's') {
    if (arg === 'untriaged') return { value, untriaged: true, where: () => '1' };
    if (arg === 'skipped') return { value, untriaged: false, where: () => `t.status IN ('skipped', 'failed')` };
    if (arg in STATE_SQL) return { value, untriaged: false, where: () => STATE_SQL[arg as TriageState] };
    return null;
  }
  if (type === 'p') {
    if (arg === 'urgent') return { value, untriaged: false, where: () => `t.priority IN ('critical', 'high')` };
    return (PRIORITIES as readonly string[]).includes(arg) ? { value, untriaged: false, where: () => `t.priority = '${arg}'` } : null;
  }
  if (type === 'f') {
    return (FLAGS as readonly string[]).includes(arg) ? { value, untriaged: false, where: () => `(${hasAction(arg)})` } : null;
  }
  if (type === 'l') {
    const [groupId, ...labelParts] = arg.split(':');
    const label = labelParts.join(':');
    const g = c.labelGroups.find((x) => x.id === groupId);
    if (!g || !g.options.some((o) => o.label === label)) return null;
    return {
      value,
      untriaged: false,
      where: (bind) => {
        const p = bind(label);
        return `(${hasAction(groupKind(g.id), (a) => ` AND EXISTS (SELECT 1 FROM json_each(json_extract(${a}.value, '$.labels')) l WHERE l.value = ${p})`)})`;
      },
    };
  }
  return null;
}
