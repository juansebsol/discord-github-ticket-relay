import { createSign } from 'node:crypto';
import type { GitHubAppConfig } from '../config.js';
import { fetchWithTimeout, type FetchLike } from '../lib/http.js';

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'discord-github-ticket-relay';

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly githubMessage: string,
    readonly retryAfterSeconds: number | null,
    readonly isRateLimit: boolean,
    readonly details: unknown,
  ) {
    super(`GitHub API ${status}: ${githubMessage}`);
    this.name = 'GitHubApiError';
  }
}

export interface InstallationInfo {
  id: number;
  accountLogin: string;
  accountType: string;
  accountAvatarUrl: string | null;
  repositorySelection: string;
  suspended: boolean;
  /** Permissions granted to this installation, e.g. { issues: 'write', pull_requests: 'read' }. */
  permissions: Record<string, string>;
}

export interface RepoInfo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  visibility: string;
  hasIssues: boolean;
  archived: boolean;
  htmlUrl: string;
}

export interface IssueDetail {
  number: number;
  url: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  /** When and why it was closed ("completed", "not_planned", "duplicate"). */
  closedAt: Date | null;
  stateReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Who opened it, and whether that's a bot account (GitHub Apps, Dependabot and the like). */
  author: string | null;
  authorIsBot: boolean;
  /** GitHub's avatar for the author (only from avatars.githubusercontent.com). */
  authorAvatar: string | null;
}

function toIssueDetail(data: any): IssueDetail {
  return {
    number: data.number,
    url: data.html_url,
    title: String(data.title ?? ''),
    body: typeof data.body === 'string' ? data.body : '',
    state: data.state === 'closed' ? 'closed' : 'open',
    labels: ((data.labels ?? []) as any[]).map((l) => (typeof l === 'string' ? l : String(l?.name ?? ''))).filter(Boolean),
    closedAt: typeof data.closed_at === 'string' ? new Date(data.closed_at) : null,
    stateReason: typeof data.state_reason === 'string' ? data.state_reason : null,
    createdAt: new Date(typeof data.created_at === 'string' ? data.created_at : 0),
    updatedAt: new Date(typeof data.updated_at === 'string' ? data.updated_at : typeof data.created_at === 'string' ? data.created_at : 0),
    author: typeof data.user?.login === 'string' ? data.user.login : null,
    authorIsBot: data.user?.type === 'Bot' || /\[bot\]$/.test(String(data.user?.login ?? '')),
    authorAvatar: typeof data.user?.avatar_url === 'string' && data.user.avatar_url.startsWith('https://avatars.githubusercontent.com/') ? data.user.avatar_url.slice(0, 300) : null,
  };
}

/** A pull request, as GitHub lists it among the issues. */
export interface PullDetail {
  number: number;
  url: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  draft: boolean;
  mergedAt: Date | null;
  labels: string[];
  author: string | null;
  authorIsBot: boolean;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

function toPullDetail(data: any): PullDetail {
  const i = toIssueDetail(data);
  const merged = data.pull_request?.merged_at;
  return {
    number: i.number, url: i.url, title: i.title, body: i.body, state: i.state, draft: Boolean(data.draft), mergedAt: typeof merged === 'string' ? new Date(merged) : null,
    labels: i.labels, author: i.author, authorIsBot: i.authorIsBot, createdAt: i.createdAt, updatedAt: i.updatedAt, closedAt: i.closedAt,
  };
}

export interface CreatedIssue {
  number: number;
  url: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Installation accounts are users/organizations (login) or enterprises (slug/name, no login). */
function accountName(account: any): string {
  return account?.login ?? account?.slug ?? account?.name ?? 'unknown';
}

function toRepo(r: any): RepoInfo {
  return {
    id: r.id,
    owner: r.owner?.login,
    name: r.name,
    fullName: r.full_name,
    private: Boolean(r.private),
    visibility: r.visibility ?? (r.private ? 'private' : 'public'),
    hasIssues: Boolean(r.has_issues),
    archived: Boolean(r.archived),
    htmlUrl: r.html_url,
  };
}

/**
 * Thin GitHub REST client for a GitHub App. Uses short-lived installation access
 * tokens; nothing long-lived is stored besides the app private key in deployment config.
 */
export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: Date;
  at: Date;
}

export class GitHubClient {
  private readonly tokenCache = new Map<number, { token: string; expiresAt: number }>();
  /** The latest core API rate limit GitHub reported for installation requests (Server health). */
  rateLimit: RateLimit | null = null;
  /** The same, per installation (each has its own hourly budget). */
  readonly rateLimits = new Map<number, RateLimit>();

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeouts: { request: number; createIssue: number } = { request: 10_000, createIssue: 15_000 },
  ) {}

  private get timeoutMs(): number {
    return this.timeouts.request;
  }

  get appSlug(): string {
    return this.config.slug;
  }

  installUrl(state: string): string {
    return `https://github.com/apps/${encodeURIComponent(this.config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /** GitHub user authorization URL, used to prove the admin can access an installation. */
  authorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({ client_id: this.config.clientId, state, redirect_uri: redirectUri });
    return `https://github.com/login/oauth/authorize?${params}`;
  }

  appJwt(now = Date.now()): string {
    const iat = Math.floor(now / 1000) - 60;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iat, exp: iat + 540, iss: this.config.clientId || this.config.appId }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${base64url(signer.sign(this.config.privateKey))}`;
  }

  private async request(
    method: string,
    path: string,
    auth: string,
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<{ status: number; data: any; headers: Headers }> {
    const url = path.startsWith('https://') ? path : `${API}${path}`;
    const res = await fetchWithTimeout(
      this.fetchImpl,
      url,
      {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': USER_AGENT,
          Authorization: auth,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      timeoutMs,
    );
    if (auth.startsWith('token ') && (res.headers.get('x-ratelimit-resource') ?? 'core') === 'core') {
      const limit = Number(res.headers.get('x-ratelimit-limit'));
      const remaining = Number(res.headers.get('x-ratelimit-remaining'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining)) {
        this.rateLimit = { limit, remaining, resetAt: new Date(reset * 1000), at: new Date() };
        for (const [id, t] of this.tokenCache) if (auth === `token ${t.token}`) this.rateLimits.set(id, this.rateLimit);
      }
    }
    const text = await res.text();
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text.slice(0, 200) };
      }
    }
    if (!res.ok) {
      const message = typeof data?.message === 'string' ? data.message : res.statusText || 'Request failed';
      const retryAfterHeader = res.headers.get('retry-after');
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = res.headers.get('x-ratelimit-reset');
      let retryAfter: number | null = retryAfterHeader ? Number(retryAfterHeader) : null;
      const isRateLimit =
        res.status === 429 ||
        (res.status === 403 && (remaining === '0' || retryAfterHeader !== null || /rate limit/i.test(message)));
      if (isRateLimit && retryAfter === null) {
        retryAfter = remaining === '0' && reset ? Math.max(1, Number(reset) - Math.floor(Date.now() / 1000)) : 60;
      }
      throw new GitHubApiError(res.status, message, retryAfter, isRateLimit, data?.errors ?? null);
    }
    return { status: res.status, data, headers: res.headers };
  }

  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const { data } = await this.request('POST', `/app/installations/${installationId}/access_tokens`, `Bearer ${this.appJwt()}`, {});
    this.tokenCache.set(installationId, { token: data.token, expiresAt: Date.parse(data.expires_at) });
    return data.token;
  }

  /** What's left of an installation's hourly budget, as last reported (null if unknown or already reset). */
  rateLimitFor(installationId: number): RateLimit | null {
    const r = this.rateLimits.get(installationId);
    return r && r.resetAt.getTime() > Date.now() ? r : null;
  }

  invalidateToken(installationId: number): void {
    this.tokenCache.delete(installationId);
  }

  private async asInstallation(installationId: number) {
    return `token ${await this.installationToken(installationId)}`;
  }

  /** The GitHub App these credentials belong to (verifies app ID, client ID and private key). */
  async getApp(): Promise<{ slug: string; name: string; owner: string }> {
    const { data } = await this.request('GET', '/app', `Bearer ${this.appJwt()}`);
    return { slug: data.slug, name: data.name, owner: data.owner?.login ?? '' };
  }

  async getInstallation(installationId: number): Promise<InstallationInfo> {
    const { data } = await this.request('GET', `/app/installations/${installationId}`, `Bearer ${this.appJwt()}`);
    return {
      id: data.id,
      accountLogin: accountName(data.account),
      accountType: data.account?.type ?? 'User',
      accountAvatarUrl: data.account?.avatar_url ?? null,
      repositorySelection: data.repository_selection ?? 'selected',
      suspended: Boolean(data.suspended_at),
      permissions: data.permissions ?? {},
    };
  }

  async listInstallationRepos(installationId: number, maxPages = 20): Promise<RepoInfo[]> {
    const auth = await this.asInstallation(installationId);
    const repos: RepoInfo[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await this.request('GET', `/installation/repositories?per_page=100&page=${page}`, auth);
      const batch = (data.repositories ?? []).map(toRepo);
      repos.push(...batch);
      if (batch.length < 100) break;
    }
    return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  async getRepoById(installationId: number, repoId: number): Promise<RepoInfo> {
    const { data } = await this.request('GET', `/repositories/${repoId}`, await this.asInstallation(installationId));
    return toRepo(data);
  }

  // ---- Repository files, for AI triage › Knowledge ----------------------------------------------
  // Read-only. Private repositories need Contents: read (contributor roles ask for it too): GitHub
  // answers 403 without it, which callers catch. A file that doesn't exist is null.

  /** The repository's own description, website and topics. */
  async getRepoAbout(installationId: number, owner: string, repo: string): Promise<{ description: string | null; homepage: string | null; topics: string[]; defaultBranch: string | null }> {
    const { data } = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, await this.asInstallation(installationId));
    return { description: data.description ?? null, homepage: data.homepage || null, topics: Array.isArray(data.topics) ? data.topics : [], defaultBranch: data.default_branch || null };
  }

  /**
   * Pull requests merged into a branch after `since`, newest first (Pull requests: read for private
   * repositories). Reads pages of recently updated closed ones until they're older than `since`.
   */
  async listMergedPulls(installationId: number, owner: string, repo: string, base: string, since: Date, maxPages = 3): Promise<{ number: number; title: string; body: string; author: string | null; authorIsBot: boolean; labels: string[]; url: string; mergedAt: Date }[]> {
    const out: { number: number; title: string; body: string; author: string | null; authorIsBot: boolean; labels: string[]; url: string; mergedAt: Date }[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data } = await this.request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=50&page=${page}`,
        await this.asInstallation(installationId),
      );
      const list = Array.isArray(data) ? data : [];
      for (const p of list) {
        if (!p.merged_at || new Date(p.merged_at) <= since) continue;
        out.push({
          number: Number(p.number),
          title: String(p.title ?? ''),
          body: String(p.body ?? ''),
          author: p.user?.login ?? null,
          authorIsBot: p.user?.type === 'Bot' || /\[bot\]$/.test(String(p.user?.login ?? '')),
          labels: Array.isArray(p.labels) ? p.labels.map((l: any) => String(typeof l === 'string' ? l : l?.name ?? '')).filter(Boolean) : [],
          url: String(p.html_url ?? ''),
          mergedAt: new Date(p.merged_at),
        });
      }
      // Sorted by last update: once a page ends before `since`, nothing older was merged after it.
      const lastUpdate = list.at(-1)?.updated_at;
      if (list.length < 50 || (lastUpdate && new Date(lastUpdate) <= since)) break;
    }
    return out.sort((a, b) => b.mergedAt.getTime() - a.mergedAt.getTime());
  }

  /**
   * The merged pull requests that brought a commit into the repository, however they were merged
   * (merge, squash or rebase): none for a commit pushed straight to the branch.
   */
  async mergedPullsOfCommit(installationId: number, owner: string, repo: string, sha: string): Promise<number[]> {
    const { data } = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/pulls`, await this.asInstallation(installationId));
    return (Array.isArray(data) ? data : []).filter((p: any) => p.merged_at).map((p: any) => Number(p.number));
  }

  /** A branch's latest commits (after `since`, when given), newest first (Contents: read for private repositories). */
  async listBranchCommits(installationId: number, owner: string, repo: string, branch: string, since: Date | null, perPage = 50): Promise<{ sha: string; message: string; author: string | null; authorIsBot: boolean; url: string; date: Date; parents: number }[]> {
    const { data } = await this.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(branch)}${since ? `&since=${encodeURIComponent(since.toISOString())}` : ''}&per_page=${perPage}`,
      await this.asInstallation(installationId),
    );
    return (Array.isArray(data) ? data : []).map((c: any) => ({
      sha: String(c.sha ?? ''),
      message: String(c.commit?.message ?? ''),
      author: c.author?.login ?? c.commit?.author?.name ?? null,
      authorIsBot: c.author?.type === 'Bot' || /\[bot\]$/.test(String(c.author?.login ?? '')),
      url: String(c.html_url ?? ''),
      date: new Date(c.commit?.committer?.date ?? c.commit?.author?.date ?? Date.now()),
      parents: Array.isArray(c.parents) ? c.parents.length : 1,
    }));
  }

  // ---- Repo status (read-only: Metadata, Issues, Pull requests and Contents read) ---------------

  /**
   * A GraphQL query as the installation. GraphQL has its own hourly budget, apart from the REST
   * one that filing uses. Missing objects come back as null; errors with no data throw.
   */
  async graphql(installationId: number, query: string, variables: Record<string, unknown> = {}): Promise<any> {
    const { data } = await this.request('POST', '/graphql', await this.asInstallation(installationId), { query, variables });
    const errors = Array.isArray(data?.errors) ? data.errors : [];
    if (errors.length && !data?.data) {
      const limited = errors.some((e: any) => e?.type === 'RATE_LIMITED');
      throw new GitHubApiError(limited ? 403 : 502, String(errors[0]?.message ?? 'GraphQL error'), limited ? 300 : null, limited, errors);
    }
    return data?.data ?? null;
  }

  /** People who have committed to a repository, all time (anonymous emails count): its contributor list's length. */
  async contributorCount(installationId: number, owner: string, repo: string): Promise<number> {
    const { data, headers } = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contributors?per_page=1&anon=1`, await this.asInstallation(installationId));
    const last = /[?&]page=(\d+)>; rel="last"/.exec(headers.get('link') ?? '');
    return last ? Number(last[1]) : Array.isArray(data) ? data.length : 0;
  }

  /** A file's bytes by its blob id (a repository's app icon). */
  async blob(installationId: number, owner: string, repo: string, sha: string): Promise<Buffer> {
    const { data } = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`, await this.asInstallation(installationId));
    return Buffer.from(String(data?.content ?? ''), data?.encoding === 'base64' ? 'base64' : 'utf8');
  }

  /** The README, whatever its name (README.md, readme.rst…). */
  async getReadme(installationId: number, owner: string, repo: string): Promise<{ path: string; text: string } | null> {
    return this.fileAt(installationId, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`);
  }

  /** A text file on the default branch. */
  async getRepoFile(installationId: number, owner: string, repo: string, path: string): Promise<{ path: string; text: string } | null> {
    return this.fileAt(installationId, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
  }

  /** The files directly in a folder on the default branch (null when there's no such folder). */
  async listRepoFolder(installationId: number, owner: string, repo: string, path: string): Promise<{ path: string; size: number }[] | null> {
    try {
      const { data } = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, await this.asInstallation(installationId));
      return Array.isArray(data) ? data.filter((f: any) => f.type === 'file').map((f: any) => ({ path: String(f.path), size: Number(f.size ?? 0) })) : null;
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** The latest published releases, newest first (drafts left out). */
  async listReleases(installationId: number, owner: string, repo: string, limit = 10): Promise<{ tag: string; name: string | null; publishedAt: Date | null; prerelease: boolean; body: string }[]> {
    const { data } = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${Math.min(limit, 100)}`, await this.asInstallation(installationId));
    return (Array.isArray(data) ? data : [])
      .filter((r: any) => !r.draft)
      .map((r: any) => ({ tag: String(r.tag_name ?? ''), name: r.name || null, publishedAt: r.published_at ? new Date(r.published_at) : null, prerelease: Boolean(r.prerelease), body: String(r.body ?? '') }));
  }

  private async fileAt(installationId: number, path: string): Promise<{ path: string; text: string } | null> {
    try {
      const { data } = await this.request('GET', path, await this.asInstallation(installationId));
      // Files over 1 MB come without their content; they're never what's wanted here.
      if (data?.type !== 'file' || typeof data.content !== 'string' || !data.content) return null;
      return { path: String(data.path ?? ''), text: Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8') };
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }

  async listLabels(installationId: number, owner: string, repo: string): Promise<string[]> {
    const auth = await this.asInstallation(installationId);
    const labels: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const { data } = await this.request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels?per_page=100&page=${page}`,
        auth,
      );
      labels.push(...(data as any[]).map((l) => l.name as string));
      if ((data as any[]).length < 100) break;
    }
    return labels;
  }

  async createIssue(
    installationId: number,
    owner: string,
    repo: string,
    issue: { title: string; body: string; labels: string[] },
    timeoutMs = this.timeouts.createIssue,
  ): Promise<CreatedIssue> {
    const { data } = await this.request(
      'POST',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      await this.asInstallation(installationId),
      issue.labels.length ? issue : { title: issue.title, body: issue.body },
      timeoutMs,
    );
    return { number: data.number, url: data.html_url };
  }

  async getIssue(installationId: number, owner: string, repo: string, issueNumber: number): Promise<CreatedIssue & { isPullRequest: boolean }> {
    const { data } = await this.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      await this.asInstallation(installationId),
    );
    return { number: data.number, url: data.html_url, isPullRequest: Boolean(data.pull_request) };
  }

  /** Title, body, state and labels of an issue (triage reads the ticket text from here). */
  async getIssueDetail(installationId: number, owner: string, repo: string, issueNumber: number): Promise<IssueDetail> {
    const { data } = await this.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      await this.asInstallation(installationId),
    );
    return toIssueDetail(data);
  }

  /**
   * One page (up to 100) of a repository's issues, open and closed, with the pull requests GitHub
   * lists among them kept apart. `more` says whether another page may follow. Used to fill and
   * refresh the issue index and the pull request index.
   */
  async listIssuesPage(
    installationId: number,
    owner: string,
    repo: string,
    o: { sort: 'created' | 'updated'; direction: 'asc' | 'desc'; page: number; since?: Date; perPage?: number; state?: 'all' | 'open' },
  ): Promise<{ issues: IssueDetail[]; pulls: PullDetail[]; more: boolean }> {
    const perPage = o.perPage ?? 100;
    const params = new URLSearchParams({ state: o.state ?? 'all', sort: o.sort, direction: o.direction, per_page: String(perPage), page: String(o.page) });
    if (o.since) params.set('since', o.since.toISOString());
    const { data } = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${params}`, await this.asInstallation(installationId));
    const items = data as any[];
    return { issues: items.filter((i) => !i.pull_request).map(toIssueDetail), pulls: items.filter((i) => i.pull_request).map(toPullDetail), more: items.length >= perPage };
  }

  /** The first comments on an issue (to find "Duplicate of #N"). */
  async listIssueComments(installationId: number, owner: string, repo: string, issueNumber: number, perPage = 30): Promise<string[]> {
    const { data } = await this.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=${perPage}`,
      await this.asInstallation(installationId),
    );
    return ((data ?? []) as any[]).map((c) => (typeof c.body === 'string' ? c.body : ''));
  }

  /** Recently updated issues (not pull requests), newest first. */
  async listRecentIssues(installationId: number, owner: string, repo: string, state: 'open' | 'all', limit = 30): Promise<IssueDetail[]> {
    const { data } = await this.request(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&sort=updated&direction=desc&per_page=${Math.min(100, limit)}`,
      await this.asInstallation(installationId),
    );
    return (data as any[]).filter((i) => !i.pull_request).map(toIssueDetail);
  }

  /** Issues in one repository matching the search terms (best match first). */
  async searchIssues(installationId: number, owner: string, repo: string, terms: string, limit = 10): Promise<IssueDetail[]> {
    const q = `repo:${owner}/${repo} is:issue ${terms}`;
    const { data } = await this.request('GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(50, limit)}`, await this.asInstallation(installationId));
    return ((data.items ?? []) as any[]).filter((i) => !i.pull_request).map(toIssueDetail);
  }

  async addLabels(installationId: number, owner: string, repo: string, issueNumber: number, labels: string[]): Promise<void> {
    await this.request(
      'POST',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`,
      await this.asInstallation(installationId),
      { labels },
    );
  }

  async createComment(installationId: number, owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    await this.request(
      'POST',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      await this.asInstallation(installationId),
      { body },
    );
  }

  /** Replaces the issue's body (used to keep its Attachments section current). */
  async updateIssueBody(installationId: number, owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    await this.request(
      'PATCH',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      await this.asInstallation(installationId),
      { body },
    );
  }

  /** Closes an issue as "not planned". */
  async closeIssue(installationId: number, owner: string, repo: string, issueNumber: number): Promise<void> {
    await this.request(
      'PATCH',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      await this.asInstallation(installationId),
      { state: 'closed', state_reason: 'not_planned' },
    );
  }

  /**
   * Looks for an issue whose body contains the submission marker. Used to reconcile
   * submissions whose create request had an unknown outcome. Lists recently updated
   * issues (strongly consistent) and falls back to search (eventually consistent).
   */
  async findIssueByMarker(
    installationId: number,
    owner: string,
    repo: string,
    marker: string,
    since: Date,
  ): Promise<CreatedIssue | null> {
    const auth = await this.asInstallation(installationId);
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
    const sinceIso = new Date(since.getTime() - 5 * 60_000).toISOString();
    for (let page = 1; page <= 5; page++) {
      const { data } = await this.request(
        'GET',
        `${base}?state=all&sort=created&direction=desc&per_page=100&page=${page}&since=${encodeURIComponent(sinceIso)}`,
        auth,
      );
      const items = data as any[];
      const match = items.find((i) => !i.pull_request && typeof i.body === 'string' && i.body.includes(marker));
      if (match) return { number: match.number, url: match.html_url };
      if (items.length < 100) return null;
    }
    const q = `"${marker}" repo:${owner}/${repo} is:issue in:body`;
    const { data } = await this.request('GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=5`, auth);
    const hit = (data.items as any[] | undefined)?.find((i) => typeof i.body === 'string' && i.body.includes(marker));
    return hit ? { number: hit.number, url: hit.html_url } : null;
  }

  async exchangeOAuthCode(code: string, redirectUri: string): Promise<string> {
    const res = await fetchWithTimeout(
      this.fetchImpl,
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      },
      this.timeoutMs,
    );
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new GitHubApiError(res.status, data.error_description ?? data.error ?? 'OAuth exchange failed', null, false, null);
    }
    return data.access_token;
  }

  /** Creates a label (Issues: write). Returns false if it already exists. */
  async createLabel(installationId: number, owner: string, repo: string, name: string, color: string): Promise<boolean> {
    try {
      await this.request(
        'POST',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`,
        await this.asInstallation(installationId),
        { name, color },
      );
      return true;
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 422) return false; // already exists
      throw err;
    }
  }

  /** The GitHub account behind a user access token (identity only). */
  async getAuthenticatedUser(userToken: string): Promise<{ id: number; login: string }> {
    const { data } = await this.request('GET', '/user', `Bearer ${userToken}`);
    return { id: data.id, login: data.login };
  }

  /** Number of merged pull requests authored by `login` in the repository. */
  async countMergedPullRequests(installationId: number, owner: string, repo: string, login: string): Promise<number> {
    const q = `repo:${owner}/${repo} is:pr is:merged author:${login}`;
    const { data } = await this.request('GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=1`, await this.asInstallation(installationId));
    return Number(data.total_count ?? 0);
  }

  /** Number of commits on the default branch attributed to `login` (read from pagination). */
  async countAuthoredCommits(installationId: number, owner: string, repo: string, login: string): Promise<number> {
    try {
      const { data, headers } = await this.request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?author=${encodeURIComponent(login)}&per_page=1`,
        await this.asInstallation(installationId),
      );
      if (!Array.isArray(data) || data.length === 0) return 0;
      const last = /[?&]page=(\d+)>; rel="last"/.exec(headers.get('link') ?? '');
      return last ? Number(last[1]) : data.length;
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 409) return 0; // empty repository
      throw err;
    }
  }

  /** Installations of this app that the authorizing GitHub user can access. */
  async listUserInstallations(userToken: string): Promise<InstallationInfo[]> {
    const out: InstallationInfo[] = [];
    for (let page = 1; page <= 10; page++) {
      const { data } = await this.request('GET', `/user/installations?per_page=100&page=${page}`, `Bearer ${userToken}`);
      const batch = (data.installations ?? []) as any[];
      for (const i of batch) {
        out.push({
          id: i.id,
          accountLogin: accountName(i.account),
          accountType: i.account?.type ?? (i.account?.slug ? 'Enterprise' : 'User'),
          accountAvatarUrl: i.account?.avatar_url ?? null,
          repositorySelection: i.repository_selection ?? 'selected',
          suspended: Boolean(i.suspended_at),
          permissions: i.permissions ?? {},
        });
      }
      if (batch.length < 100) break;
    }
    return out;
  }
}
