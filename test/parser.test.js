import assert from 'node:assert/strict';
import test from 'node:test';
import { inferLanguage, normalizeLanguage, normalizeRepoPath, parseSpec } from '../src/parser.js';

test('parses a fenced block with path in the info string', () => {
  const spec = [
    '```python path=src/mathx/ops.py',
    'def add(a, b):',
    '    return a + b',
    '```',
  ].join('\n');

  const { files, errors } = parseSpec(spec);
  assert.deepEqual(errors, []);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/mathx/ops.py');
  assert.equal(files[0].lang, 'python');
  assert.equal(files[0].action, 'upsert');
  assert.equal(files[0].content, 'def add(a, b):\n    return a + b\n');
});

test('supports several files, aliases and actions', () => {
  const spec = [
    '```ts file=src/index.ts action=create mode=755',
    'export const one = 1;',
    '```',
    '',
    '```yaml file=config/app.yml action=update',
    'a: 1',
    '```',
    '',
    '```md title=docs/NOTES.md action=append',
    '- new note',
    '```',
    '',
    '``` path=legacy/old.txt action=delete exec',
    '```',
  ].join('\n');

  const { files, errors } = parseSpec(spec);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    files.map((f) => [f.path, f.action, f.lang, f.mode]),
    [
      ['src/index.ts', 'create', 'typescript', '100755'],
      ['config/app.yml', 'update', 'yaml', '100644'],
      ['docs/NOTES.md', 'append', 'markdown', '100644'],
      ['legacy/old.txt', 'delete', 'text', '100755'],
    ],
  );
});

test('accepts a bare path as the first info token', () => {
  const { files, errors } = parseSpec('```js src/app.js\nconsole.log(1)\n```');
  assert.deepEqual(errors, []);
  assert.equal(files[0].path, 'src/app.js');
  assert.equal(files[0].lang, 'javascript');
});

test('reports blocks without a path with their line number', () => {
  const spec = ['```python', 'x = 1', '```'].join('\n');
  const { errors, files } = parseSpec(spec);
  assert.equal(files.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
  assert.equal(errors[0].code, 'invalid_path');
});

test('reports unterminated fences', () => {
  const { errors } = parseSpec('```js path=a.js\nx = 1\n');
  assert.equal(errors[0].code, 'unterminated_fence');
});

test('rejects dangerous paths', () => {
  for (const bad of ['../escape.py', '.git/config', 'src/../../x', 'C:\\windows\\x.txt', 'src/']) {
    const { files, errors } = parseSpec(`\`\`\`py path=${bad}\nx = 1\n\`\`\``);
    assert.equal(files.length, 0, `expected ${bad} to be rejected`);
    assert.equal(errors[0].code, 'invalid_path');
  }
});

test('normalises github URL style paths', () => {
  assert.deepEqual(normalizeRepoPath('blob/main/src/app.py'), { ok: true, path: 'src/app.py' });
  assert.deepEqual(normalizeRepoPath('./src//app.py'), { ok: true, path: 'src/app.py' });
  assert.deepEqual(normalizeRepoPath('src\\win\\app.py'), { ok: true, path: 'src/win/app.py' });
});

test('detects duplicate paths', () => {
  const spec = ['```py path=a.py', 'x = 1', '```', '```py path=a.py', 'x = 2', '```'].join('\n');
  const { files, errors } = parseSpec(spec);
  assert.equal(files.length, 1);
  assert.equal(errors[0].code, 'duplicate_path');
  assert.equal(errors[0].line, 4);
});

test('parses optional front matter', () => {
  const spec = [
    '---',
    'repo: acme/widgets',
    'branch: develop',
    'pr_title: Add ops',
    'pr_body: |',
    '  First line',
    '  Second line',
    'commit_message: feat: add ops',
    'draft: true',
    '---',
    '',
    '```py path=ops.py',
    'x = 1',
    '```',
  ].join('\n');

  const { meta, files, errors } = parseSpec(spec);
  assert.deepEqual(errors, []);
  assert.equal(files.length, 1);
  assert.equal(meta.repo, 'acme/widgets');
  assert.equal(meta.branch, 'develop');
  assert.equal(meta.prTitle, 'Add ops');
  assert.equal(meta.prBody, 'First line\nSecond line');
  assert.equal(meta.commitMessage, 'feat: add ops');
  assert.equal(meta.draft, true);
  assert.equal(files[0].line, 12);
});

test('errors when the paste has no code block at all', () => {
  const { errors } = parseSpec('just some text without fences');
  assert.equal(errors[0].code, 'no_code_blocks');
});

test('language helpers', () => {
  assert.equal(normalizeLanguage('py'), 'python');
  assert.equal(normalizeLanguage('TS'), 'typescript');
  assert.equal(inferLanguage('src/App.tsx'), 'tsx');
  assert.equal(inferLanguage('Dockerfile'), 'dockerfile');
  assert.equal(inferLanguage('.github/workflows/ci.yml'), 'yaml');
  assert.equal(inferLanguage('Makefile'), 'makefile');
  assert.equal(inferLanguage('weird.xyzzy'), null);
});

test('indented fences are dedented', () => {
  const spec = ['  ```py path=a.py', '  x = 1', '  if x:', '      pass', '  ```'].join('\n');
  const { files, errors } = parseSpec(spec);
  assert.deepEqual(errors, []);
  assert.equal(files[0].content, 'x = 1\nif x:\n    pass\n');
});

test('tilde fences and 4-backtick fences work', () => {
  const tilde = parseSpec('~~~rb path=a.rb\nputs 1\n~~~');
  assert.equal(tilde.files[0].path, 'a.rb');

  const nested = parseSpec(['````md path=a.md', '```js', 'code', '```', '````'].join('\n'));
  assert.equal(nested.files.length, 1);
  assert.equal(nested.files[0].content, '```js\ncode\n```\n');
});

test('parses action=patch search/replace blocks', () => {
  const spec = [
    '```py path=a.py action=patch',
    '<<<<<<< SEARCH',
    'x = 1',
    '=======',
    'x = 2',
    '>>>>>>> REPLACE',
    '```',
  ].join('\n');
  const { files, errors } = parseSpec(spec);
  assert.deepEqual(errors, []);
  assert.equal(files[0].action, 'patch');
  assert.equal(files[0].content, '');
  assert.deepEqual(files[0].patch, [{ search: 'x = 1\n', replace: 'x = 2\n' }]);
});

test('patch blocks can hold several sections and delete lines', () => {
  const spec = [
    '```py path=a.py action=patch',
    '<<<<<<< SEARCH',
    'a = 1',
    '=======',
    'a = 2',
    '>>>>>>> REPLACE',
    '<<<<<<< SEARCH',
    'b = 2',
    '=======',
    '>>>>>>> REPLACE',
    '```',
  ].join('\n');
  const { files, errors } = parseSpec(spec);
  assert.deepEqual(errors, []);
  assert.equal(files[0].patch.length, 2);
  assert.equal(files[0].patch[1].replace, '');
});

test('malformed patch blocks are reported', () => {
  const bad = parseSpec('```py path=a.py action=patch\njust some code\n```');
  assert.equal(bad.errors[0].code, 'invalid_patch');

  const unterminated = parseSpec('```py path=a.py action=patch\n<<<<<<< SEARCH\nx = 1\n=======\ny = 2\n```');
  assert.equal(unterminated.errors[0].code, 'invalid_patch');
});
