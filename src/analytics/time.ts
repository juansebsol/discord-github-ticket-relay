/**
 * Analytics: time ranges and steps in the viewer's own time zone ("Today" starts at their
 * midnight). Downloads are recorded per 30-minute slot (UTC-aligned, which every time zone's
 * half hours line up with, bar a few odd offsets); each step adds slots up.
 */

export const SLOT_MS = 30 * 60_000;
/** 30-minute detail is kept this long; older downloads are kept per day. */
export const DETAIL_DAYS = 32;
/** More buckets than this make a chart unreadable: the step isn't offered. */
const MAX_BUCKETS = 400;

export const STEPS = [
  { id: '30m', label: '30m', ms: 30 * 60_000 },
  { id: '1h', label: '1h', ms: 60 * 60_000 },
  { id: '3h', label: '3h', ms: 3 * 3_600_000 },
  { id: '6h', label: '6h', ms: 6 * 3_600_000 },
  { id: '12h', label: '12h', ms: 12 * 3_600_000 },
  { id: '1d', label: '1D', ms: 86_400_000 },
] as const;
export type StepId = (typeof STEPS)[number]['id'];

export const RANGES = [
  { id: 'today', label: 'Today', days: 1, step: '30m', compare: 'this time yesterday' },
  { id: 'yesterday', label: 'Yesterday', days: 1, step: '30m', compare: 'the day before' },
  { id: '7d', label: '7 days', days: 7, step: '3h', compare: 'the 7 days before' },
  { id: '30d', label: '30 days', days: 30, step: '1d', compare: 'the 30 days before' },
  { id: '90d', label: '90 days', days: 90, step: '1d', compare: 'the 90 days before' },
  { id: '12m', label: '12 months', days: 365, step: '1d', compare: 'the 12 months before' },
] as const;
export type RangeId = (typeof RANGES)[number]['id'];

export const slotOf = (ms: number) => Math.floor(ms / SLOT_MS) * SLOT_MS;

/** A time zone name the viewer's browser gave (an IANA name), or UTC. */
export function safeTimeZone(tz: string | undefined | null): string {
  if (!tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, min: Number(p.minute), s: Number(p.second) };
}

/** How far the zone is ahead of UTC at that moment, in milliseconds. */
export function offsetAt(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The moment the local day containing `ms` started. */
export function startOfDay(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const local = Date.UTC(p.y, p.m - 1, p.d);
  const guess = local - offsetAt(ms, tz);
  return local - offsetAt(guess, tz);
}

/** The local day `n` days after the one starting at `dayStart` (n may be negative). */
export function addDays(dayStart: number, n: number, tz: string): number {
  return startOfDay(dayStart + n * 86_400_000 + 12 * 3_600_000, tz);
}

export function rangeOf(id: string | undefined) {
  return RANGES.find((r) => r.id === id) ?? RANGES[0];
}

export function stepOf(id: string | undefined) {
  return STEPS.find((s) => s.id === id) ?? null;
}

export interface Window {
  range: (typeof RANGES)[number];
  step: (typeof STEPS)[number];
  start: number;
  end: number;
  /** The period before, as long, for comparisons ("vs this time yesterday"). */
  prevStart: number;
  prevEnd: number;
  /** Bucket starts (the last ends at `end`). */
  buckets: number[];
  /** Data stops here (now); later buckets are the rest of today, still to come. */
  until: number;
  /** Steps that fit this range (not too many buckets, and fine steps only while 30-minute detail is kept). */
  steps: { id: StepId; label: string; ok: boolean }[];
}

/** A step fits a range when it makes at most MAX_BUCKETS buckets, and steps under a day stay within the 30-minute detail. */
function fits(range: (typeof RANGES)[number], step: (typeof STEPS)[number]) {
  return (range.days * 86_400_000) / step.ms <= MAX_BUCKETS && (step.id === '1d' || range.days <= DETAIL_DAYS - 2);
}

export function windowOf(rangeId: string | undefined, stepId: string | undefined, tz: string, now = Date.now()): Window {
  const range = rangeOf(rangeId);
  const asked = stepOf(stepId);
  const step = asked && fits(range, asked) ? asked : STEPS.find((s) => s.id === range.step)!;
  const today = startOfDay(now, tz);
  let start: number;
  let end: number;
  if (range.id === 'today') [start, end] = [today, addDays(today, 1, tz)];
  else if (range.id === 'yesterday') [start, end] = [addDays(today, -1, tz), today];
  else [start, end] = [addDays(today, -(range.days - 1), tz), addDays(today, 1, tz)];
  const until = Math.min(now, end);
  // The period before: as long as this one has run so far ("this time yesterday" for today).
  const span = until - start;
  const prevStart = range.id === 'today' || range.id === 'yesterday' ? addDays(start, -1, tz) : addDays(start, -range.days, tz);
  const prevEnd = prevStart + span;
  const buckets: number[] = [];
  if (step.id === '1d') for (let d = start; d < end; d = addDays(d, 1, tz)) buckets.push(d);
  else for (let t = start; t < end; t += step.ms) buckets.push(t);
  return { range, step, start, end, prevStart, prevEnd, buckets, until, steps: STEPS.map((s) => ({ id: s.id, label: s.label, ok: fits(range, s) })) };
}

/** The bucket a moment falls in (-1 outside the window). */
export function bucketIndex(w: Window, ms: number): number {
  if (ms < w.start || ms >= w.end) return -1;
  let lo = 0;
  let hi = w.buckets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (w.buckets[mid]! <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
