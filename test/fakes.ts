/**
 * In-memory fakes of the GitHub and Discord REST APIs, served through a fetch function.
 * They exercise the real HTTP clients (headers, status codes, error classification)
 * without network access. Everything verified through these is MOCKED verification.
 */

type Json = Record<string, any>;

export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  has_issues: boolean;
  archived: boolean;
  labels: string[];
  issues: { number: number; title: string; body: string; labels: string[]; created_at: string; updated_at?: string; user: string; state?: 'open' | 'closed'; state_reason?: string | null; closed_at?: string | null; comments?: string[]; bodyEdits?: number; reactions?: number; association?: string }[];
  /** Files on the default branch, by path (README.md, docs/FAQ.md…). */
  files?: Record<string, string>;
  releases?: { tag: string; name?: string; published_at?: string; body?: string; draft?: boolean; prerelease?: boolean; assets?: { name: string; downloads: number }[] }[];
  description?: string | null;
  topics?: string[];
  default_branch?: string;
  /** Pull requests (closed ones with merged_at were merged), and the commits each one brought (merged or rebased). */
  pulls?: { number: number; title: string; body?: string; user: string; base?: string; merged_at?: string | null; updated_at?: string; created_at?: string; labels?: string[]; commits?: string[]; draft?: boolean }[];
  /** Commits on the default branch, newest first. */
  branchCommits?: { sha: string; message: string; user?: string | null; date: string; parents?: number }[];
  /** The app icon (a PNG under assets/app-icon/…), for Repo status. */
  icon?: Buffer;
}

/** How the next create-issue call behaves. */
export type CreateBehavior =
  | 'ok'
  | 'timeout_after_create' // GitHub creates the issue but the response never arrives
  | 'timeout_before_create' // request hangs and GitHub never creates it
  | 'reset_after_create' // connection drops after GitHub created it
  | 'refused' // connection refused (never sent)
  | { status: number; body?: Json; headers?: Record<string, string> };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}

function netError(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
}

export class FakeGitHub {
  installations = new Map<number, { account: { login: string; type: string }; repoIds: number[]; suspended: boolean }>();
  repos = new Map<number, FakeRepo>();
  /** Installation IDs the authorizing GitHub user can access (GET /user/installations). */
  userInstallationIds: number[] = [];
  createQueue: CreateBehavior[] = [];
  createCalls = 0;
  tokenCalls = 0;
  tokenFailures: { status: number; message: string }[] = [];
  nextIssueNumber = 100;
  invalidToken: string | null = null;
  /** Artificial latency for create-issue calls (to make workers overlap in tests). */
  createDelayMs = 0;
  /** GET /repos/:o/:r/issues calls (the issue index syncs with these). */
  listCalls = 0;
  /** Every request made to the fake GitHub. */
  requests = 0;
  /** Requests to fail once each, matched on "METHOD /path". */
  failRequests: { match: RegExp; status: number; message: string }[] = [];
  /** Simulates a wrong/rotated private key: every app-JWT call is rejected. */
  rejectAppJwt = false;
  /** GitHub account returned for the user access token from code `good-code`. */
  oauthUser = { id: 4242, login: 'octo-dev' };
  /** repoId → login → number of merged PRs / authored commits. */
  mergedPrs = new Map<number, Map<string, number>>();
  commits = new Map<number, Map<string, number>>();
  installationPermissions: Record<string, string> = { issues: 'write', metadata: 'read', pull_requests: 'read', contents: 'read' };
  /** POST /graphql calls, the points GitHub says are left, and whether the next calls are rate limited. */
  graphqlCalls = 0;
  graphqlBudget = 4800;
  graphqlLimited = false;
  appSlug = 'ticket-relay';

  addInstallation(id: number, login: string, repos: Partial<FakeRepo>[], type = 'Organization') {
    const ids: number[] = [];
    for (const r of repos) {
      const repo: FakeRepo = {
        id: r.id ?? 1000 + this.repos.size,
        owner: r.owner ?? login,
        name: r.name ?? `repo${this.repos.size}`,
        private: r.private ?? true,
        has_issues: r.has_issues ?? true,
        archived: r.archived ?? false,
        labels: r.labels ?? ['bug', 'support'],
        issues: [],
        files: r.files ?? {},
        releases: r.releases ?? [],
        description: r.description ?? null,
        topics: r.topics ?? [],
        default_branch: r.default_branch ?? 'main',
        pulls: r.pulls ?? [],
        branchCommits: r.branchCommits ?? [],
        icon: r.icon,
      };
      this.repos.set(repo.id, repo);
      ids.push(repo.id);
    }
    this.installations.set(id, { account: { login, type }, repoIds: ids, suspended: false });
    return ids;
  }

  allIssues() {
    return [...this.repos.values()].flatMap((r) => r.issues.map((i) => ({ ...i, repo: `${r.owner}/${r.name}` })));
  }

  private repoByName(owner: string, name: string) {
    return [...this.repos.values()].find((r) => r.owner === owner && r.name === name);
  }

  searchCalls = 0;
  /** GET /repos/:o/:r/commits/:sha/pulls calls (which pull request brought a commit in). */
  commitPullsCalls = 0;

  issueJson(r: FakeRepo, i: FakeRepo['issues'][number]) {
    return { number: i.number, title: i.title, body: i.body, user: { login: i.user, type: /\[bot\]$/.test(i.user) ? 'Bot' : 'User' }, state: i.state ?? 'open', state_reason: i.state_reason ?? null, closed_at: i.closed_at ?? null, created_at: i.created_at, updated_at: i.updated_at ?? i.created_at, labels: i.labels.map((name) => ({ name })), html_url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}` };
  }

  /** What GitHub's GraphQL API would answer for the Repo status queries. */
  private graphqlData(query: string, v: Json, accessible: (r: FakeRepo | undefined) => unknown): Json {
    const repo = this.repoByName(String(v.owner), String(v.name));
    if (!accessible(repo)) return { repository: null };
    const r = repo!;
    const at = (s: string | null | undefined) => (s ? Date.parse(s) : 0);
    const page = <T>(list: T[], after: unknown, n = 100) => {
      const start = after ? Number(after) : 0;
      return { nodes: list.slice(start, start + n), pageInfo: { hasNextPage: start + n < list.length, endCursor: String(start + n) } };
    };
    const commits = r.branchCommits ?? [];
    const pulls = r.pulls ?? [];
    const created = (p: NonNullable<FakeRepo['pulls']>[number]) => p.created_at ?? p.updated_at ?? p.merged_at ?? '2020-01-01T00:00:00Z';
    const open = pulls.filter((p) => p.merged_at === undefined);
    const merged = pulls.filter((p) => p.merged_at);
    const openIssues = r.issues.filter((i) => (i.state ?? 'open') === 'open');
    const newestFirst = <T>(list: T[], when: (x: T) => string | null | undefined) => [...list].sort((a, b) => at(when(b)) - at(when(a)));
    const issueNode = (i: FakeRepo['issues'][number]) => ({
      number: i.number, title: i.title, url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}`, createdAt: i.created_at, updatedAt: i.updated_at ?? i.created_at,
      authorAssociation: i.association ?? 'NONE', comments: { totalCount: i.comments?.length ?? 0 }, reactions: { totalCount: i.reactions ?? 0 }, labels: { nodes: i.labels.map((name) => ({ name })) },
    });
    if (query.includes('releases(')) {
      const p = page(newestFirst(r.releases ?? [], (x) => x.published_at), v.after, 50);
      return { repository: { releases: { pageInfo: p.pageInfo, nodes: p.nodes.map((x) => ({
        tagName: x.tag, url: `https://github.com/${r.owner}/${r.name}/releases/tag/${x.tag}`, isDraft: Boolean(x.draft), isPrerelease: Boolean(x.prerelease),
        publishedAt: x.draft ? null : x.published_at ?? null, createdAt: x.published_at ?? null, tagCommit: { oid: `tag-${x.tag}`, committedDate: x.published_at ?? null },
        releaseAssets: { nodes: (x.assets ?? []).map((a) => ({ name: a.name, downloadCount: a.downloads })) },
      })) } } };
    }
    if (query.includes('compare(')) {
      const rel = (r.releases ?? []).find((x) => `refs/tags/${x.tag}` === v.tag);
      const ahead = commits.filter((c) => at(c.date) > at(rel?.published_at)).length;
      return { repository: { ref: rel ? { compare: { status: ahead ? 'AHEAD' : 'IDENTICAL', aheadBy: ahead } } : null, defaultBranchRef: { target: { since: { totalCount: commits.filter((c) => at(c.date) >= at(String(v.at))).length } } } } };
    }
    if (query.includes('history(since: $since')) {
      const p = page(commits.filter((c) => at(c.date) >= at(String(v.since))), v.after);
      return { repository: { defaultBranchRef: { target: { history: { pageInfo: p.pageInfo, nodes: p.nodes.map((c) => ({
        oid: c.sha, committedDate: c.date, author: { email: `${c.user ?? 'someone'}@example.com`, name: c.user ?? 'Someone', user: c.user ? { login: c.user } : null },
      })) } } } } };
    }
    if (query.includes('opened: pullRequests')) {
      const out: Json = {};
      if (v.opened) out.opened = page(newestFirst(pulls, created).map((p) => ({ number: p.number, createdAt: created(p) })), v.openedAfter);
      if (v.merged) out.merged = page(newestFirst(merged, (p) => p.updated_at ?? p.merged_at).map((p) => ({ number: p.number, updatedAt: p.updated_at ?? p.merged_at, mergedAt: p.merged_at })), v.mergedAfter);
      if (v.issues) out.issues = page(newestFirst(r.issues, (i) => i.created_at).map((i) => ({ number: i.number, createdAt: i.created_at })), v.issuesAfter);
      return { repository: out };
    }
    // The main query: counts, dates, each window's commits (aliases c0…, cb) and the open issues.
    const head: Json = { all: { totalCount: commits.length, nodes: commits.slice(0, 1).map((c) => ({ committedDate: c.date })) } };
    for (const m of query.matchAll(/(c\d+|cb): history\(since: "([^"]+)"\)/g)) head[m[1]!] = { totalCount: commits.filter((c) => at(c.date) >= Date.parse(m[2]!)).length };
    const oldestOpen = newestFirst(open, created).at(-1);
    const newestPr = newestFirst(pulls, created)[0];
    const newestIssue = newestFirst(r.issues, (i) => i.created_at)[0];
    return {
      repository: {
        openPrs: { totalCount: open.length }, allPrs: { totalCount: pulls.length }, mergedPrs: { totalCount: merged.length },
        oldestOpenPr: { nodes: oldestOpen ? [{ createdAt: created(oldestOpen) }] : [] },
        newestPr: { nodes: newestPr ? [{ createdAt: created(newestPr) }] : [] },
        openIssues: { totalCount: openIssues.length }, allIssues: { totalCount: r.issues.length },
        newestIssue: { nodes: newestIssue ? [{ createdAt: newestIssue.created_at }] : [] },
        icon: r.icon ? { entries: [{ name: 'app.png', oid: `icon-${r.id}` }] } : null,
        recentOpen: { nodes: newestFirst(openIssues, (i) => i.created_at).slice(0, 100).map(issueNode) },
        hotOpen: { nodes: [...openIssues].sort((a, b) => (b.comments?.length ?? 0) - (a.comments?.length ?? 0)).slice(0, 30).map(issueNode) },
        defaultBranchRef: { name: r.default_branch ?? 'main', target: head },
      },
      rateLimit: { remaining: this.graphqlBudget, resetAt: new Date(Date.now() + 3600_000).toISOString() },
    };
  }

  private repoJson(r: FakeRepo) {
    return {
      id: r.id,
      name: r.name,
      full_name: `${r.owner}/${r.name}`,
      owner: { login: r.owner },
      private: r.private,
      visibility: r.private ? 'private' : 'public',
      has_issues: r.has_issues,
      archived: r.archived,
      html_url: `https://github.com/${r.owner}/${r.name}`,
    };
  }

  async handle(url: URL, init: RequestInit): Promise<Response> {
    this.requests++;
    const method = init.method ?? 'GET';
    const path = url.pathname;
    const fail = this.failRequests.findIndex((f) => f.match.test(`${method} ${path}`));
    if (fail >= 0) {
      const f = this.failRequests.splice(fail, 1)[0]!;
      return json(f.status, { message: f.message });
    }
    const auth = String((init.headers as Record<string, string>)?.Authorization ?? '');
    const body = init.body ? JSON.parse(String(init.body)) : {};
    let m: RegExpExecArray | null;

    if (url.hostname === 'github.com' && path === '/login/oauth/access_token') {
      return body.code === 'good-code' ? json(200, { access_token: 'ghu_user', token_type: 'bearer' }) : json(200, { error: 'bad_verification_code' });
    }
    if (path === '/user') {
      return auth === 'Bearer ghu_user' ? json(200, this.oauthUser) : json(401, { message: 'Bad credentials' });
    }
    if (path === '/user/installations') {
      return json(200, {
        total_count: this.userInstallationIds.length,
        installations: this.userInstallationIds.map((id) => ({ id, account: this.installations.get(id)?.account, repository_selection: 'selected' })),
      });
    }
    if (path.startsWith('/app') && this.rejectAppJwt) return json(401, { message: 'A JSON web token could not be decoded' });
    if (path === '/app') return json(200, { slug: this.appSlug, name: 'Ticket Relay', owner: { login: 'owner' } });
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path)) && method === 'POST') {
      this.tokenCalls++;
      const failure = this.tokenFailures.shift();
      if (failure) return json(failure.status, { message: failure.message });
      const inst = this.installations.get(Number(m[1]));
      if (!inst) return json(404, { message: 'Not Found' });
      if (inst.suspended) return json(403, { message: 'This installation has been suspended' });
      return json(201, { token: `ghs_${m[1]}_${this.tokenCalls}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if ((m = /^\/app\/installations\/(\d+)$/.exec(path))) {
      const inst = this.installations.get(Number(m[1]));
      if (!inst) return json(404, { message: 'Not Found' });
      return json(200, { id: Number(m[1]), account: { ...inst.account, avatar_url: null }, repository_selection: 'selected', suspended_at: inst.suspended ? new Date().toISOString() : null, permissions: this.installationPermissions });
    }

    // Installation-token endpoints.
    const tokenMatch = /^token ghs_(\d+)_/.exec(auth);
    if (!tokenMatch || auth === `token ${this.invalidToken}`) return json(401, { message: 'Bad credentials' });
    const inst = this.installations.get(Number(tokenMatch[1]));
    if (!inst) return json(401, { message: 'Bad credentials' });
    const accessible = (r: FakeRepo | undefined) => r && inst.repoIds.includes(r.id);

    if (path === '/installation/repositories') {
      const repos = inst.repoIds.map((id) => this.repos.get(id)!).map((r) => this.repoJson(r));
      return json(200, { total_count: repos.length, repositories: repos });
    }
    if ((m = /^\/repositories\/(\d+)$/.exec(path))) {
      const r = this.repos.get(Number(m[1]));
      return accessible(r) ? json(200, this.repoJson(r!)) : json(404, { message: 'Not Found' });
    }
    // GraphQL (Repo status): answered from the same repositories, by what the query asks for.
    if (path === '/graphql' && method === 'POST') {
      this.graphqlCalls++;
      if (this.graphqlLimited) return json(200, { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for installation.' }] });
      return json(200, { data: this.graphqlData(String(body.query), body.variables ?? {}, accessible) });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/contributors$/.exec(path)) && method === 'GET') {
      const r = this.repoByName(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      if (!accessible(r)) return json(404, { message: 'Not Found' });
      const people = new Set((r!.branchCommits ?? []).map((c) => c.user ?? 'someone')).size;
      return json(200, people ? [{ login: 'someone', contributions: 1 }] : [], people > 1 ? { link: `<https://api.github.com/repos/${r!.owner}/${r!.name}/contributors?per_page=1&anon=1&page=2>; rel="next", <https://api.github.com/repos/${r!.owner}/${r!.name}/contributors?per_page=1&anon=1&page=${people}>; rel="last"` } : {});
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/git\/blobs\/([^/]+)$/.exec(path)) && method === 'GET') {
      const r = this.repoByName(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      if (!accessible(r) || !r!.icon || m[3] !== `icon-${r!.id}`) return json(404, { message: 'Not Found' });
      return json(200, { sha: m[3], encoding: 'base64', content: r!.icon.toString('base64'), size: r!.icon.length });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/labels$/.exec(path))) {
      const r = this.repoByName(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      if (!accessible(r)) return json(404, { message: 'Not Found' });
      if (method === 'POST') {
        if (r!.labels.includes(body.name)) return json(422, { message: 'Validation Failed', errors: [{ code: 'already_exists' }] });
        r!.labels.push(body.name);
        return json(201, { name: body.name, color: body.color });
      }
      return json(200, r!.labels.map((name) => ({ name })));
    }
    // Repository files and releases (Contents: read, needed for private repositories).
    if ((m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path)) && method === 'GET') {
      const r = this.repoByName(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      if (!accessible(r)) return json(404, { message: 'Not Found' });
      return json(200, { ...this.repoJson(r!), description: r!.description ?? null, homepage: null, topics: r!.topics ?? [], default_branch: r!.default_branch ?? 'main' });
    }
    // Pull requests, and the ones that brought a commit in (Pull requests: read, needed for private repositories).
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/(?:pulls|commits\/([^/]+)\/pulls)$/.exec(path)) && method === 'GET') {
      const r = this.repoByName(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      if (!accessible(r)) return json(404, { message: 'Not Found' });
      if (r!.private && !this.installationPermissions.pull_requests) return json(403, { message: 'Resource not accessible by integration' });
      const user = (login: string) => ({ login, type: /\[bot\]$/.test(login) ? 'Bot' : 'User' });
      this.commitPullsCalls += m[3] ? 1 : 0;
      if (m[3]) return json(200, (r!.pulls ?? []).filter((x) => x.commits?.includes(decodeURIComponent(m![3]!))).map((x) => ({ number: x.number, merged_at: x.merged_at ?? null })));
      const p = url.searchParams;
      const perPage = Number(p.get('per_page') ?? 30);
      const page = Number(p.get('page') ?? 1);
      const closed = (r!.pulls ?? [])
        .filter((x) => (p.get('state') !== 'closed' || x.merged_at !== undefined) && (!p.get('base') || (x.base ?? r!.default_branch ?? 'main') === p.get('base')))
        .sort((a, b) => Date.parse(b.updated_at ?? b.merged_at ?? '') - Date.parse(a.updated_at ?? a.merged_at ?? ''));
      return json(200, closed.slice((page - 1) * perPage, page * perPage).map((x) => ({
        number: x.number, title: x.title, body: x.body ?? '', user: user(x.user), merged_at: x.merged_at ?? null, updated_at: x.updated_at ?? x.merged_at, labels: (x.labels ?? []).map((name) => ({ name })),
        html_url: `https://github.com/${r!.owner}/${r!.name}/pull/${x.number}`,
      })));
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/(readme|contents\/(.+)|releases)$/.exec(path)) && method === 'GET') {
      const r = this.repoByName(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      if (!accessible(r)) return json(404, { message: 'Not Found' });
      if (r!.private && !this.installationPermissions.contents) return json(403, { message: 'Resource not accessible by integration' });
      const files = r!.files ?? {};
      if (m[3] === 'releases') {
        return json(200, (r!.releases ?? []).map((x) => ({ tag_name: x.tag, name: x.name ?? null, published_at: x.published_at ?? null, body: x.body ?? '', draft: Boolean(x.draft), prerelease: Boolean(x.prerelease) })));
      }
      const want = m[3] === 'readme' ? Object.keys(files).find((f) => /^readme(\.|$)/i.test(f)) : m[4]!.split('/').map(decodeURIComponent).join('/');
      if (want && files[want] !== undefined) return json(200, { type: 'file', path: want, size: files[want]!.length, encoding: 'base64', content: Buffer.from(files[want]!).toString('base64') });
      const inside = want ? Object.keys(files).filter((f) => f.startsWith(`${want}/`) && !f.slice(want.length + 1).includes('/')) : [];
      if (m[4] && inside.length) return json(200, inside.map((f) => ({ type: 'file', path: f, size: files[f]!.length })));
      return json(404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/commits$/.exec(path))) {
      const r = this.repoByName(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      if (!accessible(r)) return json(404, { message: 'Not Found' });
      // A branch's commits since a date (Contents: read, needed for private repositories).
      if (url.searchParams.get('sha')) {
        if (r!.private && !this.installationPermissions.contents) return json(403, { message: 'Resource not accessible by integration' });
        const since = Date.parse(url.searchParams.get('since') ?? '1970-01-01T00:00:00Z');
        return json(200, (r!.branchCommits ?? []).filter((c) => Date.parse(c.date) >= since).slice(0, Number(url.searchParams.get('per_page') ?? 30)).map((c) => ({
          sha: c.sha, html_url: `https://github.com/${r!.owner}/${r!.name}/commit/${c.sha}`,
          commit: { message: c.message, author: { name: c.user ?? 'Someone', date: c.date }, committer: { date: c.date } },
          author: c.user ? { login: c.user, type: /\[bot\]$/.test(c.user) ? 'Bot' : 'User' } : null,
          parents: Array.from({ length: c.parents ?? 1 }, (_, i) => ({ sha: `p${i}` })),
        })));
      }
      const author = url.searchParams.get('author') ?? '';
      const n = this.commits.get(r!.id)?.get(author) ?? 0;
      const link: Record<string, string> = n > 1 ? { link: `<https://api.github.com${path}?author=${author}&per_page=1&page=2>; rel="next", <https://api.github.com${path}?author=${author}&per_page=1&page=${n}>; rel="last"` } : {};
      return json(200, n ? [{ sha: 'abc' }] : [], link);
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(\/labels|\/comments)?$/.exec(path))) {
      const r = this.repoByName(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      const issue = r?.issues.find((i) => i.number === Number(m![3]));
      if (!accessible(r) || !issue) return json(404, { message: 'Not Found' });
      if (method !== 'GET') issue.updated_at = new Date(Math.max(Date.now(), Date.parse(issue.updated_at ?? issue.created_at) + 1)).toISOString();
      if (m[4] === '/comments' && method === 'GET') return json(200, (issue.comments ?? []).map((c, n) => ({ id: n + 1, body: c })));
      if (m[4] === '/labels' && method === 'POST') {
        for (const l of body.labels as string[]) {
          if (!r!.labels.includes(l)) r!.labels.push(l);
          if (!issue.labels.includes(l)) issue.labels.push(l);
        }
        return json(200, issue.labels.map((name) => ({ name })));
      }
      if (m[4] === '/comments' && method === 'POST') {
        (issue.comments ??= []).push(body.body);
        return json(201, { id: issue.comments.length });
      }
      if (method === 'PATCH') {
        if (body.state) {
          if (body.state === 'closed' && issue.state !== 'closed') issue.closed_at = new Date().toISOString();
          issue.state = body.state;
        }
        if ('state_reason' in body) issue.state_reason = body.state_reason;
        if (typeof body.body === 'string') {
          issue.body = body.body;
          issue.bodyEdits = (issue.bodyEdits ?? 0) + 1;
        }
      }
      return json(200, this.issueJson(r!, issue));
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path))) {
      const r = this.repoByName(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      if (!accessible(r)) return json(404, { message: 'Not Found' });
      const repo = r!;
      if (method === 'GET') {
        this.listCalls++;
        const p = url.searchParams;
        const state = p.get('state') ?? 'open';
        const sort = p.get('sort') ?? 'created';
        const asc = p.get('direction') === 'asc';
        const since = p.get('since');
        const perPage = Number(p.get('per_page') ?? 30);
        const page = Number(p.get('page') ?? 1);
        const time = (v: string | undefined) => Date.parse(v ?? '') || Date.now();
        // GitHub lists pull requests among the issues (with a pull_request key).
        type Listed = { created_at: string; updated_at?: string; state?: 'open' | 'closed'; number: number; json: () => Json };
        const pullsListed: Listed[] = (repo.pulls ?? []).map((x) => {
          const created = x.created_at ?? x.updated_at ?? x.merged_at ?? new Date().toISOString();
          const state = x.merged_at === undefined ? 'open' as const : 'closed' as const;
          return {
            created_at: created, updated_at: x.updated_at ?? x.merged_at ?? created, state, number: x.number,
            json: () => ({
              number: x.number, title: x.title, body: x.body ?? '', user: { login: x.user, type: /\[bot\]$/.test(x.user) ? 'Bot' : 'User' }, state, draft: Boolean(x.draft),
              closed_at: state === 'closed' ? x.merged_at ?? x.updated_at ?? created : null, created_at: created, updated_at: x.updated_at ?? x.merged_at ?? created,
              labels: (x.labels ?? []).map((name) => ({ name })), html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${x.number}`,
              pull_request: { url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${x.number}`, merged_at: x.merged_at ?? null },
            }),
          };
        });
        const listed: Listed[] = [...repo.issues.map((i) => ({ ...i, json: () => this.issueJson(repo, i) })), ...pullsListed];
        const key = (i: Listed) => time(sort === 'updated' ? i.updated_at ?? i.created_at : i.created_at) * 100000 + i.number;
        const items = listed
          .filter((i) => state === 'all' || (i.state ?? 'open') === state)
          .filter((i) => !since || time(i.updated_at ?? i.created_at) >= Date.parse(since))
          .sort((a, b) => (asc ? key(a) - key(b) : key(b) - key(a)))
          .slice((page - 1) * perPage, page * perPage)
          .map((i) => i.json());
        return json(200, items);
      }
      this.createCalls++;
      if (this.createDelayMs) await new Promise((r) => setTimeout(r, this.createDelayMs));
      const behavior = this.createQueue.shift() ?? 'ok';
      if (behavior === 'refused') throw netError('ECONNREFUSED');
      if (behavior === 'timeout_before_create') return hang(init.signal);
      if (typeof behavior === 'object') return json(behavior.status, behavior.body ?? { message: 'error' }, behavior.headers);
      if (!repo.has_issues) return json(410, { message: 'Issues are disabled for this repo' });
      if (body.labels?.some((l: string) => !repo.labels.includes(l))) repo.labels.push(...body.labels.filter((l: string) => !repo.labels.includes(l)));
      const issue = { number: this.nextIssueNumber++, title: body.title, body: body.body, labels: body.labels ?? [], created_at: new Date().toISOString(), user: 'ticket-relay[bot]' };
      repo.issues.push(issue);
      if (behavior === 'timeout_after_create') return hang(init.signal);
      if (behavior === 'reset_after_create') throw netError('ECONNRESET');
      return json(201, { number: issue.number, html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}` });
    }
    if (path === '/search/issues' && (url.searchParams.get('q') ?? '').includes('is:pr')) {
      const q = url.searchParams.get('q') ?? '';
      const [owner, name] = (/repo:(\S+)/.exec(q)?.[1] ?? '/').split('/');
      const author = /author:(\S+)/.exec(q)?.[1] ?? '';
      const r = this.repoByName(owner!, name!);
      const n = r && accessible(r) ? (this.mergedPrs.get(r.id)?.get(author) ?? 0) : 0;
      return json(200, { total_count: n, items: [] });
    }
    if (path === '/search/issues') {
      const q = url.searchParams.get('q') ?? '';
      const marker = /"([^"]+)"/.exec(q)?.[1];
      if (marker) {
        const items = this.allIssues().filter((i) => i.body.includes(marker)).map((i) => ({ number: i.number, body: i.body, html_url: `https://github.com/${i.repo}/issues/${i.number}` }));
        return json(200, { total_count: items.length, items });
      }
      // Keyword search within one repository (triage duplicate candidates).
      this.searchCalls++;
      const [owner, name] = (/repo:(\S+)/.exec(q)?.[1] ?? '/').split('/');
      const r = this.repoByName(owner!, name!);
      const words = q.replace(/\S+:\S+/g, '').toLowerCase().split(/\s+/).filter(Boolean);
      const items = r && accessible(r) ? r.issues.filter((i) => words.some((w) => i.title.toLowerCase().includes(w))).map((i) => this.issueJson(r, i)) : [];
      return json(200, { total_count: items.length, items });
    }
    return json(404, { message: `fake github: no route ${method} ${path}` });
  }
}

export interface FakeGuild {
  id: string;
  name: string;
  owner_id: string;
  roles: { id: string; name: string; permissions: string; position: number }[];
  channels: { id: string; type: number; name: string; position: number; parent_id?: string | null; permission_overwrites?: any[] }[];
  botRoles: string[];
}

export class FakeDiscord {
  botId = '900000000000000001';
  guilds = new Map<string, FakeGuild>();
  botGuildIds = new Set<string>();
  messages = new Map<string, { channelId: string; payload: Json }>();
  interactionEdits: { token: string; payload: Json }[] = [];
  userGuilds: { id: string; name: string; icon: null; owner: boolean; permissions: string }[] = [];
  /** OAuth code → token response. */
  codes = new Map<string, Json>();
  nextMessageId = 5000;
  failNextCreate: { status: number; code: number } | null = null;
  roleChanges: { method: string; guildId: string; userId: string; roleId: string }[] = [];
  failRoleChange: { status: number; code: number } | null = null;
  /** Files on Discord's CDN, by path (e.g. /ephemeral-attachments/1/2/shot.png). */
  cdn = new Map<string, { status?: number; body: Buffer; type?: string }>();
  cdnRequests: string[] = [];

  /** Puts a file on the fake CDN and returns its URL. */
  addCdnFile(name: string, body: Buffer, type = 'image/png', status = 200): string {
    const p = `/ephemeral-attachments/${this.cdn.size + 1}/${this.cdn.size + 100}/${name}`;
    this.cdn.set(p, { body, type, status });
    return `https://cdn.discordapp.com${p}?ex=abc&is=def&hm=123`;
  }

  async handleCdn(url: URL): Promise<Response> {
    this.cdnRequests.push(url.pathname);
    const f = this.cdn.get(url.pathname);
    if (!f) return new Response('Not found', { status: 404 });
    return new Response(f.status && f.status >= 400 ? 'error' : new Uint8Array(f.body), { status: f.status ?? 200, headers: { 'content-type': f.type ?? 'application/octet-stream' } });
  }

  addGuild(id: string, name: string, channels: FakeGuild['channels'], opts: { botPermissions?: bigint } = {}) {
    const perms = (opts.botPermissions ?? (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 16n)).toString();
    this.guilds.set(id, {
      id,
      name,
      owner_id: '1',
      roles: [
        { id, name: '@everyone', permissions: '0', position: 0 },
        { id: `${id}9`, name: 'Ticket Relay', permissions: perms, position: 1 },
      ],
      channels,
      botRoles: [`${id}9`],
    });
    this.botGuildIds.add(id);
  }

  async handle(url: URL, init: RequestInit): Promise<Response> {
    const method = init.method ?? 'GET';
    const path = url.pathname.replace(/^\/api\/v10/, '').replace(/^\/api/, '');
    const auth = String((init.headers as Record<string, string>)?.Authorization ?? '');
    let m: RegExpExecArray | null;

    if (path === '/oauth2/token') {
      const form = new URLSearchParams(String(init.body));
      const token = this.codes.get(form.get('code') ?? '');
      return token ? json(200, token) : json(400, { error: 'invalid_grant' });
    }
    if ((m = /^\/webhooks\/(\d+)\/([^/]+)\/messages\/@original$/.exec(path)) && method === 'PATCH') {
      this.interactionEdits.push({ token: m[2]!, payload: JSON.parse(String(init.body)) });
      return json(200, { id: 'm' });
    }
    if (auth.startsWith('Bearer ')) {
      if (path === '/users/@me') return json(200, { id: '42', username: 'admin', global_name: 'Admin' });
      if (path.startsWith('/users/@me/guilds')) return json(200, this.userGuilds);
    }
    if (!auth.startsWith('Bot ')) return json(401, { message: '401: Unauthorized', code: 0 });

    if (path === '/users/@me') return json(200, { id: this.botId, username: 'Ticket Relay' });
    if (path.startsWith('/users/@me/guilds')) {
      return json(200, [...this.botGuildIds].map((id) => ({ id, name: this.guilds.get(id)?.name ?? id, icon: null })));
    }
    if ((m = /^\/guilds\/(\d+)(\/.*)?$/.exec(path))) {
      const g = this.guilds.get(m[1]!);
      if (!g || !this.botGuildIds.has(g.id)) return json(404, { message: 'Unknown Guild', code: 10004 });
      const rest = m[2] ?? '';
      if (rest === '') return json(200, { id: g.id, name: g.name, icon: null, owner_id: g.owner_id });
      if (rest === '/channels') return json(200, g.channels);
      if (rest === '/roles') return json(200, g.roles);
      if (rest === `/members/${this.botId}`) return json(200, { roles: g.botRoles });
      const roleMatch = /^\/members\/(\d+)\/roles\/(\d+)$/.exec(rest);
      if (roleMatch && (method === 'PUT' || method === 'DELETE')) {
        if (this.failRoleChange) return json(this.failRoleChange.status, { message: 'error', code: this.failRoleChange.code });
        this.roleChanges.push({ method, guildId: g.id, userId: roleMatch[1]!, roleId: roleMatch[2]! });
        return new Response(null, { status: 204 });
      }
    }
    if ((m = /^\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(path))) {
      const channelId = m[1]!;
      const messageId = m[2];
      const exists = [...this.guilds.values()].some((g) => g.channels.some((c) => c.id === channelId));
      if (!exists) return json(404, { message: 'Unknown Channel', code: 10003 });
      if (!messageId && method === 'POST') {
        if (this.failNextCreate) {
          const f = this.failNextCreate;
          this.failNextCreate = null;
          return json(f.status, { message: 'error', code: f.code });
        }
        const id = String(this.nextMessageId++);
        this.messages.set(id, { channelId, payload: JSON.parse(String(init.body)) });
        return json(200, { id });
      }
      const msg = messageId ? this.messages.get(messageId) : undefined;
      if (!msg || msg.channelId !== channelId) return json(404, { message: 'Unknown Message', code: 10008 });
      if (method === 'GET') return json(200, { id: messageId });
      if (method === 'PATCH') {
        msg.payload = JSON.parse(String(init.body));
        return json(200, { id: messageId });
      }
      if (method === 'DELETE') {
        this.messages.delete(messageId!);
        return new Response(null, { status: 204 });
      }
    }
    return json(404, { message: `fake discord: no route ${method} ${path}`, code: 0 });
  }
}

/** What the next Claude call returns: an answer, plain text, an HTTP error, a refusal or unreadable text. */
export type ClaudeBehavior = Json | { status: number; type: string; message?: string } | { text: string; stop?: 'end_turn' | 'max_tokens' } | 'refusal' | 'garbage';

/** A message as a server-sent event stream (messages.stream), the text in a few pieces. */
function sse(message: Json): Response {
  const events: [string, Json][] = [['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: message.usage.input_tokens, output_tokens: 1 } } }]];
  (message.content as { text: string }[]).forEach((block, index) => {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
    for (const piece of block.text.match(/[\s\S]{1,40}/g) ?? []) events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } }]);
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } });
}

/** In-memory Claude API: GET /v1/models and POST /v1/messages (structured output). */
export class FakeAnthropic {
  validKeys = new Set(['sk-ant-test-key-0123456789abcdef', 'sk-ant-other-key-0123456789abcdef']);
  verdict: Json = {
    reason: 'A genuine bug report.', summary: 'A bug report.',
    spam: false, spam_confidence: 5, no_action: false, no_action_confidence: 5, not_dev_issue: false, not_dev_issue_confidence: 5,
    duplicates: [], regression_of: null, regression_confidence: 0, in_progress: null, in_progress_confidence: 0, fixed_by: null, fixed_confidence: 0,
    needs_info: false, needs_info_confidence: 10, missing: [],
    parts: [], parts_confidence: 0, related: [], related_confidence: 0, shared: false, shared_confidence: 0, shared_apps: [], shared_issue: null,
    right_app: null, right_app_confidence: 0, version: null, labels: {}, priority: 'medium', priority_confidence: 80, missing_context: null,
  };
  /** The default answer to a request to write an app's TRIAGE.md (plain text). */
  knowledge: ClaudeBehavior = { text: '## What it is\n- A test app.' };
  queue: ClaudeBehavior[] = [];
  requests: { key: string; body: Json }[] = [];
  models = [
    { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', lifecycle: 'active' },
    { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', lifecycle: 'active' },
    { id: 'claude-old-1', display_name: 'Claude Old', lifecycle: 'retired' },
  ];

  private error(status: number, type: string, message: string): Response {
    return json(status, { type: 'error', error: { type, message } }, { 'request-id': 'req_test' });
  }

  async handle(url: URL, init: RequestInit): Promise<Response> {
    const key = new Headers(init.headers as HeadersInit).get('x-api-key') ?? '';
    if (!this.validKeys.has(key)) return this.error(401, 'authentication_error', 'invalid x-api-key');
    if (url.pathname === '/v1/models' && (init.method ?? 'GET') === 'GET') {
      const data = this.models.map((m) => ({ type: 'model', created_at: '2026-01-01T00:00:00Z', deprecated_at: null, capabilities: { structured_outputs: { supported: true } }, ...m }));
      return json(200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
    }
    if (url.pathname === '/v1/messages' && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      this.requests.push({ key, body });
      const writing = /^You (write|keep) TRIAGE\.md/.test(String(body.system?.[0]?.text ?? ''));
      const behavior = this.queue.shift() ?? (writing ? this.knowledge : this.verdict);
      if (typeof behavior === 'object' && 'status' in behavior && typeof behavior.status === 'number') {
        return this.error(behavior.status, String(behavior.type), String(behavior.message ?? 'error'));
      }
      const plain = typeof behavior === 'object' && behavior !== null && typeof (behavior as { text?: unknown }).text === 'string' ? (behavior as { text: string; stop?: string }) : null;
      const text = plain ? plain.text : behavior === 'garbage' ? 'not json at all' : behavior === 'refusal' ? '' : JSON.stringify(behavior);
      const message = {
        id: 'msg_test', type: 'message', role: 'assistant', model: body.model,
        content: behavior === 'refusal' ? [] : [{ type: 'text', text }],
        stop_reason: behavior === 'refusal' ? 'refusal' : plain?.stop ?? 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 90 },
      };
      return body.stream ? sse(message) : json(200, message, { 'request-id': 'req_test' });
    }
    return this.error(404, 'not_found_error', `fake anthropic: no route ${init.method} ${url.pathname}`);
  }
}

export function fakeFetch(github: FakeGitHub, discord: FakeDiscord, anthropic: FakeAnthropic = new FakeAnthropic()) {
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    if (url.hostname === 'api.github.com' || url.hostname === 'github.com') return github.handle(url, init);
    if (url.hostname === 'discord.com') return discord.handle(url, init);
    if (url.hostname === 'cdn.discordapp.com' || url.hostname === 'media.discordapp.net') return discord.handleCdn(url);
    if (url.hostname === 'api.anthropic.com') return anthropic.handle(url, init);
    throw netError('ENOTFOUND');
  };
}
