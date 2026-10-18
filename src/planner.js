import { createTwoFilesPatch } from 'diff';
import { config } from './config.js';
import { mapLimit } from './github.js';

const DEFAULT_MODE = '100644';

function countStats(patch) {
  if (!patch) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

function unifiedDiff({ path, oldContent, newContent, oldLabel, newLabel }) {
  return createTwoFilesPatch(oldLabel, newLabel, oldContent ?? '', newContent ?? '', undefined, undefined, {
    context: 3,
  });
}

/**
 * Resolve a parsed specification against the current state of `ref`.
 *
 * @param {import('./github.js').GitHubClient} client
 * @param {{owner: string, repo: string, ref: string, files: Array, includeDiffs?: boolean}} args
 */
export async function buildPlan(client, { owner, repo, ref, files, includeDiffs = true }) {
  const { map: treeMap, truncated } = await client.getTreeMap(owner, repo, ref);

  // Existence comes from the tree (cheap), content only when we actually need it.
  const existing = new Map();
  for (const file of files) {
    const entry = treeMap.get(file.path);
    existing.set(file.path, {
      exists: Boolean(entry),
      sha: entry ? entry.sha : null,
      mode: entry?.mode || DEFAULT_MODE,
      size: entry?.size ?? 0,
      content: null,
      binary: false,
    });
  }

  const needContent = files.filter((f) =>
    ['update', 'upsert', 'append', 'prepend', 'delete', 'patch'].includes(f.action),
  );
  await mapLimit(needContent, 6, async (file) => {
    const state = existing.get(file.path);
    if (!state?.sha) return;
    const blob = await client.getBlob(owner, repo, state.sha);
    state.content = blob.isBinary ? null : blob.content;
    state.binary = blob.isBinary;
    state.size = blob.size;
  });

  const items = [];
  for (const file of files) {
    const state = existing.get(file.path) || { exists: false, sha: null, mode: DEFAULT_MODE, content: null, binary: false, size: 0 };
    const item = {
      path: file.path,
      lang: file.lang,
      requestedAction: file.action,
      line: file.line,
      mode: state.exists ? state.mode : file.mode || DEFAULT_MODE,
      existingSize: state.size,
      exists: state.exists,
      binary: state.binary,
      sha: state.sha,
      resolved: 'skip',
      content: file.content,
      diff: null,
      additions: 0,
      deletions: 0,
      error: null,
      warning: null,
    };

    if (file.size > config.limits.fileBytes) {
      item.error = `File body is ${(file.size / 1024).toFixed(0)} KiB, above the ${(
        config.limits.fileBytes / 1024
      ).toFixed(0)} KiB limit.`;
      items.push(item);
      continue;
    }

    if (state.binary && file.action !== 'delete') {
      item.error = 'The existing file is binary. Only deletion is supported for binary files.';
      items.push(item);
      continue;
    }

    switch (file.action) {
      case 'create': {
        if (state.exists) {
          item.error = 'The file already exists but the block uses action=create.';
          break;
        }
        item.resolved = 'create';
        item.content = file.content;
        break;
      }
      case 'update': {
        if (!state.exists) {
          item.error = 'The file does not exist but the block uses action=update. Use action=upsert to allow both.';
          break;
        }
        item.resolved = contentEquals(state.content, file.content) ? 'skip' : 'update';
        item.content = file.content;
        break;
      }
      case 'upsert': {
        if (!state.exists) item.resolved = 'create';
        else item.resolved = contentEquals(state.content, file.content) ? 'skip' : 'update';
        item.content = file.content;
        break;
      }
      case 'append': {
        const base = state.exists ? state.content ?? '' : '';
        const sep = base && !base.endsWith('\n') ? '\n' : '';
        item.resolved = state.exists ? 'update' : 'create';
        item.content = base + sep + file.content;
        break;
      }
      case 'prepend': {
        const base = state.exists ? state.content ?? '' : '';
        const sep = file.content && !file.content.endsWith('\n') ? '\n' : '';
        item.resolved = state.exists ? 'update' : 'create';
        item.content = file.content + sep + base;
        break;
      }
      case 'patch': {
        if (!state.exists) {
          item.error = 'The file does not exist, there is nothing to patch. Use action=upsert to create it.';
          break;
        }
        let text = state.content ?? '';
        for (const pair of file.patch || []) {
          const occurrences = text.split(pair.search).length - 1;
          if (occurrences === 0) {
            item.error = `SEARCH block not found in "${file.path}". Copy the exact lines from the file (including indentation).`;
            break;
          }
          if (occurrences > 1) {
            item.error = `SEARCH block matches ${occurrences} places in "${file.path}". Add more context so it is unique.`;
            break;
          }
          text = text.replace(pair.search, () => pair.replace);
        }
        if (!item.error) {
          item.resolved = contentEquals(state.content, text) ? 'skip' : 'update';
          item.content = text;
        }
        break;
      }
      case 'delete': {
        if (!state.exists) {
          item.error = 'The file does not exist, there is nothing to delete.';
          break;
        }
        item.resolved = 'delete';
        item.content = '';
        break;
      }
      default: {
        item.error = `Unsupported action "${file.action}".`;
      }
    }

    if (!item.error && item.resolved !== 'skip' && includeDiffs && !state.binary) {
      const oldContent = state.exists ? state.content ?? '' : '';
      const newContent = item.resolved === 'delete' ? '' : item.content;
      item.diff = unifiedDiff({
        path: item.path,
        oldContent,
        newContent,
        oldLabel: state.exists ? `a/${item.path}` : '/dev/null',
        newLabel: item.resolved === 'delete' ? '/dev/null' : `b/${item.path}`,
      });
      if (item.resolved === 'create') {
        item.additions = newContent ? newContent.split('\n').length - (newContent.endsWith('\n') ? 1 : 0) : 0;
        item.deletions = 0;
      } else if (item.resolved === 'delete') {
        item.deletions = oldContent ? oldContent.split('\n').length - (oldContent.endsWith('\n') ? 1 : 0) : 0;
        item.additions = 0;
      } else {
        const stats = countStats(item.diff);
        item.additions = stats.additions;
        item.deletions = stats.deletions;
      }
    }

    if (item.resolved === 'skip') {
      item.warning = 'Already up to date, nothing to commit for this file.';
    }

    items.push(item);
  }

  const summary = items.reduce(
    (acc, item) => {
      if (item.error) acc.errors += 1;
      else if (item.resolved === 'create') acc.create += 1;
      else if (item.resolved === 'update') acc.update += 1;
      else if (item.resolved === 'delete') acc.delete += 1;
      else acc.skip += 1;
      acc.additions += item.additions;
      acc.deletions += item.deletions;
      return acc;
    },
    { create: 0, update: 0, delete: 0, skip: 0, errors: 0, additions: 0, deletions: 0, total: items.length },
  );

  return { ref, items, summary, truncatedTree: truncated };
}

function contentEquals(a, b) {
  if (a == null) return b == null || b === '';
  return a === b;
}

/** Filter a plan down to the paths selected in the UI. */
export function selectPaths(plan, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return plan.items.filter((i) => !i.error && i.resolved !== 'skip');
  const wanted = new Set(paths);
  return plan.items.filter((i) => wanted.has(i.path) && !i.error && i.resolved !== 'skip');
}
