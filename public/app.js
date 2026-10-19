/* GitHub Text Updater — front-end (vanilla ESM, no build step). */

// The very same parser the server uses: it only relies on APIs that exist in
// browsers, so the block is validated locally (no token, no network, instant).
import { parseSpec } from '/lib/parser.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const LS = {
  spec: 'gtu.spec',
  repo: 'gtu.repo',
  branch: 'gtu.branch',
};

const state = {
  user: null,
  repo: null, // { fullName, owner, name, defaultBranch, branches }
  base: '',
  branch: '',
  plan: null,
  selected: new Set(),
  openDiffs: new Set(),
  commit: null,
  pr: null,
  treeCache: null,
  analysedHash: null, // last (repo, base, branch, text) sent to /api/plan
};

// ------------------------------------------------------------------ helpers

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripTags(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function requestOnce(path, { method, body }) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { res, text, data };
}

/** Human readable failure, with the HTTP status, the endpoint and any body snippet. */
function describeFailure({ res, text, data }, path, method) {
  const where = `${method} ${path}`;
  const serverMessage = data?.error?.message;
  const retryAfter = res.headers.get('retry-after');
  const snippet = serverMessage ? '' : stripTags(text).slice(0, 200);

  if (res.status === 429) {
    return `Too many requests (${where})${retryAfter ? ` — retry in ${retryAfter}s` : ''}. ${
      serverMessage || 'Wait a minute and try again.'
    }`.trim();
  }
  if (res.status === 403) {
    const proxyHint = /<html|<!doctype|cloudflare|render|suspend|forbidden/i.test(snippet)
      ? ' This answer comes from your host (not the app): check that the Render service is running and not suspended.'
      : ' Most likely: GitHub rate limit reached, token without write permission on this repo, or SSO not authorised.';
    return (
      `HTTP 403 on ${where}. ${serverMessage || 'GitHub refused the request.'}`.trim() +
      proxyHint +
      (snippet ? ` Response: "${snippet}"` : '')
    );
  }
  if (res.status === 401) {
    return `HTTP 401 on ${where} — the session is gone or the token was revoked. Reconnect in step 1.`;
  }
  if (res.status === 404) {
    return `HTTP 404 on ${where}. ${serverMessage || 'Not found.'}`;
  }
  if (res.status >= 500) {
    return `HTTP ${res.status} on ${where} — the server (or GitHub) is unavailable.${
      snippet ? ` Response: "${snippet}"` : ''
    } Retry in a few seconds.`;
  }
  return `Request failed (HTTP ${res.status} on ${where}). ${serverMessage || ''}${
    snippet ? ` Response: "${snippet}"` : ''
  }`.trim();
}

async function api(path, { method = 'GET', body } = {}) {
  let last = null;
  let networkError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      last = await requestOnce(path, { method, body });
      networkError = null;
    } catch (err) {
      // fetch() itself failed: no answer at all. On a free Render instance that
      // is almost always a cold start, so wait a little and try again.
      networkError = err;
      if (attempt < 3) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
    }
    // 502/503/504 usually mean the Render instance is waking up: retry.
    if (last && [502, 503, 504].includes(last.res.status) && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    break;
  }

  if (!last) {
    const reason = networkError?.message ? ` (${networkError.message})` : '';
    throw new Error(
      `The server did not answer ${method} ${path}${reason}. Your instance is probably waking up: wait a few seconds and try again.`,
    );
  }

  const { res, data } = last;
  if (res.ok) return data;

  if (res.status === 401 && path !== '/api/session') {
    setUser(null);
    showAlert(
      $('#connect-error'),
      'Your session expired or the token was revoked. Paste a GitHub token again in step 1.',
    );
  }

  if (res.status === 403 || res.status === 429) loadQuota();

  const err = new Error(describeFailure(last, path, method));
  err.status = res.status;
  err.code = data?.error?.code;
  err.details = data?.error?.details;
  throw err;
}

function showAlert(el, message, list) {
  if (!message && (!list || list.length === 0)) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  const items = list && list.length ? `<ul>${list.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '';
  el.innerHTML = `${escapeHtml(message || '')}${items}`;
}

function clearAlert(el) {
  el.hidden = true;
  el.innerHTML = '';
}

function setStatus(el, message, busy = false) {
  el.innerHTML = busy ? `<span class="spinner"></span> ${escapeHtml(message)}` : escapeHtml(message || '');
}

function setStepEnabled(step, enabled) {
  const fields = $(`#step-${step} .step-fields`);
  if (fields) fields.disabled = !enabled;
}

function badge(text, kind = '') {
  return `<span class="badge ${kind}">${escapeHtml(text)}</span>`;
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ------------------------------------------------------------------- modals

let activeModal = null;

function openModal({ title, renderBody, footer = [] }) {
  closeModal();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="modal-head"><h3>${escapeHtml(title)}</h3><button class="btn ghost small" data-close>Close</button></div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>
    </div>`;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.hasAttribute('data-close')) closeModal();
  });
  document.body.appendChild(backdrop);

  const modal = { backdrop, body: backdrop.querySelector('.modal-body'), foot: backdrop.querySelector('.modal-foot') };
  activeModal = modal;
  renderBody?.(modal);
  for (const btn of footer) {
    const b = document.createElement('button');
    b.className = `btn ${btn.kind || ''}`;
    b.textContent = btn.label;
    b.addEventListener('click', () => btn.onClick?.(modal, b));
    modal.foot.appendChild(b);
    btn.el = b;
  }
  document.addEventListener('keydown', onModalKey);
  return modal;
}

function onModalKey(e) {
  if (e.key === 'Escape') closeModal();
}

function closeModal() {
  if (!activeModal) return;
  activeModal.backdrop.remove();
  activeModal = null;
  document.removeEventListener('keydown', onModalKey);
}

// ------------------------------------------------------------------ session

async function loadSession() {
  try {
    const data = await api('/api/session');
    if (data.connected) {
      setUser(data.user);
      const saved = localStorage.getItem(LS.repo);
      if (saved) $('#repo-input').value = saved;
      if (saved) loadRepo(saved, { silent: true });
      return;
    }
  } catch {
    /* ignore */
  }
  setUser(null);
}

function setUser(user) {
  state.user = user;
  const pill = $('#session-pill');
  if (!user) {
    pill.className = 'pill pill-muted';
    pill.textContent = 'Not connected';
    $('#token').value = '';
    setStepEnabled(2, false);
    setStepEnabled(3, false);
    setStepEnabled(4, false);
    setStepEnabled(5, false);
    return;
  }
  pill.className = 'pill pill-ok';
  pill.innerHTML = `<img src="${escapeHtml(user.avatarUrl)}" alt="" /><span>Connected as <strong>${escapeHtml(
    user.login,
  )}</strong></span><button class="btn ghost small" id="disconnect">Disconnect</button>`;
  $('#disconnect').addEventListener('click', async () => {
    await api('/api/session', { method: 'DELETE' });
    setUser(null);
  });
  setStepEnabled(2, true);
  loadQuota();
}

/** Show the remaining GitHub quota — a 403 is most often an exhausted quota. */
async function loadQuota() {
  const el = $('#quota');
  if (!state.user) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = '<span class="spinner"></span> Checking GitHub quota…';
  try {
    const data = await api('/api/rate-limit');
    const core = data.limits?.core;
    if (!core) {
      el.hidden = true;
      return;
    }
    const reset = new Date(core.resetAt).toLocaleTimeString();
    el.innerHTML = `GitHub quota: <strong>${core.remaining}/${core.limit}</strong> requests left · resets at ${escapeHtml(
      reset,
    )} · <button class="btn ghost small" type="button" id="quota-refresh">Refresh</button>`;
    $('#quota-refresh')?.addEventListener('click', loadQuota);
  } catch (err) {
    el.textContent = err.message;
  }
}

$('#connect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#connect-btn');
  const errEl = $('#connect-error');
  clearAlert(errEl);
  const token = $('#token').value.trim();
  if (!token) return;
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const data = await api('/api/session', { method: 'POST', body: { token } });
    setUser(data.user);
  } catch (err) {
    showAlert(errEl, err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
});

// --------------------------------------------------------- repository picker

function suggestBranchName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes(),
  )}${pad(now.getSeconds())}`;
  return `text-updater/${stamp}`;
}

function repoParts(fullName) {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(fullName || '').trim());
  return m ? { owner: m[1], name: m[2] } : null;
}

async function loadRepo(fullName, { silent = false } = {}) {
  const parts = repoParts(fullName);
  const errEl = $('#repo-error');
  const statusEl = $('#repo-status');
  clearAlert(errEl);
  if (!parts) {
    if (!silent) showAlert(errEl, 'Type a repository as "owner/name".');
    return;
  }
  statusEl.hidden = false;
  setStatus(statusEl, `Loading ${parts.owner}/${parts.name}…`, true);
  try {
    const data = await api(`/api/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}`);
    state.repo = { ...data.repo, branches: data.branches };
    state.base = data.repo.defaultBranch;
    state.treeCache = null;

    const select = $('#base-branch');
    select.innerHTML = data.branches
      .map((b) => `<option value="${escapeHtml(b.name)}"${b.name === data.repo.defaultBranch ? ' selected' : ''}>${
        escapeHtml(b.name) + (b.protected ? ' (protected)' : '')
      }</option>`)
      .join('');
    if (!data.branches.some((b) => b.name === data.repo.defaultBranch)) {
      select.insertAdjacentHTML('afterbegin', `<option value="${escapeHtml(state.base)}">${escapeHtml(state.base)}</option>`);
    }
    if (!$('#head-branch').value.trim()) $('#head-branch').value = suggestBranchName();
    state.branch = $('#head-branch').value.trim();

    localStorage.setItem(LS.repo, data.repo.fullName);
    setStatus(
      statusEl,
      `${data.repo.fullName} · ${data.branches.length} branch(es) · default: ${data.repo.defaultBranch}`,
    );
    setStepEnabled(3, true);
    await analyse({ silent });
  } catch (err) {
    state.repo = null;
    setStepEnabled(3, false);
    if (!silent) showAlert(errEl, err.message);
    setStatus(statusEl, '');
  }
}

$('#repo-input').addEventListener(
  'change',
  debounce(() => loadRepo($('#repo-input').value), 400),
);
$('#repo-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    loadRepo($('#repo-input').value);
  }
});
$('#base-branch').addEventListener('change', () => {
  state.base = $('#base-branch').value;
  state.treeCache = null;
  if ($('#spec-text').value.trim()) analyse();
});
$('#head-branch').addEventListener('input', () => {
  state.branch = $('#head-branch').value.trim();
  updateCommitButton();
  // The plan is computed against this branch when it already exists.
  if (specEl.value.trim()) debouncedAnalyse();
});

$('#load-repos').addEventListener('click', () => openRepoMenu());

function openRepoMenu() {
  let page = 1;
  let hasMore = false;
  let query = '';

  const modal = openModal({
    title: 'Choose a repository',
    renderBody: (m) => {
      m.body.innerHTML = `
        <input class="input" id="repo-search" placeholder="Filter repositories…" autocomplete="off" />
        <div class="list" id="repo-menu-list"><div class="empty">Loading…</div></div>`;
      const search = m.body.querySelector('#repo-search');
      search.focus();
      search.addEventListener(
        'input',
        debounce(() => {
          query = search.value.trim();
          page = 1;
          load();
        }, 300),
      );
      m.body.querySelector('#repo-menu-list').addEventListener('click', (e) => {
        const item = e.target.closest('[data-repo]');
        if (!item) return;
        $('#repo-input').value = item.dataset.repo;
        closeModal();
        loadRepo(item.dataset.repo);
      });
    },
    footer: [
      {
        label: 'Load more',
        onClick: async (_m, btn) => {
          page += 1;
          btn.disabled = true;
          await load(true);
          btn.disabled = false;
        },
      },
    ],
  });

  async function load(append = false) {
    const listEl = modal.body.querySelector('#repo-menu-list');
    const moreBtn = modal.foot.querySelector('button');
    if (!append) listEl.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const data = await api(`/api/repos?page=${page}&query=${encodeURIComponent(query)}`);
      hasMore = data.hasMore;
      if (moreBtn) moreBtn.hidden = !hasMore;
      const rows = data.repos
        .map(
          (r) => `<button class="list-item" type="button" data-repo="${escapeHtml(r.fullName)}">
            <span class="title">${escapeHtml(r.fullName)}</span>
            <span class="sub">${r.private ? 'private' : 'public'} · ${escapeHtml(shortDate(r.updatedAt))}</span>
          </button>`,
        )
        .join('');
      if (!append) {
        listEl.innerHTML = rows || '<div class="empty">No repository found for this filter.</div>';
      } else {
        listEl.insertAdjacentHTML('beforeend', rows);
      }
    } catch (err) {
      listEl.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  }

  load();
}

// ----------------------------------------------------------------- spec editor

const specEl = $('#spec-text');
specEl.value = localStorage.getItem(LS.spec) || '';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Parse the block in the browser. Works even when the server cannot be reached,
 * and stops us from calling /api/plan with a block that cannot parse anyway.
 */
function localParse() {
  const text = specEl.value;
  if (!text.trim()) {
    clearAlert($('#parse-errors'));
    clearAlert($('#parse-warnings'));
    return null;
  }
  const parsed = parseSpec(text);
  showAlert(
    $('#parse-errors'),
    parsed.errors.length ? 'Fix these errors before committing:' : '',
    parsed.errors.map((e) => `Line ${e.line}: ${e.message}`),
  );
  showAlert(
    $('#parse-warnings'),
    parsed.warnings.length ? 'Warnings:' : '',
    parsed.warnings.map((w) => `Line ${w.line}: ${w.message}`),
  );
  setStatus(
    $('#spec-meta'),
    `${plural(parsed.files.length, 'file')} · ${plural(parsed.errors.length, 'error')} · ${plural(
      parsed.warnings.length,
      'warning',
    )} · checked in your browser`,
  );
  return parsed;
}

const localParseSoon = debounce(() => {
  const parsed = localParse();
  if (!parsed || parsed.errors.length > 0) {
    state.plan = null;
    state.analysedHash = null;
    $('#plan-wrap').hidden = true;
    setStatus($('#analyze-status'), parsed ? 'Fix the errors above, then analyse.' : '');
    return;
  }
  scheduleRemoteAnalyse();
}, 250);

specEl.addEventListener('input', () => {
  localStorage.setItem(LS.spec, specEl.value);
  setStatus($('#analyze-status'), 'Unanalysed changes…');
  localParseSoon();
});

const debouncedAnalyse = debounce(() => analyse({ silent: true }), 1500);

/**
 * Never ask the server twice for the same thing: the auto-analysis used to fire
 * a POST on every pause while typing, which trips the write rate limiter.
 */
function scheduleRemoteAnalyse() {
  const hash = [state.repo?.fullName || '', state.base, $('#head-branch').value.trim(), specEl.value].join('\u0000');
  if (hash === state.analysedHash) return;
  debouncedAnalyse();
}

$('#toggle-syntax').addEventListener('click', () => {
  const help = $('#syntax-help');
  help.hidden = !help.hidden;
});

$('#clear-spec').addEventListener('click', () => {
  specEl.value = '';
  localStorage.setItem(LS.spec, '');
  state.plan = null;
  state.selected.clear();
  $('#plan-wrap').hidden = true;
  clearAlert($('#parse-errors'));
  clearAlert($('#parse-warnings'));
  setStatus($('#analyze-status'), '');
});

$('#insert-example').addEventListener('click', () => {
  insertAtCursor(EXAMPLE_SPEC);
});

// ------------------------------------------------- prompt to paste to an AI

let aiPromptCache = null;

function flash(btn, text) {
  const previous = btn.textContent;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = previous;
  }, 1800);
}

async function copyAiPrompt(btn) {
  try {
    if (!aiPromptCache) {
      const res = await fetch('ai-prompt.txt');
      if (!res.ok) throw new Error('prompt unavailable');
      aiPromptCache = await res.text();
    }
    await navigator.clipboard.writeText(aiPromptCache);
    flash(btn, 'Copied ✓');
  } catch {
    showPromptModal(aiPromptCache);
  }
}

function showPromptModal(text) {
  openModal({
    title: 'Prompt for an AI',
    renderBody: (m) => {
      m.body.innerHTML = `
        <p class="muted small">Copy this prompt, fill in <strong>CONTEXTE DE MON PROJET</strong> and
        <strong>MA DEMANDE</strong>, send it to your AI, then paste its whole answer in the box below.
        Only the fenced code blocks are used.</p>
        <textarea class="input mono" id="prompt-text" rows="20" readonly></textarea>`;
      const ta = m.body.querySelector('#prompt-text');
      ta.value = text || 'Prompt unavailable (public/ai-prompt.txt).';
      ta.focus();
      ta.select();
    },
    footer: [
      {
        label: 'Select all',
        onClick: (m) => {
          const ta = m.body.querySelector('#prompt-text');
          ta.focus();
          ta.select();
        },
      },
      {
        label: 'Copy',
        kind: 'primary',
        onClick: async (m, btn) => {
          const ta = m.body.querySelector('#prompt-text');
          try {
            await navigator.clipboard.writeText(ta.value);
            flash(btn, 'Copied ✓');
          } catch {
            ta.focus();
            ta.select();
          }
        },
      },
    ],
  });
}

const aiPromptBtn = document.createElement('button');
aiPromptBtn.className = 'btn ghost small';
aiPromptBtn.type = 'button';
aiPromptBtn.textContent = 'Copy AI prompt';
aiPromptBtn.addEventListener('click', () => copyAiPrompt(aiPromptBtn));
$('#insert-example').after(aiPromptBtn);

const EXAMPLE_SPEC = [
  '```python path=src/mathx/ops.py action=upsert',
  '"""Math helpers."""',
  '',
  '',
  'def add(a: float, b: float) -> float:',
  '    return a + b',
  '```',
  '',
  '```md path=docs/mathx.md action=upsert',
  '# mathx',
  '',
  'Documentation for the `mathx` module.',
  '```',
  '',
  '```py path=src/mathx/ops.py action=patch',
  '<<<<<<< SEARCH',
  '    return a + b',
  '=======',
  '    # sums two numbers',
  '    return a + b',
  '>>>>>>> REPLACE',
  '```',
  '',
].join('\n');

function fenceFor(content) {
  const longest = Math.max(0, ...(content.match(/`{3,}/g) || []).map((m) => m.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function insertAtCursor(text) {
  const ta = specEl;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  const pad = before === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  ta.value = before + pad + text + after;
  localStorage.setItem(LS.spec, ta.value);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = (before + pad + text).length;
  analyse();
}

function buildRewriteBlock(file) {
  const fence = fenceFor(file.content);
  return `${fence}${file.lang} path=${file.path} action=update\n${ensureNewline(file.content)}${fence}\n`;
}

function buildPatchBlock(file) {
  const fence = fenceFor(file.content);
  return (
    `${fence}${file.lang} path=${file.path} action=patch\n` +
    `<<<<<<< SEARCH\n${ensureNewline(file.content)}=======\n${ensureNewline(file.content)}>>>>>>> REPLACE\n${fence}\n`
  );
}

function ensureNewline(text) {
  return text && text.endsWith('\n') ? text : `${text || ''}\n`;
}

// ------------------------------------------------------------ existing files

$('#analyze-btn').addEventListener('click', () => analyse());

let fileBrowserBtn = null;

function ensureFileBrowserButton() {
  if (fileBrowserBtn) return fileBrowserBtn;
  fileBrowserBtn = document.createElement('button');
  fileBrowserBtn.className = 'btn ghost small';
  fileBrowserBtn.type = 'button';
  fileBrowserBtn.textContent = 'Edit an existing file…';
  fileBrowserBtn.addEventListener('click', openFileMenu);
  $('#clear-spec').after(fileBrowserBtn);
  return fileBrowserBtn;
}
ensureFileBrowserButton();

function openFileMenu() {
  if (!state.repo) return;
  const owner = state.repo.owner;
  const name = state.repo.name;
  let allFiles = [];
  let mode = 'patch';

  const modal = openModal({
    title: `Edit an existing file — ${owner}/${name}`,
    renderBody: (m) => {
      m.body.innerHTML = `
        <div class="row wrap">
          <label class="check"><input type="radio" name="edit-mode" value="patch" checked /><span>Insert as a search/replace patch (recommended)</span></label>
        </div>
        <div class="row wrap">
          <label class="check"><input type="radio" name="edit-mode" value="rewrite" /><span>Insert as a full rewrite of the file</span></label>
        </div>
        <input class="input" id="file-search" placeholder="Filter files (e.g. src/api or .ts)" autocomplete="off" />
        <div class="list" id="file-menu-list"><div class="empty"><span class="spinner"></span> Loading the file tree…</div></div>`;
      m.body.querySelectorAll('input[name="edit-mode"]').forEach((r) => {
        r.addEventListener('change', () => {
          mode = r.value;
        });
      });
      const search = m.body.querySelector('#file-search');
      search.focus();
      search.addEventListener('input', () => renderList(search.value.trim().toLowerCase()));
      m.body.querySelector('#file-menu-list').addEventListener('click', async (e) => {
        const item = e.target.closest('[data-file]');
        if (!item) return;
        const path = item.dataset.file;
        item.querySelector('.sub').innerHTML = '<span class="spinner"></span>';
        try {
          const file = await api(
            `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/file?ref=${encodeURIComponent(
              state.base,
            )}&path=${encodeURIComponent(path)}`,
          );
          closeModal();
          insertAtCursor(mode === 'patch' ? buildPatchBlock(file) : buildRewriteBlock(file));
        } catch (err) {
          item.querySelector('.sub').textContent = err.message;
        }
      });
    },
    footer: [],
  });

  function renderList(filter = '') {
    const listEl = modal.body.querySelector('#file-menu-list');
    const matches = allFiles.filter((f) => !filter || f.path.toLowerCase().includes(filter));
    const shown = matches.slice(0, 200);
    listEl.innerHTML =
      shown
        .map(
          (f) => `<button class="list-item" type="button" data-file="${escapeHtml(f.path)}">
            <span class="title">${escapeHtml(f.path)}</span>
            <span class="sub">${escapeHtml(f.lang)}</span>
          </button>`,
        )
        .join('') ||
      `<div class="empty">${allFiles.length ? 'No file matches this filter.' : 'No file found on this branch.'}</div>`;
    if (matches.length > shown.length) {
      listEl.insertAdjacentHTML('beforeend', `<div class="empty">+ ${matches.length - shown.length} more, refine the filter</div>`);
    }
  }

  (async () => {
    try {
      if (!state.treeCache) {
        state.treeCache = await api(
          `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tree?ref=${encodeURIComponent(
            state.base,
          )}&limit=2000`,
        );
      }
      allFiles = state.treeCache.files || [];
      renderList();
    } catch (err) {
      const listEl = modal.body.querySelector('#file-menu-list');
      if (listEl) listEl.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    }
  })();
}

// ----------------------------------------------------------------- analyse

async function analyse({ silent = false } = {}) {
  if (!state.repo || !specEl.value.trim()) {
    state.plan = null;
    $('#plan-wrap').hidden = true;
    clearAlert($('#parse-errors'));
    clearAlert($('#parse-warnings'));
    setStatus($('#analyze-status'), '');
    return;
  }
  const statusEl = $('#analyze-status');
  if (!silent) setStatus(statusEl, 'Analysing…', true);
  clearAlert($('#parse-errors'));
  clearAlert($('#parse-warnings'));
  state.analysedHash = [state.repo?.fullName || '', state.base, $('#head-branch').value.trim(), specEl.value].join('\u0000');
  try {
    const data = await api('/api/plan', {
      method: 'POST',
      body: {
        repo: state.repo.fullName,
        ref: state.base,
        branch: $('#head-branch').value.trim() || null,
        text: specEl.value,
      },
    });

    state.plan = data;
    state.selected = new Set(
      data.items.filter((i) => !i.error && i.resolved !== 'skip').map((i) => i.path),
    );

    const errs = [...(data.errors || []).map((e) => `Line ${e.line}: ${e.message}`)];
    showAlert($('#parse-errors'), data.errors?.length ? 'Fix these errors before committing:' : '', errs);
    showAlert(
      $('#parse-warnings'),
      data.warnings?.length ? 'Warnings:' : '',
      (data.warnings || []).map((w) => `Line ${w.line}: ${w.message}`),
    );

    // Front matter can drive the branch / PR metadata.
    if (data.meta?.branch) {
      const wanted = data.meta.branch;
      if (state.repo.branches.some((b) => b.name === wanted)) {
        $('#base-branch').value = wanted;
        state.base = wanted;
      }
    }
    if (data.meta?.prTitle && !$('#pr-title').value) $('#pr-title').value = data.meta.prTitle;
    if (data.meta?.prBody && !$('#pr-body').value) $('#pr-body').value = data.meta.prBody;
    if (data.meta?.draft) $('#pr-draft').checked = true;
    if (data.meta?.commitMessage && !$('#commit-message').value) $('#commit-message').value = data.meta.commitMessage;

    renderPlan(data);
    setStatus(
      statusEl,
      data.summary.total === 0
        ? 'No file found in the block.'
        : `${data.summary.create} to create · ${data.summary.update} to modify · ${data.summary.delete} to delete · ${data.summary.skip} unchanged (compared with ${data.planRef})`,
    );
  } catch (err) {
    state.plan = null;
    $('#plan-wrap').hidden = true;
    // Never hide the reason: an opaque "Analysis failed" is what makes a 403 or
    // a rate limit look like a broken block.
    showAlert($('#parse-errors'), err.message);
    setStatus(statusEl, 'Analysis failed — see the message above');
  }
}

function renderPlan(plan) {
  const wrap = $('#plan-wrap');
  wrap.hidden = false;
  const s = plan.summary;
  $('#plan-summary').innerHTML = [
    badge(`${s.create} create`, 'create'),
    badge(`${s.update} modify`, 'update'),
    badge(`${s.delete} delete`, 'delete'),
    badge(`${s.skip} unchanged`, 'skip'),
    badge(`+${s.additions} / -${s.deletions}`),
  ].join('');

  const list = $('#plan-list');
  list.innerHTML = '';

  for (const item of plan.items) {
    const el = document.createElement('div');
    el.className = `plan-item${state.selected.has(item.path) ? ' selected' : ''}`;

    const disabled = Boolean(item.error) || item.resolved === 'skip';
    const checked = state.selected.has(item.path) && !disabled;
    const actionLabel =
      item.resolved === 'update' && item.requestedAction === 'patch' ? 'patch' : item.resolved;

    el.innerHTML = `
      <div class="plan-row">
        <input type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} data-path="${escapeHtml(
          item.path,
        )}" aria-label="Include ${escapeHtml(item.path)}" />
        <span class="path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</span>
        ${badge(item.lang)}
        ${badge(actionLabel, actionLabel)}
        ${
          item.resolved === 'skip'
            ? '<span class="stats muted">up to date</span>'
            : `<span class="stats"><span class="stat-add">+${item.additions}</span> <span class="stat-del">-${item.deletions}</span></span>`
        }
        ${item.diff ? `<button class="btn ghost small" data-diff="${escapeHtml(item.path)}">Diff</button>` : ''}
      </div>`;

    if (item.error) {
      el.insertAdjacentHTML('beforeend', `<div class="item-error">${escapeHtml(item.error)}</div>`);
    }
    if (item.diff && state.openDiffs.has(item.path)) {
      el.insertAdjacentHTML('beforeend', renderDiff(item.diff));
    }

    const cb = el.querySelector('input[type="checkbox"]');
    cb?.addEventListener('change', () => {
      if (cb.checked) state.selected.add(item.path);
      else state.selected.delete(item.path);
      el.classList.toggle('selected', cb.checked);
      updateCommitButton();
    });

    const diffBtn = el.querySelector('[data-diff]');
    diffBtn?.addEventListener('click', () => {
      if (state.openDiffs.has(item.path)) state.openDiffs.delete(item.path);
      else state.openDiffs.add(item.path);
      renderPlan(state.plan);
    });

    list.appendChild(el);
  }

  if (!plan.items.length) {
    list.innerHTML = '<div class="empty">No file detected in the block.</div>';
  }

  updateCommitButton();
}

function renderDiff(patch) {
  const lines = String(patch)
    .split('\n')
    .filter((l, i, arr) => !(i >= arr.length - 1 && l === ''))
    .slice(0, 4 + 2000);
  const body = lines
    .slice(4)
    .map((line) => {
      const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
      return `<span class="${cls}">${escapeHtml(line)}</span>`;
    })
    .join('');
  return `<pre class="diff">${body || '<span class="ctx">(no textual change)</span>'}</pre>`;
}

function updateCommitButton() {
  const btn = $('#commit-btn');
  const count = state.selected.size;
  btn.disabled = count === 0 || !state.repo;
  btn.textContent = count
    ? `Commit ${count} file${count > 1 ? 's' : ''} to ${state.branch || 'new branch'}`
    : 'Nothing to commit';
}

// ------------------------------------------------------------------ commit

$('#commit-btn').addEventListener('click', async () => {
  const btn = $('#commit-btn');
  const statusEl = $('#commit-status');
  btn.disabled = true;
  setStatus(statusEl, 'Committing…', true);
  try {
    const message = $('#commit-message').value.trim() || defaultCommitMessage();
    const data = await api('/api/apply', {
      method: 'POST',
      body: {
        repo: state.repo.fullName,
        base: state.base,
        branch: $('#head-branch').value.trim(),
        commitMessage: message,
        text: specEl.value,
        paths: [...state.selected],
      },
    });
    state.commit = data;
    setStatus(
      statusEl,
      `Committed ${data.files.length} file(s) on ${data.branch} (${data.commit.sha.slice(0, 7)})`,
    );
    $('#commit-result').hidden = false;
    $('#commit-result').innerHTML = `Branch <strong>${escapeHtml(data.branch)}</strong> updated with commit
      <a href="${escapeHtml(data.commit.url)}" target="_blank" rel="noreferrer">${escapeHtml(
        data.commit.sha.slice(0, 7),
      )}</a>${data.skipped?.length ? ` · skipped (already up to date): ${escapeHtml(data.skipped.join(', '))}` : ''}`;
    setStepEnabled(4, true);
    if (!$('#pr-title').value) $('#pr-title').value = defaultPrTitle(data);
    await analyse({ silent: true });
    if (!$('#pr-body').value) $('#pr-body').value = defaultPrBody(data);
    setStepEnabled(5, false);
  } catch (err) {
    setStatus(statusEl, '');
    showAlert($('#parse-errors'), err.message, err.details?.errors?.map((e) => `${e.path}: ${e.message}`));
  } finally {
    btn.disabled = false;
    updateCommitButton();
  }
});

function defaultCommitMessage() {
  const s = state.plan?.summary;
  if (!s) return 'Update files';
  const parts = [];
  if (s.create) parts.push(`add ${s.create} file(s)`);
  if (s.update) parts.push(`update ${s.update} file(s)`);
  if (s.delete) parts.push(`remove ${s.delete} file(s)`);
  return `chore: ${parts.join(', ') || 'update files'}`;
}

function defaultPrTitle(data) {
  const first = data.files[0];
  if (!first) return 'Update files';
  if (data.files.length === 1) {
    const verb = { create: 'Add', update: 'Update', delete: 'Remove' }[first.action] || 'Update';
    return `${verb} ${first.path.split('/').pop()}`;
  }
  return `Update ${data.files.length} files`;
}

function defaultPrBody(data) {
  const rows = data.files
    .map((f) => `| \`${f.path}\` | ${f.action} | +${f.additions} / -${f.deletions} |`)
    .join('\n');
  return [
    '### Changes',
    '',
    '| File | Action | Diff |',
    '| --- | --- | --- |',
    rows,
    '',
    `Committed by GitHub Text Updater on \`${data.branch}\`.`,
  ].join('\n');
}

// --------------------------------------------------------------------- PR

$('#pr-btn').addEventListener('click', async () => {
  const btn = $('#pr-btn');
  const statusEl = $('#pr-status');
  clearAlert($('#pr-error'));
  btn.disabled = true;
  setStatus(statusEl, 'Opening the pull request…', true);
  try {
    const data = await api('/api/pulls', {
      method: 'POST',
      body: {
        repo: state.repo.fullName,
        base: state.base,
        head: $('#head-branch').value.trim(),
        title: $('#pr-title').value.trim() || defaultPrTitle(state.commit || { files: [] }),
        body: $('#pr-body').value,
        draft: $('#pr-draft').checked,
      },
    });
    state.pr = data.pullRequest;
    setStatus(statusEl, data.alreadyExists ? 'Reusing the existing pull request.' : `Pull request #${state.pr.number} opened.`);
    setStepEnabled(5, true);
    renderPrCard(state.pr);
    refreshPrStatus();
  } catch (err) {
    setStatus(statusEl, '');
    showAlert($('#pr-error'), err.message);
  } finally {
    btn.disabled = false;
  }
});

function renderPrCard(pr, extra) {
  const card = $('#pr-card');
  card.hidden = false;
  const stateLabel = pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state;
  card.innerHTML = `
    <div class="pr-title"><a href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">${escapeHtml(
      pr.title,
    )}</a></div>
    <div class="pr-meta">
      <span class="state ${escapeHtml(stateLabel)}">${escapeHtml(stateLabel)}</span>
      <span>#${pr.number}</span>
      <span>${escapeHtml(pr.head)} &rarr; ${escapeHtml(pr.base)}</span>
      <span>+${pr.additions} / -${pr.deletions} across ${pr.changedFiles} file(s)</span>
    </div>
    ${extra ? `<div class="pr-meta">${extra}</div>` : ''}`;
}

$('#refresh-pr').addEventListener('click', () => refreshPrStatus());

async function refreshPrStatus() {
  if (!state.pr) return;
  const statusEl = $('#merge-status');
  setStatus(statusEl, 'Checking mergeability…', true);
  try {
    const data = await api(
      `/api/pulls/${encodeURIComponent(state.repo.owner)}/${encodeURIComponent(state.repo.name)}/${state.pr.number}`,
    );
    state.pr = { ...state.pr, ...data.pullRequest };
    const checks = [];
    if (data.checks?.total) {
      const buckets = Object.entries(data.checks.buckets || {})
        .map(([k, v]) => `${v} ${k}`)
        .join(', ');
      checks.push(`<span>${escapeHtml(buckets)} (${data.checks.total} check run(s))</span>`);
    }
    if (data.status?.total) {
      checks.push(`<span>status: ${escapeHtml(data.status.state)} (${data.status.total})</span>`);
    }
    const mergeableText =
      data.pullRequest.mergeable === null
        ? 'mergeability is still being computed'
        : data.pullRequest.mergeable
          ? `mergeable state: ${data.pullRequest.mergeableState}`
          : 'has conflicts with the base branch';

    renderPrCard(state.pr, `<span>${escapeHtml(mergeableText)}</span>${checks.join('')}`);
    $('#merge-btn').disabled = Boolean(data.pullRequest.merged) || data.pullRequest.state === 'closed';
    setStatus(statusEl, '');
  } catch (err) {
    setStatus(statusEl, '');
    showAlert($('#merge-error'), err.message);
  }
}

$('#merge-btn').addEventListener('click', async () => {
  const btn = $('#merge-btn');
  clearAlert($('#merge-error'));
  clearAlert($('#merge-result'));
  const statusEl = $('#merge-status');
  btn.disabled = true;
  setStatus(statusEl, 'Merging…', true);
  try {
    const data = await api(
      `/api/pulls/${encodeURIComponent(state.repo.owner)}/${encodeURIComponent(state.repo.name)}/${
        state.pr.number
      }/merge`,
      {
        method: 'POST',
        body: {
          mergeMethod: $('#merge-method').value,
          deleteBranch: $('#delete-branch').checked,
          commitTitle: $('#merge-title').value.trim(),
        },
      },
    );
    state.pr = data.pullRequest;
    $('#merge-result').hidden = false;
    $('#merge-result').innerHTML = data.alreadyMerged
      ? 'This pull request was already merged.'
      : `Merged as <span class="mono">${escapeHtml((data.merge?.sha || '').slice(0, 7))}</span>${
          data.branchDeleted ? ' · branch deleted' : ''
        }. <a href="${escapeHtml(state.pr.url)}" target="_blank" rel="noreferrer">View the pull request</a>`;
    setStatus(statusEl, '');
    renderPrCard(state.pr, '<span>merged</span>');
  } catch (err) {
    setStatus(statusEl, '');
    showAlert($('#merge-error'), err.message);
  } finally {
    btn.disabled = false;
    refreshPrStatus();
  }
});

// --------------------------------------------------------------------- boot

setStepEnabled(2, false);
setStepEnabled(3, false);
setStepEnabled(4, false);
setStepEnabled(5, false);
setStatus($('#spec-meta'), 'Analysed as you type ·');
if (specEl.value.trim()) localParse();
loadSession();
