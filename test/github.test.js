import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubError, toAppError } from '../src/errors.js';
import { formatApiErrors, GitHubClient } from '../src/github.js';

/** Replace globalThis.fetch for the duration of a test. */
function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
}

test('listBranches calls an absolute GitHub URL (regression: relative path broke fetch)', async () => {
  await withFetch(
    () => jsonResponse([{ name: 'main', protected: false, commit: { sha: 'abc123' } }]),
    async (calls) => {
      const client = new GitHubClient('ghp_testtoken');
      const branches = await client.listBranches('acme', 'widgets');

      assert.deepEqual(branches, [{ name: 'main', protected: false, sha: 'abc123' }]);
      assert.equal(calls.length, 1);
      assert.ok(
        calls[0].url.startsWith('https://api.github.com/repos/acme/widgets/branches?per_page=100'),
        `expected an absolute URL, got ${calls[0].url}`,
      );
    },
  );
});

test('paginate follows the Link rel="next" header', async () => {
  let page = 0;
  await withFetch(
    (url) => {
      page += 1;
      const headers = page === 1 ? { link: '<https://api.github.com/repos/acme/widgets/branches?per_page=100&page=2>; rel="next"' } : {};
      return jsonResponse([{ name: `b${page}`, protected: false, commit: { sha: 'x' } }], { headers });
    },
    async (calls) => {
      const client = new GitHubClient('ghp_testtoken');
      const branches = await client.paginate('/repos/acme/widgets/branches');
      assert.deepEqual(branches.map((b) => b.name), ['b1', 'b2']);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url, 'https://api.github.com/repos/acme/widgets/branches?per_page=100&page=2');
    },
  );
});

test('paginate stops after maxPages', async () => {
  await withFetch(
    () =>
      jsonResponse([{ name: 'b', protected: false }], {
        headers: { link: '<https://api.github.com/next>; rel="next"' },
      }),
    async (calls) => {
      const client = new GitHubClient('ghp_testtoken');
      await client.paginate('/repos/acme/widgets/branches', { maxPages: 2 });
      assert.equal(calls.length, 2);
    },
  );
});

test('listRepos only keeps repositories you can push to', async () => {
  await withFetch(
    () =>
      jsonResponse([
        { full_name: 'acme/widgets', owner: { login: 'acme' }, name: 'widgets', private: false, default_branch: 'main', updated_at: '2026-01-01T00:00:00Z', description: 'x', permissions: { push: true } },
        { full_name: 'acme/readonly', owner: { login: 'acme' }, name: 'readonly', private: true, default_branch: 'main', updated_at: '2026-01-02T00:00:00Z', description: '', permissions: { push: false } },
      ]),
    async (calls) => {
      const client = new GitHubClient('ghp_testtoken');
      const { repos, hasMore } = await client.listRepos();
      assert.deepEqual(repos.map((r) => r.fullName), ['acme/widgets']);
      assert.equal(hasMore, false);
      assert.ok(calls[0].url.startsWith('https://api.github.com/user/repos?'));
    },
  );
});

test('a network failure is reported as 502 with the underlying reason', () => {
  const err = new GitHubError(0, 'Could not reach GitHub: Failed to parse URL from /repos/acme/widgets/branches', {
    code: 'network_error',
  });
  const app = toAppError(err);
  assert.equal(app.status, 502);
  assert.equal(app.code, 'github_unavailable');
  assert.match(app.message, /Failed to parse URL/);
});

test('known GitHub statuses keep their friendly wording', () => {
  assert.equal(toAppError(new GitHubError(404, 'Not Found')).status, 404);
  assert.equal(toAppError(new GitHubError(401, 'Bad credentials')).status, 401);
  assert.equal(toAppError(new GitHubError(403, 'Forbidden')).status, 403);
  assert.equal(toAppError(new GitHubError(422, "Validation Failed")).status, 400);
});

test('a 403 that is a primary rate limit is reported as 429', async () => {
  await withFetch(
    () =>
      new Response(JSON.stringify({ message: 'API rate limit exceeded for user ID 1.' }), {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120),
        },
      }),
    async () => {
      const client = new GitHubClient('ghp_testtoken');
      let thrown = null;
      try {
        await client.whoami();
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown, 'expected the call to fail');
      assert.equal(thrown.code, 'rate_limited');
      assert.ok(thrown.resetAt > Date.now());

      const app = toAppError(thrown);
      assert.equal(app.status, 429);
      assert.equal(app.code, 'github_rate_limited');
      assert.ok(app.retryAfter >= 1, 'expected a Retry-After value');
    },
  );
});

test('a 403 secondary rate limit is detected even without x-ratelimit-remaining', async () => {
  await withFetch(
    () =>
      new Response(
        JSON.stringify({
          message: 'You have exceeded a secondary rate limit and have been temporarily blocked from content creation.',
        }),
        { status: 403, headers: { 'content-type': 'application/json', 'retry-after': '60' } },
      ),
    async () => {
      const client = new GitHubClient('ghp_testtoken');
      let thrown = null;
      try {
        await client.listBranches('acme', 'widgets');
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown);
      assert.equal(thrown.code, 'rate_limited');
      assert.equal(thrown.retryAfterSeconds, 60);
      assert.equal(toAppError(thrown).status, 429);
    },
  );
});

test('a plain 403 stays a 403 with the friendly wording', async () => {
  await withFetch(
    () =>
      new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    async () => {
      const client = new GitHubClient('ghp_testtoken');
      let thrown = null;
      try {
        await client.getRepo('acme', 'widgets');
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown);
      assert.equal(thrown.code, 'github_error');
      const app = toAppError(thrown);
      assert.equal(app.status, 403);
      assert.match(app.message, /Contents.+Pull requests|permissions/);
    },
  );
});

test('formatApiErrors turns GitHub error arrays into readable sentences', () => {
  assert.deepEqual(formatApiErrors(undefined), []);
  assert.deepEqual(
    formatApiErrors([{ resource: 'PullRequest', code: 'custom', message: 'No commits between main and feat' }]),
    ['No commits between main and feat'],
  );
  assert.deepEqual(formatApiErrors([{ resource: 'PullRequest', field: 'base', code: 'invalid' }]), [
    'PullRequest "base" is invalid (invalid)',
  ]);
  assert.deepEqual(formatApiErrors([{ message: 'a' }, { message: 'a' }, { message: 'b' }]), ['a', 'b']);
});

test('a 422 keeps its field errors instead of a bare "Validation Failed"', async () => {
  await withFetch(
    () =>
      new Response(
        JSON.stringify({
          message: 'Validation Failed',
          errors: [
            { resource: 'PullRequest', code: 'custom', message: 'No commits between acme:main and acme:feat' },
          ],
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    async () => {
      const client = new GitHubClient('ghp_testtoken');
      let thrown = null;
      try {
        await client.createPullRequest('acme', 'widgets', { title: 't', body: '', head: 'feat', base: 'main' });
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof GitHubError);
      assert.equal(thrown.status, 422);
      assert.match(thrown.message, /^Validation Failed: No commits between acme:main and acme:feat$/);
      const app = toAppError(thrown);
      assert.equal(app.status, 400);
      assert.match(app.message, /No commits between acme:main and acme:feat/);
    },
  );
});

test('findPullRequest can look for closed pull requests too', async () => {
  await withFetch(
    () => jsonResponse([{ number: 12, state: 'closed', title: 'old', html_url: 'https://x/12' }]),
    async (calls) => {
      const client = new GitHubClient('ghp_testtoken');
      const found = await client.findPullRequest('acme', 'widgets', 'feat', 'main', { state: 'all' });
      assert.equal(found.number, 12);
      assert.match(calls[0].url, /state=all/);
    },
  );
});
