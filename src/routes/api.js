import express from 'express';
import { config } from '../config.js';
import { AppError, toAppError } from '../errors.js';
import { GitHubClient, mapLimit } from '../github.js';
import { logger } from '../logger.js';
import { inferLanguage, normalizeRepoPath, parseSpec } from '../parser.js';
import { buildPlan, selectPaths } from '../planner.js';
import { clearSession, readSession, writeSession } from '../session.js';

const router = express.Router();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ utilities

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch((err) => next(toAppError(err)));
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    next(AppError.unauthorized('not_connected', 'Connect a GitHub personal access token first.'));
    return;
  }
  req.session = session;
  req.gh = new GitHubClient(session.token);
  req.user = session.user;
  next();
}

function asString(value, { name, max = 1000, required = true, trim = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw AppError.badRequest('missing_field', `"${name}" is required.`);
    return '';
  }
  if (typeof value !== 'string') throw AppError.badRequest('invalid_field', `"${name}" must be a string.`);
  const out = trim ? value.trim() : value;
  if (required && out === '') throw AppError.badRequest('missing_field', `"${name}" is required.`);
  if (out.length > max) throw AppError.badRequest('invalid_field', `"${name}" is too long (max ${max} characters).`);
  return out;
}

function asEnum(value, allowed, { name, fallback }) {
  const v = String(value ?? '').trim();
  if (!v) return fallback;
  if (!allowed.includes(v)) {
    throw AppError.badRequest('invalid_field', `"${name}" must be one of: ${allowed.join(', ')}.`);
  }
  return v;
}

/** Encode a git ref path so branch names with slashes/unicode stay valid. */
export function refPath(ref) {
  return String(ref)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

function parseRepoFullName(value) {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(value || '').trim());
  if (!m) throw AppError.badRequest('invalid_repo', 'Repository must look like "owner/name".');
  return { owner: m[1], name: m[2] };
}

function validateBranchName(branch) {
  const b = String(branch || '').trim();
  if (!b) throw AppError.badRequest('invalid_branch', 'Branch name is required.');
  if (b.length > 244) throw AppError.badRequest('invalid_branch', 'Branch name is too long.');
  if (!/^[A-Za-z0-9._/-]+$/.test(b)) {
    throw AppError.badRequest('invalid_branch', 'Branch name may only contain letters, digits, ".", "_", "-" and "/".');
  }
  if (b.startsWith('/') || b.endsWith('/') || b.includes('..') || b.endsWith('.lock')) {
    throw AppError.badRequest('invalid_branch', 'Branch name is not valid for git.');
  }
  return b;
}

// -------------------------------------------------------------------- session

router.get(
  '/session',
  wrap((req, res) => {
    const session = readSession(req);
    if (!session) return res.json({ connected: false });
    return res.json({ connected: true, user: session.user });
  }),
);

router.post(
  '/session',
  wrap(async (req, res) => {
    const token = asString(req.body?.token, { name: 'token', max: 512 });
    if (/\s/.test(token)) {
      throw AppError.badRequest('invalid_token', 'The token must not contain spaces.');
    }
    const client = new GitHubClient(token);
    let user;
    try {
      user = await client.whoami();
    } catch (err) {
      if (err.status === 401) {
        throw AppError.unauthorized(
          'invalid_token',
          'GitHub rejected this token: it is invalid, expired or revoked. Classic tokens start with "ghp_", fine-grained tokens with "github_pat_".',
        );
      }
      throw err;
    }
    writeSession(res, req, { token, user, createdAt: Date.now() });
    logger.info('session created', { user: user.login });
    return res.json({ connected: true, user });
  }),
);

router.delete(
  '/session',
  wrap((req, res) => {
    clearSession(res);
    return res.json({ connected: false });
  }),
);

/** Remaining GitHub quota for the connected token (helps diagnose 403/429). */
router.get(
  '/rate-limit',
  requireAuth,
  wrap(async (req, res) => {
    const limits = await req.gh.rateLimit();
    return res.json({ limits, checkedAt: new Date().toISOString() });
  }),
);

// ----------------------------------------------------------------- repositories

router.get(
  '/repos',
  requireAuth,
  wrap(async (req, res) => {
    const query = asString(req.query.query, { name: 'query', max: 200, required: false });
    const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 20);
    const result = await req.gh.listRepos({ page, query });
    return res.json(result);
  }),
);

router.get(
  '/repos/:owner/:repo',
  requireAuth,
  wrap(async (req, res) => {
    const { owner, repo } = req.params;
    const info = await req.gh.getRepo(owner, repo);
    if (!info.canPush) {
      throw AppError.forbidden(
        'no_push_access',
        `You do not have write access to ${info.fullName}. Ask a maintainer or use a token with write permission.`,
      );
    }
    if (info.archived) {
      throw AppError.conflict('repo_archived', `${info.fullName} is archived and cannot be written to.`);
    }
    const branches = await req.gh.listBranches(owner, repo);
    return res.json({ repo: info, branches });
  }),
);

router.get(
  '/repos/:owner/:repo/tree',
  requireAuth,
  wrap(async (req, res) => {
    const { owner, repo } = req.params;
    const ref = asString(req.query.ref, { name: 'ref', max: 255 });
    const query = asString(req.query.query, { name: 'query', max: 200, required: false }).toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 400, 1), 2000);

    const { map, truncated } = await req.gh.getTreeMap(owner, repo, ref);
    let paths = [...map.keys()];
    const total = paths.length;
    if (query) paths = paths.filter((p) => p.toLowerCase().includes(query));
    paths.sort((a, b) => a.localeCompare(b));
    return res.json({
      ref,
      files: paths.slice(0, limit).map((path) => ({ path, lang: inferLanguage(path) || 'text' })),
      total,
      returned: Math.min(paths.length, limit),
      truncatedTree: truncated,
    });
  }),
);

/** Fetch a single existing file so the UI can pre-fill an edition block. */
router.get(
  '/repos/:owner/:repo/file',
  requireAuth,
  wrap(async (req, res) => {
    const { owner, repo } = req.params;
    const ref = asString(req.query.ref, { name: 'ref', max: 255 });
    const requested = asString(req.query.path, { name: 'path', max: 512 });
    const normalized = normalizeRepoPath(requested);
    if (!normalized.ok) {
      throw AppError.badRequest('invalid_path', `Invalid file path (${normalized.error}).`);
    }
    const { map } = await req.gh.getTreeMap(owner, repo, ref);
    const entry = map.get(normalized.path);
    if (!entry) {
      throw AppError.notFound('file_not_found', `"${normalized.path}" does not exist on ${ref}.`);
    }
    const blob = await req.gh.getBlob(owner, repo, entry.sha);
    if (blob.isBinary) {
      throw AppError.badRequest('binary_file', `"${normalized.path}" is a binary file and cannot be edited here.`);
    }
    if (blob.size > config.limits.fileBytes) {
      throw AppError.badRequest(
        'file_too_large',
        `"${normalized.path}" is ${(blob.size / 1024).toFixed(0)} KiB, above the ${(
          config.limits.fileBytes / 1024
        ).toFixed(0)} KiB editing limit.`,
      );
    }
    return res.json({
      ref,
      path: normalized.path,
      sha: entry.sha,
      mode: entry.mode || '100644',
      size: blob.size,
      lang: inferLanguage(normalized.path) || 'text',
      content: blob.content,
    });
  }),
);

// ------------------------------------------------------------------------ plan

/**
 * The plan is computed against the state the commit will actually modify:
 * the working branch when it already exists, otherwise the base branch.
 */
async function resolvePlanningRef(client, { owner, repo, base, branch }) {
  if (branch && branch !== base) {
    try {
      await client.getRef(owner, repo, refPath(`heads/${branch}`));
      return branch;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  return base;
}

router.post(
  '/plan',
  requireAuth,
  wrap(async (req, res) => {
    const { owner, name: repo } = parseRepoFullName(req.body?.repo);
    const ref = validateBranchName(asString(req.body?.ref, { name: 'ref', max: 255 }));
    const branch = req.body?.branch ? validateBranchName(asString(req.body?.branch, { name: 'branch', max: 255 })) : null;
    const text = asString(req.body?.text, { name: 'text', max: config.limits.specBytes, trim: false });

    const parsed = parseSpec(text);
    if (parsed.files.length > config.limits.files) {
      parsed.errors.push({
        line: 0,
        code: 'too_many_files',
        message: `The block declares ${parsed.files.length} files, the limit is ${config.limits.files}.`,
      });
    }

    const planRef = await resolvePlanningRef(req.gh, { owner, repo, base: ref, branch });
    const plan = await buildPlan(req.gh, { owner, repo, ref: planRef, files: parsed.files });
    return res.json({
      repo: `${owner}/${repo}`,
      ref,
      planRef,
      meta: parsed.meta,
      errors: parsed.errors,
      warnings: parsed.warnings,
      items: plan.items,
      summary: plan.summary,
    });
  }),
);

// ----------------------------------------------------------------------- apply

async function resolveHead(client, { owner, repo, base, branch }) {
  const baseRef = await client.getRef(owner, repo, refPath(`heads/${base}`));
  const baseSha = baseRef.object.sha;
  let branchSha = null;
  try {
    const branchRef = await client.getRef(owner, repo, refPath(`heads/${branch}`));
    branchSha = branchRef.object.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  const parentSha = branchSha || baseSha;
  const parentCommit = await client.getCommit(owner, repo, parentSha);
  return { baseSha, branchSha, parentSha, baseTree: parentCommit.tree.sha };
}

async function commitTree(client, { owner, repo, message, baseTree, parentSha, items }) {
  const entries = [];
  const big = items.filter((i) => i.resolved !== 'delete' && Buffer.byteLength(i.content) > config.limits.blobInlineBytes);

  if (big.length) {
    await mapLimit(big, 4, async (item) => {
      item.blobSha = await client.createBlob(owner, repo, item.content);
    });
  }

  for (const item of items) {
    if (item.resolved === 'delete') {
      entries.push({ path: item.path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    if (item.blobSha) {
      entries.push({ path: item.path, mode: item.mode || '100644', type: 'blob', sha: item.blobSha });
    } else {
      entries.push({
        path: item.path,
        mode: item.mode || '100644',
        type: 'blob',
        content: item.content,
      });
    }
  }

  const tree = await client.createTree(owner, repo, { baseTree, entries });
  const commit = await client.createCommit(owner, repo, {
    message,
    tree: tree.sha,
    parents: [parentSha],
  });
  return commit;
}

router.post(
  '/apply',
  requireAuth,
  wrap(async (req, res) => {
    const { owner, name: repo } = parseRepoFullName(req.body?.repo);
    const base = validateBranchName(asString(req.body?.base, { name: 'base', max: 255 }));
    const branch = validateBranchName(asString(req.body?.branch, { name: 'branch', max: 255 }));
    const text = asString(req.body?.text, { name: 'text', max: config.limits.specBytes, trim: false });
    const commitMessage = asString(req.body?.commitMessage, { name: 'commitMessage', max: 4000, trim: false });
    const paths = Array.isArray(req.body?.paths) ? req.body.paths : null;

    const parsed = parseSpec(text);
    if (parsed.errors.length) {
      throw AppError.badRequest('spec_invalid', 'The specification has errors, they must be fixed before committing.', {
        errors: parsed.errors,
      });
    }

    const { branchSha, parentSha, baseTree } = await resolveHead(req.gh, { owner, repo, base, branch });

    // Plan against the branch we are about to extend (it may already contain
    // previous commits from this tool) so append/prepend/patch stay cumulative.
    const planRef = branchSha ? branch : base;
    const plan = await buildPlan(req.gh, { owner, repo, ref: planRef, files: parsed.files, includeDiffs: false });
    const items = selectPaths(plan, paths);
    if (items.length === 0) {
      throw AppError.conflict('nothing_to_commit', 'Nothing to commit: every file is already up to date.');
    }
    const hardErrors = plan.items.filter((i) => i.error);
    if (hardErrors.length && (!paths || paths.length === 0)) {
      throw AppError.badRequest('plan_has_errors', 'Some files could not be applied, uncheck them or fix the block.', {
        errors: hardErrors.map((i) => ({ path: i.path, message: i.error })),
      });
    }

    const commit = await commitTree(req.gh, {
      owner,
      repo,
      message: commitMessage,
      baseTree,
      parentSha,
      items,
    });

    if (branchSha) await req.gh.updateRef(owner, repo, refPath(`heads/${branch}`), commit.sha);
    else await req.gh.createRef(owner, repo, `refs/heads/${branch}`, commit.sha);

    logger.info('commit created', {
      repo: `${owner}/${repo}`,
      branch,
      sha: commit.sha,
      files: items.length,
      user: req.user?.login,
    });

    return res.json({
      ok: true,
      repo: `${owner}/${repo}`,
      base,
      branch,
      branchExisted: Boolean(branchSha),
      commit: {
        sha: commit.sha,
        url: commit.html_url,
        message: commit.message,
      },
      files: items.map((i) => ({ path: i.path, action: i.resolved, additions: i.additions, deletions: i.deletions })),
      skipped: plan.items.filter((i) => i.resolved === 'skip').map((i) => i.path),
    });
  }),
);

// --------------------------------------------------------------- pull requests

router.post(
  '/pulls',
  requireAuth,
  wrap(async (req, res) => {
    const { owner, name: repo } = parseRepoFullName(req.body?.repo);
    const base = validateBranchName(asString(req.body?.base, { name: 'base', max: 255 }));
    const head = validateBranchName(asString(req.body?.head, { name: 'head', max: 255 }));
    const title = asString(req.body?.title, { name: 'title', max: 256 });
    const body = asString(req.body?.body, { name: 'body', max: 65536, required: false, trim: false });
    const draft = Boolean(req.body?.draft);

    if (head === base) {
      throw AppError.badRequest('same_branch', 'The head branch and the base branch must be different.');
    }

    let pr;
    try {
      pr = await req.gh.createPullRequest(owner, repo, { title, body, head, base, draft });
    } catch (err) {
      if (err.status === 422) {
        // A closed PR blocks the creation just as much as an open one, and
        // GitHub only answers "Validation Failed" — look for both.
        const existing = await req.gh.findPullRequest(owner, repo, head, base, { state: 'all' });
        if (existing) {
          const merged = Boolean(existing.merged_at || existing.merged);
          const closed = existing.state === 'closed';
          return res.json({
            alreadyExists: true,
            pullRequest: shapePullRequest(existing),
            message: merged
              ? `Pull request #${existing.number} already exists for "${head}" and is already merged.`
              : closed
                ? `Pull request #${existing.number} already exists for "${head}" but it is closed. Reopen it on GitHub, or delete that branch and commit to a new branch name.`
                : 'An open pull request already exists for this branch.',
          });
        }
      }
      throw err;
    }

    logger.info('pull request opened', { repo: `${owner}/${repo}`, number: pr.number, user: req.user?.login });
    return res.json({ alreadyExists: false, pullRequest: shapePullRequest(pr) });
  }),
);

function shapePullRequest(pr) {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: pr.state,
    draft: Boolean(pr.draft),
    merged: Boolean(pr.merged),
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state,
    head: pr.head?.ref,
    base: pr.base?.ref,
    headSha: pr.head?.sha,
    commits: pr.commits,
    changedFiles: pr.changed_files,
    additions: pr.additions,
    deletions: pr.deletions,
  };
}

router.get(
  '/pulls/:owner/:repo/:number',
  requireAuth,
  wrap(async (req, res) => {
    const { owner, repo } = req.params;
    const number = Number(req.params.number);
    if (!Number.isInteger(number) || number <= 0) {
      throw AppError.badRequest('invalid_number', 'Invalid pull request number.');
    }
    const pr = await req.gh.getPullRequest(owner, repo, number);
    const [status, checks] = await Promise.all([
      req.gh.getCombinedStatus(owner, repo, pr.head.sha),
      req.gh.getCheckRuns(owner, repo, pr.head.sha),
    ]);
    return res.json({
      pullRequest: shapePullRequest(pr),
      status,
      checks,
      canMerge: Boolean(pr.mergeable) && pr.mergeable_state === 'clean',
    });
  }),
);

router.post(
  '/pulls/:owner/:repo/:number/merge',
  requireAuth,
  wrap(async (req, res) => {
    const { owner, repo } = req.params;
    const number = Number(req.params.number);
    const mergeMethod = asEnum(req.body?.mergeMethod, ['merge', 'squash', 'rebase'], {
      name: 'mergeMethod',
      fallback: 'merge',
    });
    const deleteBranch = Boolean(req.body?.deleteBranch);
    const commitTitle = asString(req.body?.commitTitle, { name: 'commitTitle', max: 256, required: false });
    const commitMessage = asString(req.body?.commitMessage, { name: 'commitMessage', max: 8000, required: false, trim: false });

    if (!Number.isInteger(number) || number <= 0) {
      throw AppError.badRequest('invalid_number', 'Invalid pull request number.');
    }

    const pr = await req.gh.getPullRequest(owner, repo, number);
    if (pr.merged) {
      return res.json({ alreadyMerged: true, merge: { sha: pr.merge_commit_sha, message: 'Already merged.' }, pullRequest: shapePullRequest(pr) });
    }
    if (pr.state === 'closed') {
      throw AppError.conflict('pr_closed', 'This pull request is closed and cannot be merged.');
    }

    // Wait for GitHub to finish the (async) mergeability computation.
    let current = pr;
    for (let i = 0; i < 15 && current.mergeable === null; i += 1) {
      await sleep(1000);
      current = await req.gh.getPullRequest(owner, repo, number);
    }

    if (current.mergeable === false) {
      throw AppError.conflict(
        'merge_conflict',
        'This branch has conflicts with the base branch and cannot be merged from here. Resolve them on GitHub.',
        { mergeableState: current.mergeable_state, url: current.html_url },
      );
    }

    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const merge = await req.gh.mergePullRequest(owner, repo, number, {
          mergeMethod,
          commitTitle: commitTitle || undefined,
          commitMessage: commitMessage || undefined,
        });
        logger.info('pull request merged', { repo: `${owner}/${repo}`, number, method: mergeMethod, user: req.user?.login });

        let branchDeleted = false;
        if (deleteBranch) {
          branchDeleted = await req.gh.deleteRef(owner, repo, refPath(`heads/${current.head.ref}`));
        }

        return res.json({
          merged: true,
          merge: { sha: merge.sha, message: merge.message },
          branchDeleted,
          pullRequest: shapePullRequest(await req.gh.getPullRequest(owner, repo, number)),
        });
      } catch (err) {
        lastError = err;
        const message = String(err.body?.message || err.message || '').toLowerCase();
        const retryable =
          err.status === 405 ||
          err.status === 409 ||
          message.includes('not mergeable') ||
          message.includes('head branch was modified') ||
          message.includes('mergeability');
        if (!retryable) throw err;
        await sleep(1200);
      }
    }

    if (lastError) {
      const message = String(lastError.body?.message || lastError.message || '');
      throw AppError.conflict(
        'merge_blocked',
        message || 'GitHub refused the merge. The branch rules may require reviews or passing checks.',
        { mergeableState: current.mergeable_state },
      );
    }
    throw AppError.conflict('merge_blocked', 'Could not merge the pull request.');
  }),
);

export default router;
