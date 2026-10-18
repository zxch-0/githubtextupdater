import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSpec } from '../src/parser.js';
import { buildPlan, selectPaths } from '../src/planner.js';

/** Minimal fake of the GitHub client surface used by buildPlan. */
function fakeClient(existing = {}) {
  const entries = Object.entries(existing).map(([path, value]) => ({
    path,
    type: 'blob',
    sha: `sha-${path}`,
    mode: '100644',
  }));
  const contents = new Map(
    Object.entries(existing).map(([path, value]) => [`sha-${path}`, Buffer.from(value, 'utf8').toString('base64')]),
  );

  return {
    getTreeMap: async () => ({ map: new Map(entries.map((e) => [e.path, e])), truncated: false, sha: 'tree' }),
    getBlob: async (_o, _r, sha) => {
      const b64 = contents.get(sha);
      const buf = Buffer.from(b64 || '', 'base64');
      return { content: buf.toString('utf8'), size: buf.length, isBinary: false };
    },
  };
}

test('upsert creates missing files and updates existing ones', async () => {
  const spec = [
    '```py path=new.py',
    'print(1)',
    '```',
    '```py path=old.py',
    'print(2)',
    '```',
  ].join('\n');
  const { files } = parseSpec(spec);
  const plan = await buildPlan(fakeClient({ 'old.py': 'print(0)\n' }), {
    owner: 'o',
    repo: 'r',
    ref: 'main',
    files,
  });

  assert.equal(plan.items[0].resolved, 'create');
  assert.equal(plan.items[0].additions, 1);
  assert.equal(plan.items[1].resolved, 'update');
  assert.equal(plan.items[1].additions, 1);
  assert.equal(plan.items[1].deletions, 1);
  assert.match(plan.items[1].diff, /-print\(0\)/);
  assert.equal(plan.summary.create, 1);
  assert.equal(plan.summary.update, 1);
});

test('unchanged files are skipped', async () => {
  const { files } = parseSpec('```py path=a.py\nx = 1\n```');
  const plan = await buildPlan(fakeClient({ 'a.py': 'x = 1\n' }), { owner: 'o', repo: 'r', ref: 'main', files });
  assert.equal(plan.items[0].resolved, 'skip');
  assert.equal(plan.summary.skip, 1);
});

test('create fails when the file exists, update fails when it does not', async () => {
  const create = await buildPlan(fakeClient({ 'a.py': 'old\n' }), {
    owner: 'o',
    repo: 'r',
    ref: 'main',
    files: parseSpec('```py path=a.py action=create\nx\n```').files,
  });
  assert.match(create.items[0].error, /already exists/);

  const update = await buildPlan(fakeClient({}), {
    owner: 'o',
    repo: 'r',
    ref: 'main',
    files: parseSpec('```py path=a.py action=update\nx\n```').files,
  });
  assert.match(update.items[0].error, /does not exist/);
});

test('append and prepend keep the existing content', async () => {
  const { files } = parseSpec(
    ['```py path=a.py action=append', 'tail', '```', '```py path=b.py action=prepend', 'head', '```'].join('\n'),
  );
  const plan = await buildPlan(fakeClient({ 'a.py': 'body', 'b.py': 'body\n' }), {
    owner: 'o',
    repo: 'r',
    ref: 'main',
    files,
  });
  assert.equal(plan.items[0].content, 'body\ntail\n');
  assert.equal(plan.items[1].content, 'head\nbody\n');
});

test('delete requires the file to exist', async () => {
  const { files } = parseSpec('```py path=a.py action=delete\n```');
  const ok = await buildPlan(fakeClient({ 'a.py': 'x\n' }), { owner: 'o', repo: 'r', ref: 'main', files });
  assert.equal(ok.items[0].resolved, 'delete');
  assert.equal(ok.items[0].deletions, 1);

  const missing = await buildPlan(fakeClient({}), { owner: 'o', repo: 'r', ref: 'main', files });
  assert.match(missing.items[0].error, /nothing to delete/);
});

test('selectPaths only keeps committable items', async () => {
  const { files } = parseSpec(['```py path=a.py', 'x = 1', '```', '```py path=b.py', 'y = 2', '```'].join('\n'));
  const plan = await buildPlan(fakeClient({ 'a.py': 'x = 1\n' }), { owner: 'o', repo: 'r', ref: 'main', files });
  const selected = selectPaths(plan, ['a.py', 'b.py']);
  assert.deepEqual(selected.map((i) => i.path), ['b.py']);
  assert.deepEqual(selectPaths(plan, null).map((i) => i.path), ['b.py']);
});

test('patch applies search/replace on an existing file', async () => {
  const spec = [
    '```py path=a.py action=patch',
    '<<<<<<< SEARCH',
    'b = 2',
    '=======',
    'b = 20',
    '>>>>>>> REPLACE',
    '```',
  ].join('\n');
  const { files } = parseSpec(spec);
  const plan = await buildPlan(fakeClient({ 'a.py': 'a = 1\nb = 2\nc = 3\n' }), {
    owner: 'o',
    repo: 'r',
    ref: 'main',
    files,
  });
  assert.equal(plan.items[0].resolved, 'update');
  assert.equal(plan.items[0].content, 'a = 1\nb = 20\nc = 3\n');
  assert.equal(plan.items[0].additions, 1);
  assert.equal(plan.items[0].deletions, 1);
});

test('patch errors when the SEARCH block is missing or ambiguous', async () => {
  const missing = parseSpec('```py path=a.py action=patch\n<<<<<<< SEARCH\nnope\n=======\nx\n>>>>>>> REPLACE\n```').files;
  const planMissing = await buildPlan(fakeClient({ 'a.py': 'a = 1\n' }), { owner: 'o', repo: 'r', ref: 'main', files: missing });
  assert.match(planMissing.items[0].error, /SEARCH block not found/);

  const ambiguous = parseSpec('```py path=a.py action=patch\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```').files;
  const planAmbiguous = await buildPlan(fakeClient({ 'a.py': 'a\na\n' }), {
    owner: 'o',
    repo: 'r',
    ref: 'main',
    files: ambiguous,
  });
  assert.match(planAmbiguous.items[0].error, /matches 2 places/);
});

test('patch refuses files that do not exist', async () => {
  const { files } = parseSpec('```py path=a.py action=patch\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n```');
  const plan = await buildPlan(fakeClient({}), { owner: 'o', repo: 'r', ref: 'main', files });
  assert.match(plan.items[0].error, /nothing to patch/);
});
