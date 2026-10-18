import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubError, toAppError } from '../src/errors.js';
import { GitHubClient } from '../src/github.js';

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
