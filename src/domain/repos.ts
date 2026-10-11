import type { RepoInfo } from '../github/client.js';
import type { Deps } from './types.js';

const cache = new Map<number, { repos: RepoInfo[]; at: number }>();
const TTL_MS = 60_000;

/** Repositories the workspace's GitHub App installation can access (briefly cached). */
export async function getInstallationRepos(deps: Pick<Deps, 'github'>, installationId: number, opts: { fresh?: boolean } = {}): Promise<RepoInfo[]> {
  if (!deps.github) throw new Error('GitHub is not configured');
  const hit = cache.get(installationId);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.repos;
  const repos = await deps.github.listInstallationRepos(installationId);
  cache.set(installationId, { repos, at: Date.now() });
  return repos;
}

export function clearRepoCache(installationId?: number): void {
  if (installationId === undefined) cache.clear();
  else cache.delete(installationId);
}
