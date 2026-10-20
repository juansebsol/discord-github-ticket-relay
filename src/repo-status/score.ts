/**
 * Repo status: "what should be fixed first", and what each repository's builds add up to.
 * Pure and deterministic (ported from storytold/craft-repo-status-app, crates/craft-core).
 *
 * Every open issue gets points for what it says (crash, hang or data loss beats "doesn't work"
 * beats everything else), for who filed it (a user's report outranks the team's own), for how
 * many people pile on (reactions, comments), for naming the latest build, and for being fresh.
 * Feature requests, questions and docs nits are pushed down. Each contribution is kept as a short
 * reason, so the page can show why.
 */

export interface IssueInput {
  number: number;
  title: string;
  url: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  comments: number;
  reactions: number;
  labels: string[];
  /** GitHub's authorAssociation (NONE, CONTRIBUTOR, MEMBER…). */
  authorAssociation: string;
}

export interface Scored {
  score: number;
  critical: boolean;
  reasons: string[];
}

export interface UrgentIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string | null;
  comments: number;
  reactions: number;
  labels: string[];
  score: number;
  critical: boolean;
  reasons: string[];
}

/** Phrases that mean the app is unusable or the user's data is at risk, and what they're called. */
const CRITICAL: [string, string][] = [
  ['crash', 'crash'], ['crashes', 'crash'], ['crashed', 'crash'], ['crashing', 'crash'],
  ['panic', 'panic'], ['panics', 'panic'], ['segfault', 'crash'],
  ['data loss', 'data loss'], ['lost my', 'data loss'], ['lost work', 'data loss'],
  ['corrupt', 'corruption'], ['corrupted', 'corruption'], ['corrupts', 'corruption'],
  ['freeze', 'freeze'], ['freezes', 'freeze'], ['frozen', 'freeze'],
  ['hang', 'hang'], ['hangs', 'hang'], ['unresponsive', 'hang'], ['not responding', 'hang'],
  ["won't open", "won't open"], ['wont open', "won't open"], ["can't open", "won't open"], ['cannot open', "won't open"],
  ["won't launch", "won't launch"], ['wont launch', "won't launch"], ["won't start", "won't launch"], ["doesn't start", "won't launch"],
  ['does not start', "won't launch"], ['fails to launch', "won't launch"], ['fails to start', "won't launch"], ['not launching', "won't launch"],
  ['black screen', 'blank screen'], ['blank screen', 'blank screen'], ['white screen', 'blank screen'],
  ['security', 'security'], ['vulnerability', 'security'], ['malware', 'security'], ['virus', 'security'], ['trojan', 'security'],
];

/** Phrases that mean something is broken, but not catastrophically. */
const BROKEN = [
  'bug', 'broken', 'regression', "doesn't work", 'does not work', 'not working', "doesn't", 'does not', "don't", 'fails', 'failed',
  'failure', 'error', "can't", 'cannot', 'unable', 'wrong', 'lost', 'install', 'installer', 'slow', 'lag', 'glitch',
];

const FEATURE_LABELS = ['enhancement', 'feature', 'feature request', 'question', 'documentation', 'docs'];
const EXCLUDE_LABELS = ['wontfix', 'duplicate', 'invalid', 'not planned'];
const FEATURE_PREFIXES = [
  '[feature', 'feature request', 'feature:', 'request:', '[request', 'suggestion', '[suggestion', 'idea:', 'add ', 'support ',
  'please add', 'fix(docs)', 'docs:', 'docs(', '[docs', 'question', '[question',
];

/** Lowercase, straight apostrophes, punctuation as spaces, padded: " phrase " then matches whole words only. */
export function normalize(s: string): string {
  let out = ' ';
  let lastSpace = true;
  for (const raw of s.toLowerCase()) {
    const c = raw === '’' || raw === '`' ? "'" : raw;
    if (/[\p{L}\p{N}']/u.test(c)) {
      out += c;
      lastSpace = false;
    } else if (!lastSpace) {
      out += ' ';
      lastSpace = true;
    }
  }
  return lastSpace ? out : `${out} `;
}

const hasPhrase = (text: string, phrase: string) => text.includes(` ${phrase} `);

/** "v0.5.0" → "0.5": issues name the version loosely ("0.5", "0.50", "v0.5.0"). */
export function majorMinor(tag: string): string | null {
  const parts = tag.replace(/^[vV]+/, '').split(/[.-]/);
  const [major, minor] = parts;
  return major && minor && /^\d+$/.test(major) && /^\d+$/.test(minor) ? `${major}.${minor}` : null;
}

/** "0.5" matches "0.5", "0.5.0" and "0.50" (a common typo for 0.5.0), but not "0.51" or "10.5". */
export function mentionsVersion(title: string, mm: string): boolean {
  let from = 0;
  for (;;) {
    const i = title.indexOf(mm, from);
    if (i < 0) return false;
    from = i + 1;
    const before = i === 0 || !/\d/.test(title[i - 1]!);
    const after = title[i + mm.length];
    const afterOk = after === undefined || !/\d/.test(after) || (after === '0' && !/\d/.test(title[i + mm.length + 1] ?? ''));
    if (before && afterOk) return true;
  }
}

/** Null when the issue is closed in spirit (wontfix, duplicate, invalid). */
export function scoreIssue(issue: IssueInput, now: Date, latestTag: string | null): Scored | null {
  const labels = issue.labels.map((l) => l.toLowerCase());
  if (labels.some((l) => EXCLUDE_LABELS.includes(l))) return null;
  const titleLc = issue.title.toLowerCase();
  const text = normalize(`${issue.title} ${issue.labels.join(' ')}`);
  let score = 0;
  const reasons: string[] = [];

  const featureLike = labels.some((l) => FEATURE_LABELS.includes(l)) || FEATURE_PREFIXES.some((p) => titleLc.trimStart().startsWith(p));
  const hits: string[] = [];
  for (const [phrase, why] of CRITICAL) if (hasPhrase(text, phrase) && !hits.includes(why)) hits.push(why);
  const critical = hits.length > 0 && !featureLike;
  if (hits.length) {
    score += 40;
    reasons.push(hits.join(', '));
  } else if (BROKEN.some((p) => hasPhrase(text, p))) {
    score += 15;
    reasons.push('broken');
  }
  if (labels.some((l) => l === 'bug' || l === 'regression')) {
    score += 15;
    reasons.push('bug label');
  }
  if (labels.some((l) => l === 'reliability' || l === 'file-compat' || l === 'performance')) score += 6;
  if (featureLike) {
    score -= 25;
    reasons.push('request or docs');
  }
  if (['NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR'].includes(issue.authorAssociation)) {
    score += 10;
    reasons.push('user report');
  }
  const engagement = 3 * issue.reactions + 2 * issue.comments;
  if (engagement > 0) {
    score += Math.min(10 * Math.log(1 + engagement), 40);
    if (issue.reactions > 0) reasons.push(`${issue.reactions} ${issue.reactions === 1 ? 'reaction' : 'reactions'}`);
    if (issue.comments > 0) reasons.push(`${issue.comments} ${issue.comments === 1 ? 'comment' : 'comments'}`);
  }
  const mm = latestTag ? majorMinor(latestTag) : null;
  if (mm && mentionsVersion(titleLc, mm)) {
    score += 10;
    reasons.push('latest build');
  }
  if (issue.createdAt) {
    const age = now.getTime() - issue.createdAt.getTime();
    if (age < 24 * 3_600_000) {
      score += 8;
      reasons.push('new');
    } else if (age < 72 * 3_600_000) score += 4;
  }
  if (issue.updatedAt && now.getTime() - issue.updatedAt.getTime() > 30 * 86_400_000) score -= 5;
  return { score: Math.max(0, score), critical, reasons };
}

/**
 * The top `keep` issues (score above 0, best first, ties newest first), the repository's urgency
 * (the sum of its top five scores) and how many critical issues it has.
 */
export function rankIssues(issues: IssueInput[], now: Date, latestTag: string | null, keep: number): { urgent: UrgentIssue[]; urgency: number; critical: number } {
  const seen = new Set<number>();
  const ranked: UrgentIssue[] = [];
  for (const i of issues) {
    if (seen.has(i.number)) continue;
    seen.add(i.number);
    const s = scoreIssue(i, now, latestTag);
    if (!s) continue;
    ranked.push({
      number: i.number, title: i.title, url: i.url, createdAt: i.createdAt?.toISOString() ?? null, comments: i.comments, reactions: i.reactions,
      labels: i.labels, score: Math.round(s.score), critical: s.critical, reasons: s.reasons,
    });
  }
  const critical = ranked.filter((u) => u.critical).length;
  const kept = ranked.filter((u) => u.score > 0).sort((a, b) => b.score - a.score || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return { urgent: kept.slice(0, keep), urgency: kept.slice(0, 5).reduce((n, u) => n + u.score, 0), critical };
}

// ---- Builds -------------------------------------------------------------------------------------

export interface Release {
  tag: string;
  url: string | null;
  draft: boolean;
  prerelease: boolean;
  publishedAt: Date | null;
  createdAt: Date | null;
  commitSha: string | null;
  commitAt: Date | null;
  assets: { name: string; downloads: number }[];
}

/** Assets that aren't something a person downloads to run the app (checksums, signatures, updater files). */
export function isCountedAsset(name: string): boolean {
  const n = name.toLowerCase();
  const skip = ['.zsync', '.sha256', '.sha512', '.sha256sum', '.sig', '.asc', '.minisig', '.blockmap', '.json', '.yml', '.yaml', '.txt', '.intoto.jsonl'];
  return !(n.startsWith('sha256sums') || n.startsWith('checksums') || skip.some((s) => n.endsWith(s)));
}

const downloadsOf = (r: Release) => r.assets.filter((a) => isCountedAsset(a.name)).reduce((n, a) => n + a.downloads, 0);

/** The latest build is the newest published release (prereleases are builds too; drafts are ignored). */
export function summarizeReleases(releases: Release[]) {
  const published = releases.filter((r) => !r.draft);
  const at = (r: Release) => (r.publishedAt ?? r.createdAt)?.getTime() ?? 0;
  const latest = published.reduce<Release | null>((best, r) => (!best || at(r) > at(best) ? r : best), null);
  return {
    latest,
    latestAt: latest ? latest.publishedAt ?? latest.createdAt : null,
    latestDownloads: latest ? downloadsOf(latest) : 0,
    totalDownloads: published.reduce((n, r) => n + downloadsOf(r), 0),
  };
}
