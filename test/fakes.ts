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
  issues: { number: number; title: string; body: string; labels: string[]; created_at: string; user: string }[];
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
  /** Simulates a wrong/rotated private key: every app-JWT call is rejected. */
  rejectAppJwt = false;
  /** GitHub account returned for the user access token from code `good-code`. */
  oauthUser = { id: 4242, login: 'octo-dev' };
  /** repoId → login → number of merged PRs / authored commits. */
  mergedPrs = new Map<number, Map<string, number>>();
  commits = new Map<number, Map<string, number>>();
  installationPermissions: Record<string, string> = { issues: 'write', metadata: 'read', pull_requests: 'read', contents: 'read' };
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
    const method = init.method ?? 'GET';
    const path = url.pathname;
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
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/commits$/.exec(path))) {
      const r = this.repoByName(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      if (!accessible(r)) return json(404, { message: 'Not Found' });
      const author = url.searchParams.get('author') ?? '';
      const n = this.commits.get(r!.id)?.get(author) ?? 0;
      const link: Record<string, string> = n > 1 ? { link: `<https://api.github.com${path}?author=${author}&per_page=1&page=2>; rel="next", <https://api.github.com${path}?author=${author}&per_page=1&page=${n}>; rel="last"` } : {};
      return json(200, n ? [{ sha: 'abc' }] : [], link);
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path))) {
      const r = this.repoByName(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      const issue = r?.issues.find((i) => i.number === Number(m![3]));
      return accessible(r) && issue ? json(200, { number: issue.number, html_url: `https://github.com/${r!.owner}/${r!.name}/issues/${issue.number}` }) : json(404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(path))) {
      const r = this.repoByName(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
      if (!accessible(r)) return json(404, { message: 'Not Found' });
      const repo = r!;
      if (method === 'GET') {
        const items = [...repo.issues].reverse().map((i) => ({ number: i.number, body: i.body, html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${i.number}` }));
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
      const marker = /"([^"]+)"/.exec(q)?.[1] ?? '';
      const items = this.allIssues().filter((i) => i.body.includes(marker)).map((i) => ({ number: i.number, body: i.body, html_url: `https://github.com/${i.repo}/issues/${i.number}` }));
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

export function fakeFetch(github: FakeGitHub, discord: FakeDiscord) {
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    if (url.hostname === 'api.github.com' || url.hostname === 'github.com') return github.handle(url, init);
    if (url.hostname === 'discord.com') return discord.handle(url, init);
    throw netError('ENOTFOUND');
  };
}
