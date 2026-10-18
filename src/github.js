import { config } from './config.js';
import { GitHubError } from './errors.js';
import { logger } from './logger.js';

const RETRY_STATUSES = new Set([500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Relative API paths are resolved against the configured GitHub API base. */
function absoluteUrl(path) {
  return String(path).startsWith('http') ? path : `${config.githubApiBase}${path}`;
}

function decodeBase64Utf8(b64) {
  const buf = Buffer.from(b64 || '', 'base64');
  // Reject anything that is not valid UTF-8 (binary files we cannot diff or edit safely).
  const text = buf.toString('utf8');
  const roundTrip = Buffer.from(text, 'utf8').equals(buf);
  return { text, buf, isBinary: !roundTrip || buf.includes(0) };
}

export function decodeBlobContent(payload) {
  const { text, buf, isBinary } = decodeBase64Utf8(payload);
  return { content: text, size: buf.length, isBinary };
}

/** Small helper: run tasks with bounded concurrency. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export class GitHubClient {
  constructor(token) {
    this.token = token;
  }

  async request(method, path, { body, headers = {}, raw = false, timeout = config.githubTimeoutMs } = {}) {
    const url = path.startsWith('http') ? path : `${config.githubApiBase}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${this.token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'github-text-updater',
            ...headers,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        if (res.status === 204) {
          clearTimeout(timer);
          return null;
        }

        const text = await res.text();
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
        }

        if (!res.ok) {
          if (RETRY_STATUSES.has(res.status) && attempt < 3) {
            await sleep(400 * attempt);
            continue;
          }
          const remaining = res.headers.get('x-ratelimit-remaining');
          const reset = res.headers.get('x-ratelimit-reset');
          const isRateLimit =
            res.status === 403 && remaining === '0' && (data?.message || '').toLowerCase().includes('rate limit');
          const message =
            data?.message ||
            (isRateLimit ? 'GitHub API rate limit exceeded' : `GitHub returned HTTP ${res.status}`);
          clearTimeout(timer);
          throw new GitHubError(res.status, message, {
            code: isRateLimit ? 'rate_limited' : 'github_error',
            body: data,
            docsUrl: data?.documentation_url,
            resetAt: reset ? Number(reset) * 1000 : undefined,
          });
        }

        clearTimeout(timer);
        if (raw) return text;
        return data ?? text;
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof GitHubError) throw err;
        if (attempt < 3 && (err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND')) {
          logger.warn('github retry', { method, path, attempt, error: err.message });
          await sleep(400 * attempt);
          continue;
        }
        throw new GitHubError(0, `Could not reach GitHub: ${err.message}`, { code: 'network_error' });
      }
    }
  }

  /** Follow `Link: <...>; rel="next"` up to maxPages. */
  async paginate(path, { perPage = 100, maxPages = 5 } = {}) {
    const out = [];
    const separator = path.includes('?') ? '&' : '?';
    let url = `${absoluteUrl(path)}${separator}per_page=${perPage}`;
    for (let page = 0; page < maxPages; page += 1) {
      const { items, nextUrl } = await this.requestPage(url);
      out.push(...items);
      if (!nextUrl) break;
      url = nextUrl;
    }
    return out;
  }

  async requestPage(url) {
    const res = await fetch(absoluteUrl(url), {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-text-updater',
      },
    });
    if (!res.ok) {
      const message = `GitHub returned HTTP ${res.status}`;
      throw new GitHubError(res.status, message, { code: 'github_error' });
    }
    const items = await res.json();
    const link = res.headers.get('link') || '';
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    return { items: Array.isArray(items) ? items : [], nextUrl: next ? next[1] : null };
  }

  // ---------------------------------------------------------------- identity

  async whoami() {
    const me = await this.request('GET', '/user');
    return {
      login: me.login,
      name: me.name || me.login,
      avatarUrl: me.avatar_url,
      htmlUrl: me.html_url,
    };
  }

  // -------------------------------------------------------------- repositories

  async listRepos({ page = 1, perPage = 100, query = '' } = {}) {
    const base = '/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc';
    const { items, nextUrl } = await this.requestPage(
      `${config.githubApiBase}${base}&per_page=${perPage}&page=${page}`,
    );
    let repos = items
      .filter((r) => r.permissions?.push || r.permissions?.admin)
      .map((r) => ({
        fullName: r.full_name,
        owner: r.owner.login,
        name: r.name,
        private: r.private,
        defaultBranch: r.default_branch,
        updatedAt: r.updated_at,
        description: r.description || '',
        canPush: true,
      }));
    if (query) {
      const q = query.toLowerCase();
      repos = repos.filter((r) => r.fullName.toLowerCase().includes(q));
    }
    return {
      repos,
      hasMore: Boolean(nextUrl),
      page,
    };
  }

  async getRepo(owner, name) {
    const r = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
    return {
      fullName: r.full_name,
      owner: r.owner.login,
      name: r.name,
      private: r.private,
      defaultBranch: r.default_branch,
      canPush: Boolean(r.permissions?.push || r.permissions?.admin),
      archived: Boolean(r.archived),
      htmlUrl: r.html_url,
    };
  }

  async listBranches(owner, name) {
    const branches = await this.paginate(`/repos/${owner}/${name}/branches`, { perPage: 100, maxPages: 3 });
    return branches.map((b) => ({ name: b.name, protected: Boolean(b.protected), sha: b.commit?.sha }));
  }

  // ----------------------------------------------------------------- git data

  async getRef(owner, name, ref) {
    return this.request('GET', `/repos/${owner}/${name}/git/ref/${ref}`);
  }

  async getCommit(owner, name, sha) {
    return this.request('GET', `/repos/${owner}/${name}/git/commits/${sha}`);
  }

  /** Recursive tree of a ref. Returns a Map path -> { sha, mode, type, size }. */
  async getTreeMap(owner, name, ref) {
    const tree = await this.request(
      'GET',
      `/repos/${owner}/${name}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    );
    const map = new Map();
    for (const entry of tree.tree || []) {
      if (entry.type === 'blob') map.set(entry.path, entry);
    }
    return { map, truncated: Boolean(tree.truncated), sha: tree.sha };
  }

  async getBlob(owner, name, sha) {
    const blob = await this.request('GET', `/repos/${owner}/${name}/git/blobs/${sha}`);
    return decodeBlobContent(blob.content);
  }

  async createBlob(owner, name, content) {
    const blob = await this.request('POST', `/repos/${owner}/${name}/git/blobs`, {
      body: { content, encoding: 'utf-8' },
    });
    return blob.sha;
  }

  async createRef(owner, name, ref, sha) {
    return this.request('POST', `/repos/${owner}/${name}/git/refs`, { body: { ref, sha } });
  }

  async updateRef(owner, name, ref, sha, force = false) {
    return this.request('PATCH', `/repos/${owner}/${name}/git/refs/${ref}`, { body: { sha, force } });
  }

  async createTree(owner, name, { baseTree, entries }) {
    return this.request('POST', `/repos/${owner}/${name}/git/trees`, {
      body: { base_tree: baseTree, tree: entries },
    });
  }

  async createCommit(owner, name, { message, tree, parents }) {
    return this.request('POST', `/repos/${owner}/${name}/git/commits`, {
      body: { message, tree, parents },
    });
  }

  async deleteRef(owner, name, ref) {
    try {
      await this.request('DELETE', `/repos/${owner}/${name}/git/refs/${ref}`);
      return true;
    } catch (err) {
      if (err.status === 404 || err.status === 422) return false;
      throw err;
    }
  }

  // -------------------------------------------------------------- pull requests

  async createPullRequest(owner, name, { title, body, head, base, draft = false }) {
    return this.request('POST', `/repos/${owner}/${name}/pulls`, {
      body: { title, body, head, base, draft },
    });
  }

  async findOpenPullRequest(owner, name, head, base) {
    const pulls = await this.request(
      'GET',
      `/repos/${owner}/${name}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(
        base,
      )}&state=open&per_page=5`,
    );
    return Array.isArray(pulls) && pulls.length ? pulls[0] : null;
  }

  async getPullRequest(owner, name, number) {
    return this.request('GET', `/repos/${owner}/${name}/pulls/${number}`);
  }

  async mergePullRequest(owner, name, number, { mergeMethod = 'merge', commitTitle, commitMessage } = {}) {
    return this.request('PUT', `/repos/${owner}/${name}/pulls/${number}/merge`, {
      body: { merge_method: mergeMethod, commit_title: commitTitle, commit_message: commitMessage },
    });
  }

  async getCombinedStatus(owner, name, ref) {
    try {
      const status = await this.request('GET', `/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}/status`);
      return {
        state: status.state,
        total: status.total_count,
        contexts: (status.statuses || []).map((s) => ({
          context: s.context,
          state: s.state,
          description: s.description,
          targetUrl: s.target_url,
        })),
      };
    } catch (err) {
      if (err.status === 404) return { state: 'unknown', total: 0, contexts: [] };
      throw err;
    }
  }

  async getCheckRuns(owner, name, ref) {
    try {
      const data = await this.request(
        'GET',
        `/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}/check-runs?per_page=30`,
      );
      const runs = data.check_runs || [];
      const buckets = runs.reduce((acc, run) => {
        acc[run.status === 'completed' ? run.conclusion || 'neutral' : run.status] =
          (acc[run.status === 'completed' ? run.conclusion || 'neutral' : run.status] || 0) + 1;
        return acc;
      }, {});
      return { total: data.total_count ?? runs.length, buckets, state: data.check_runs ? 'ok' : 'unknown' };
    } catch {
      return { total: 0, buckets: {}, state: 'unknown' };
    }
  }
}
