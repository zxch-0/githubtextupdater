/**
 * Parser for the "text block" specification.
 *
 * Canonical syntax — one fenced code block per file, the path living in the
 * info string of the fence:
 *
 *     ```python path=src/mathx/ops.py action=upsert
 *     def add(a, b):
 *         return a + b
 *     ```
 *
 * Accepted aliases in the info string:
 *   - path key     : path=, file=, filename=, src=, title=, name=
 *   - bare path    : ```js src/index.js        (first token that looks like a path)
 *   - action       : action=upsert|create|update|append|prepend|delete
 *   - executable   : exec, executable, mode=755|100755
 *   - language     : first bare token when it is not a path (```tsx path=...)
 *
 * An optional YAML-ish front matter at the very top of the paste can carry the
 * repository, base branch, PR title/body and commit message.
 */

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n`]*)$/;

export const ACTIONS = {
  upsert: 'upsert', // create if missing, replace if present (default)
  create: 'create', // fail if the file already exists
  update: 'update', // fail if the file does not exist
  replace: 'update', // alias
  append: 'append', // append to the existing content (create if missing)
  prepend: 'prepend', // prepend to the existing content (create if missing)
  delete: 'delete', // remove the file, no body required
  remove: 'delete', // alias
  patch: 'patch', // surgical search/replace edit of an existing file
  edit: 'patch', // alias
  modify: 'patch', // alias
};

const EXT_LANG = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  pyw: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  dart: 'dart',
  scala: 'scala',
  lua: 'lua',
  r: 'r',
  jl: 'julia',
  zig: 'zig',
  nim: 'nim',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  clj: 'clojure',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  vue: 'vue',
  svelte: 'svelte',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'properties',
  env: 'dotenv',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  rst: 'rst',
  txt: 'text',
  log: 'text',
  csv: 'csv',
  sql: 'sql',
  prisma: 'prisma',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'powershell',
  bat: 'batch',
  cmd: 'batch',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  mk: 'makefile',
  tf: 'hcl',
  hcl: 'hcl',
  xml: 'xml',
  svg: 'xml',
  pl: 'perl',
  pm: 'perl',
  groovy: 'groovy',
  gradle: 'gradle',
  vim: 'vim',
  asm: 'asm',
  s: 'asm',
};

const FILENAME_LANG = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnuplot: 'gnuplot',
  cmakelists: 'cmake',
  'cmakelists.txt': 'cmake',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  '.env': 'dotenv',
  '.gitignore': 'gitignore',
  '.gitattributes': 'gitignore',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  license: 'text',
  'license.md': 'text',
  readme: 'markdown',
  'readme.md': 'markdown',
  'package.json': 'json',
  'tsconfig.json': 'json',
  'go.mod': 'go',
  'go.sum': 'go',
  'cargo.toml': 'toml',
  'requirements.txt': 'text',
  'pipfile': 'toml',
  'gemfile': 'ruby',
  '.github/workflows': 'yaml',
};

const LANG_ALIASES = {
  js: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  py: 'python',
  python3: 'python',
  rb: 'ruby',
  golang: 'go',
  rs: 'rust',
  'c++': 'cpp',
  'objective-c': 'objectivec',
  cs: 'csharp',
  'c#': 'csharp',
  shell: 'shell',
  bash: 'shell',
  zsh: 'shell',
  console: 'shell',
  sh: 'shell',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  htm: 'html',
  docker: 'dockerfile',
  tf: 'hcl',
  terraform: 'hcl',
  plaintext: 'text',
  plain: 'text',
  text: 'text',
  '': null,
};

export function normalizeLanguage(lang) {
  if (!lang) return null;
  const l = String(lang).toLowerCase().trim();
  if (!l) return null;
  if (LANG_ALIASES[l] !== undefined) return LANG_ALIASES[l];
  return l;
}

export function inferLanguage(path) {
  const p = String(path || '').toLowerCase();
  const base = p.split('/').pop() || '';
  if (FILENAME_LANG[base]) return FILENAME_LANG[base];
  if (base.startsWith('.') && FILENAME_LANG[base]) return FILENAME_LANG[base];
  if (p.includes('.github/workflows/')) return 'yaml';
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const ext = base.slice(dot + 1);
    if (EXT_LANG[ext]) return EXT_LANG[ext];
  }
  return null;
}

/** Rejects traversal, absolute paths, .git internals, Windows drives, empties. */
export function normalizeRepoPath(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: 'missing path' };
  }
  let p = input.trim().replace(/^["'<(`]+/, '').replace(/["'>)`,;]+$/, '');
  p = p.replace(/\\/g, '/');
  // Tolerate copy/paste of GitHub URLs: blob/main/src/app.py
  p = p.replace(/^(?:blob|tree|raw|edit)\/[^/]+\//, '');
  p = p.replace(/^\.?\/{1,}/, '');
  p = p.replace(/\/{2,}/g, '/');
  if (!p) return { ok: false, error: 'empty path' };
  if (/^[A-Za-z]:/.test(p)) return { ok: false, error: 'absolute Windows paths are not allowed' };
  if (p.includes('\0')) return { ok: false, error: 'path contains a null byte' };
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      return { ok: false, error: 'path must not contain "." or ".." segments' };
    }
    if (/[<>:"|?*\u0000-\u001f]/.test(seg)) {
      return { ok: false, error: 'path contains characters that are not allowed by git' };
    }
    if (seg.length > 255) return { ok: false, error: 'path segment is too long' };
  }
  if (segments[0] === '.git') return { ok: false, error: 'cannot write inside .git/' };
  if (p.endsWith('/')) return { ok: false, error: 'path must point to a file, not a directory' };
  if (p.length > 512) return { ok: false, error: 'path is too long' };
  return { ok: true, path: p };
}

const PATH_KEYS = new Set(['path', 'file', 'filename', 'src', 'title', 'name', 'target', 'dest']);

function tokenizeInfo(info) {
  return info.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function looksLikePath(token) {
  return token.includes('/') || /^[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,10}$/.test(token);
}

function parseInfoString(info) {
  const out = { lang: null, path: null, action: null, exec: false, mode: null, unknown: [] };
  const rest = [];
  for (const token of tokenizeInfo(info)) {
    const kv = /^([A-Za-z_][\w-]*)[=:](.*)$/.exec(token);
    if (!kv) {
      rest.push(unquote(token));
      continue;
    }
    const key = kv[1].toLowerCase();
    const value = unquote(kv[2]);
    if (PATH_KEYS.has(key)) out.path = value;
    else if (key === 'lang' || key === 'language') out.lang = value;
    else if (key === 'action' || key === 'mode2' || key === 'op') out.action = value;
    else if (key === 'exec' || key === 'executable') out.exec = value === '' || /^(true|1|yes)$/i.test(value);
    else if (key === 'mode' || key === 'perm' || key === 'permissions') out.mode = value;
    else out.unknown.push(key);
  }

  // Bare tokens: the first one is the language when it is not a path.
  for (const token of rest) {
    if (/^(exec|executable)$/i.test(token)) {
      out.exec = true;
      continue;
    }
    if (!out.path && looksLikePath(token)) {
      out.path = token;
      continue;
    }
    if (!out.lang && !looksLikePath(token)) {
      out.lang = token;
      continue;
    }
    if (!out.path && out.lang) {
      out.path = token;
    }
  }
  return out;
}

function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  const meta = {};
  let i = 1;
  let key = null;
  let blockLines = null;
  const commit = () => {
    if (!key) return;
    meta[key] = blockLines ? blockLines.join('\n').replace(/\s+$/, '') : (meta[key] ?? '');
    key = null;
    blockLines = null;
  };
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^---\s*$/.test(line) || /^\.\.\.\s*$/.test(line)) {
      commit();
      return { meta, rest: lines.slice(i + 1).join('\n'), consumedLines: i + 1 };
    }
    const block = /^(\s+)(.*)$/.exec(line);
    if (key && blockLines && block && line.trim() !== '') {
      blockLines.push(block[2]);
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    commit();
    key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (value === '|' || value === '>' || value === '') {
      blockLines = value === '' ? null : [];
      meta[key] = value === '' ? '' : null;
    } else {
      meta[key] = unquote(value);
      key = null;
    }
  }
  return null; // unterminated front matter -> treat the whole paste as body
}

const META_KEYS = {
  repo: 'repo',
  repository: 'repo',
  owner_repo: 'repo',
  branch: 'branch',
  base: 'branch',
  base_branch: 'branch',
  pr_title: 'prTitle',
  title: 'prTitle',
  pr_body: 'prBody',
  body: 'prBody',
  description: 'prBody',
  commit_message: 'commitMessage',
  commit: 'commitMessage',
  message: 'commitMessage',
  draft: 'draft',
};

function normalizeMeta(raw) {
  const meta = {};
  for (const [key, value] of Object.entries(raw)) {
    const mapped = META_KEYS[key];
    if (!mapped || value === null) {
      if (value !== null) meta[key] = value;
      continue;
    }
    meta[mapped] = value;
  }
  if (meta.draft !== undefined) {
    meta.draft = /^(true|1|yes|on)$/i.test(String(meta.draft));
  }
  return meta;
}

const SEARCH_START = /^\s*<{5,}\s*SEARCH\s*$/;
const SEARCH_MID = /^\s*={5,}\s*$/;
const SEARCH_END = /^\s*>{5,}\s*REPLACE\s*$/;

/**
 * Parse the body of an `action=patch` block: one or more
 * `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` sections.
 */
export function parsePatchBody(content) {
  const lines = String(content || '').split('\n');
  const pairs = [];
  let current = null;
  let bucket = null;

  // Every captured line is terminated by a newline in the original text.
  const join = (arr) => (arr.length ? `${arr.join('\n')}\n` : '');
  const flush = () => {
    if (!current) return;
    pairs.push({ search: join(current.search), replace: join(current.replace) });
    current = null;
    bucket = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (SEARCH_START.test(line)) {
      if (current) return { error: 'A SEARCH section is already open, close it with >>>>>>> REPLACE first.' };
      current = { search: [], replace: [] };
      bucket = 'search';
      continue;
    }
    if (current && bucket === 'search' && SEARCH_MID.test(line)) {
      bucket = 'replace';
      continue;
    }
    if (current && bucket === 'replace' && SEARCH_END.test(line)) {
      flush();
      continue;
    }
    if (current) {
      current[bucket].push(line);
      continue;
    }
    if (line.trim() !== '') {
      return { error: `Unexpected line outside of a SEARCH/REPLACE section: "${line.trim().slice(0, 60)}"`.replace(/"/g, "'") };
    }
  }

  if (current) return { error: 'Unterminated SEARCH/REPLACE section (missing ">>>>>>> REPLACE").' };
  if (pairs.length === 0) {
    return {
      error:
        'An action=patch block must contain at least one <<<<<<< SEARCH … ======= … >>>>>>> REPLACE section.',
    };
  }
  for (const pair of pairs) {
    if (pair.search.replace(/\s/g, '') === '') return { error: 'A SEARCH section is empty.' };
  }
  return { pairs };
}

/**
 * @param {string} input raw pasted text
 * @returns {{meta: object, files: Array, errors: Array, warnings: Array, fenceCount: number}}
 */
export function parseSpec(input) {
  const errors = [];
  const warnings = [];
  const files = [];

  let text = typeof input === 'string' ? input : '';
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n');

  let body = text;
  let lineOffset = 0;
  let meta = {};

  const fm = parseFrontMatter(text);
  if (fm) {
    body = fm.rest;
    lineOffset = fm.consumedLines;
    meta = normalizeMeta(fm.meta);
  }

  const lines = body.split('\n');
  const seen = new Map();
  let fenceCount = 0;
  let i = 0;

  while (i < lines.length) {
    const open = FENCE_RE.exec(lines[i]);
    if (!open) {
      i += 1;
      continue;
    }
    const indent = open[1].length;
    const marker = open[2];
    const fenceChar = marker[0];
    const fenceLen = marker.length;
    const info = open[3];
    const openLine = lineOffset + i + 1;
    fenceCount += 1;
    i += 1;

    const contentLines = [];
    let closed = false;
    const closeRe = new RegExp(`^\\s{0,3}${fenceChar === '`' ? '`' : '~'}{${fenceLen},}\\s*$`);
    while (i < lines.length) {
      if (closeRe.test(lines[i])) {
        closed = true;
        i += 1;
        break;
      }
      contentLines.push(lines[i]);
      i += 1;
    }

    if (!closed) {
      errors.push({
        line: openLine,
        code: 'unterminated_fence',
        message: 'This code block is never closed. Add a closing fence (```) at the end of the file content.',
        snippet: lines[openLine - 1 - lineOffset] || '',
      });
      break;
    }

    const parsed = parseInfoString(info);
    const pathResult = normalizeRepoPath(parsed.path);
    if (!pathResult.ok) {
      errors.push({
        line: openLine,
        code: 'invalid_path',
        message: `Invalid or missing file path (${pathResult.error}). Expected something like \`\`\`${parsed.lang || 'ts'} path=src/index.ts`,
        snippet: info,
      });
      continue;
    }

    const path = pathResult.path;
    if (seen.has(path)) {
      errors.push({
        line: openLine,
        code: 'duplicate_path',
        message: `"${path}" is declared twice (first at line ${seen.get(path)}). Merge the two blocks into one.`,
        snippet: info,
      });
      continue;
    }
    seen.set(path, openLine);

    let action = 'upsert';
    if (parsed.action) {
      const key = String(parsed.action).toLowerCase().trim();
      if (!Object.prototype.hasOwnProperty.call(ACTIONS, key)) {
        errors.push({
          line: openLine,
          code: 'invalid_action',
          message: `Unknown action "${parsed.action}". Use one of: upsert, create, update, append, prepend, delete.`,
          snippet: info,
        });
        continue;
      }
      action = ACTIONS[key];
    }

    const dedent = indent > 0 ? new RegExp(`^ {0,${indent}}`) : null;
    let content = contentLines.map((line) => (dedent ? line.replace(dedent, '') : line)).join('\n');
    if (content !== '' && !content.endsWith('\n')) content += '\n';

    const lang = normalizeLanguage(parsed.lang) || inferLanguage(path);
    if (!parsed.lang && !lang) {
      warnings.push({
        line: openLine,
        code: 'unknown_language',
        message: `Could not guess the language of "${path}". It is cosmetic only — add it to the fence, e.g. \`\`\`ts path=${path}.`,
      });
    }
    let patch = null;
    if (action === 'patch') {
      const parsedPatch = parsePatchBody(content);
      if (parsedPatch.error) {
        errors.push({
          line: openLine,
          code: 'invalid_patch',
          message: `"${path}": ${parsedPatch.error}`,
          snippet: info,
        });
        continue;
      }
      patch = parsedPatch.pairs;
    }

    if (action !== 'delete' && action !== 'patch' && content.replace(/\s/g, '') === '') {
      errors.push({
        line: openLine,
        code: 'empty_content',
        message: `"${path}" has an empty body. Remove the block or use action=delete.`,
        snippet: info,
      });
      continue;
    }
    if (action === 'delete' && content.trim() !== '') {
      warnings.push({
        line: openLine,
        code: 'delete_ignores_body',
        message: `"${path}" uses action=delete, its body is ignored.`,
      });
    }

    const existing = inferLanguage(path);
    if (parsed.lang && existing && normalizeLanguage(parsed.lang) !== existing) {
      warnings.push({
        line: openLine,
        code: 'language_mismatch',
        message: `Language "${normalizeLanguage(parsed.lang)}" does not match the "${path}" extension (${existing}).`,
      });
    }

    let mode = '100644';
    if (parsed.exec || ['755', '0755', '100755'].includes(String(parsed.mode || ''))) mode = '100755';

    files.push({
      path,
      lang: lang || 'text',
      action,
      mode,
      content: action === 'delete' || action === 'patch' ? '' : content,
      rawContent: content,
      patch,
      size: Buffer.byteLength(action === 'delete' ? '' : content, 'utf8'),
      line: openLine,
      info,
    });
  }

  if (fenceCount === 0 && text.trim() !== '') {
    errors.push({
      line: 1,
      code: 'no_code_blocks',
      message:
        'No fenced code block found. Each file must be written as ```lang path=dir/file.ext … ``` followed by its content and a closing ```.',
      snippet: text.trim().split('\n')[0].slice(0, 120),
    });
  }

  return { meta, files, errors, warnings, fenceCount };
}
