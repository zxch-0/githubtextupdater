# GitHub Text Updater

Paste a text block that describes files, and this tool creates or edits them in a GitHub repository,
opens a pull request and merges it — from a single web page, deployed on Render with a Blueprint.

````markdown
```python path=src/mathx/ops.py action=upsert
def add(a, b):
    return a + b
```
````

---

## 🇫🇷 Démarrage rapide

1. **Déployer** : sur GitHub, ouvrez ce dépôt puis *Dashboard Render → New → Blueprint* et sélectionnez
   le dépôt. Render lit `render.yaml`, installe les dépendances et génère `SESSION_SECRET` automatiquement.
2. **Ouvrir le service** et coller un **Personal Access Token** GitHub :
   - *fine-grained* : accès au dépôt + **Contents: read & write**, **Pull requests: read & write**, **Metadata: read-only**
   - ou *classic* : scope `repo` (+ `workflow` si vous modifiez des fichiers `.github/workflows/`).
3. **Choisir le dépôt** (menu de recherche ou `owner/name`) et la branche de base.
4. **Coller le bloc de texte** (voir le format ci-dessous). Le bloc est vérifié **dans votre navigateur**
   (erreurs et avertissements immédiats, sans appel réseau), puis analysé côté serveur qui affiche le diff
   fichier par fichier.
5. **Commit → Open pull request → Merge** (bouton manuel, avec *merge / squash / rebase*).

> **Si l'analyse échoue**, le message dit toujours pourquoi : statut HTTP, route appelée, extrait de la
> réponse (quota GitHub épuisé, token sans accès en écriture, instance Render en train de démarrer…).
> Aucun « Analysis failed » sans explication.

Le token est chiffré (AES-256-GCM) dans un cookie `httpOnly` côté serveur : il ne retourne jamais au navigateur.

---

## What it does

| Step | What happens |
| --- | --- |
| 1. Connect | You paste a PAT. It is validated against `GET /user` and stored encrypted in an httpOnly cookie. |
| 2. Repository | Pick a repo from the searchable menu (or type `owner/name`), pick the base branch, name the new branch. |
| 3. Block | Paste the specification. It is parsed, validated, and compared with the target branch: per-file action, diff, `+/-` stats. |
| 4. Commit | One commit containing every selected file (GitHub Git Data API: tree → commit → ref). |
| 5. Pull request | Open the PR (title/body/draft), then check its status (checks, mergeability). |
| 6. Merge | Manual button: `merge`, `squash` or `rebase`, optional branch deletion. Conflicts and branch protections are reported. |

Everything goes through the server: the browser never talks to api.github.com directly.

---

## Deploy on Render (Blueprint)

`render.yaml` declares one web service:

```yaml
services:
  - type: web
    name: github-text-updater
    runtime: node
    plan: free
    region: frankfurt
    healthCheckPath: /healthz
    buildCommand: npm ci
    startCommand: npm start
    envVars:
      - key: SESSION_SECRET
        generateValue: true
      # …
```

Steps: **Render Dashboard → New → Blueprint → connect `zxch-0/githubtextupdater`**. Render creates the
service, generates `SESSION_SECRET` and starts it. The free plan spins the instance down when idle —
the first request after an idle period takes a few seconds.

### Local development

```bash
npm install
cp .env.example .env      # set SESSION_SECRET
npm run dev               # http://localhost:3000
npm test                  # parser / planner / session unit tests
```

Environment variables (all optional except `SESSION_SECRET` in production):

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | insecure dev fallback | Encrypts the session cookie (32+ random bytes recommended) |
| `PORT` | `3000` | HTTP port (Render sets `10000`) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `MAX_SPEC_BYTES` | `4194304` | Max size of the pasted block |
| `MAX_FILES` | `200` | Max number of files per block |
| `MAX_FILE_BYTES` | `1048576` | Max size of one file body |
| `GITHUB_API_BASE` | `https://api.github.com` | Point to a GitHub Enterprise instance |
| `SESSION_TTL_MS` | `28800000` | Session lifetime (8 h) |

---

## The text block format

One **fenced code block per file**. The destination path lives in the info string of the fence:

````markdown
```python path=src/mathx/ops.py action=upsert
def add(a, b):
    return a + b
```
````

### Info string

| Key | Values | Notes |
| --- | --- | --- |
| `path=` | any repo-relative path | **Required.** Aliases: `file=`, `filename=`, `src=`, `title=`, `name=`, or the bare path as the first word (```js src/app.js). |
| `action=` | `upsert` (default), `create`, `update`, `append`, `prepend`, `patch`, `delete` | See below. |
| `lang=` | any language name | Optional: taken from the fence, otherwise guessed from the extension (cosmetic only). |
| `exec`, `mode=755` | flag | Makes a newly created file executable (`100755`). |

Paths are normalised (`./src//a.py` → `src/a.py`, `src\win\a.py` → `src/win/a.py`,
`blob/main/src/a.py` → `src/a.py`) and validated: no `..`, no absolute path, nothing inside `.git/`.

### Actions

| Action | Behaviour |
| --- | --- |
| `upsert` | Create if missing, replace if present (default). |
| `create` | Fail if the file already exists. |
| `update` | Replace an existing file; fail if it is missing. |
| `append` / `prepend` | Add the block to the existing content (creates the file if missing). |
| `patch` | Surgical **search/replace** edit of an existing file (see below). |
| `delete` | Remove the file (the body is ignored). |

Files whose content is already identical are detected and skipped ("unchanged").

### Editing an existing file

Two ways:

1. **Full rewrite** — `action=update` (or `upsert`) with the complete new content.
2. **Search/replace patch** — `action=patch` with one or more sections inside the block:

````markdown
```python path=src/mathx/ops.py action=patch
<<<<<<< SEARCH
def add(a, b):
    return a + b
=======
def add(a: float, b: float) -> float:
    """Sum two numbers."""
    return a + b
>>>>>>> REPLACE
```
````

Rules: each `SEARCH` block must match **exactly once** (0 → error "not found", 2+ → error "matches N places").
An empty `REPLACE` section deletes those lines. Several sections can be chained in one block.

The **“Edit an existing file…”** button in step 3 browses the branch, fetches the file and inserts it
either as a ready-to-edit patch (the current content is placed on both sides) or as a full rewrite block.

> `append`, `prepend` and `patch` are resolved against the branch you are committing to, so committing
> several times to the same branch stays cumulative.

### Optional front matter

Add it at the very top of the paste to pre-fill the form:

```markdown
---
repo: owner/name
branch: main
pr_title: Add math helpers
pr_body: |
  Multi-line description.
commit_message: feat: add math helpers
draft: false
---
```

### Complete example

````markdown
---
repo: acme/widgets
branch: main
pr_title: Add math helpers and docs
---

```python path=src/mathx/ops.py action=create
def add(a, b):
    return a + b
```

```python path=src/mathx/__init__.py action=upsert
from .ops import add
```

```md path=docs/mathx.md action=upsert
# mathx

Documentation for the `mathx` module.
```

```python path=src/mathx/ops.py action=patch
<<<<<<< SEARCH
    return a + b
=======
    # sums two numbers
    return a + b
>>>>>>> REPLACE
```

```sh path=scripts/deploy.sh action=create mode=755
#!/usr/bin/env sh
echo "deploying"
```

```txt path=legacy/notes.txt action=delete
```
````

---

## Getting the code from an AI

`public/ai-prompt.txt` (also available from the **“Copy AI prompt”** button in step 3) is a ready-made
prompt you can paste to ChatGPT/Claude/Gemini: it forces the model to answer **only** with blocks in
the expected format, so the answer can be pasted straight into the tool.

`prompts/ai-request.md` documents it, with a filled-in example (Next.js health endpoint + hook +
component + patch of an existing layout) and the exact answer the AI should produce.

Typical loop: **Copy AI prompt → fill in the project context and the request → paste the AI answer in
step 3 → uncheck what you do not want → Commit → Open PR → Merge.**

---

## HTTP API

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Health check (used by Render) |
| `GET/POST/DELETE` | `/api/session` | Current session / connect with a token / disconnect |
| `GET` | `/api/repos?query=&page=` | Repositories you can push to |
| `GET` | `/api/repos/:owner/:repo` | Repo metadata + branches |
| `GET` | `/api/rate-limit` | Remaining GitHub quota for the connected token |
| `GET` | `/api/repos/:owner/:repo/tree?ref=&query=` | File list (for the editor) |
| `GET` | `/api/repos/:owner/:repo/file?ref=&path=` | Fetch an existing file |
| `POST` | `/api/plan` | Parse + compare the block with the branch |
| `POST` | `/api/apply` | Create the commit on the working branch |
| `POST` | `/api/pulls` | Open the pull request |
| `GET` | `/api/pulls/:owner/:repo/:n` | PR state, checks, mergeability |
| `POST` | `/api/pulls/:owner/:repo/:n/merge` | Merge it |

Errors are returned as `{ "error": { "code", "message", "details" } }` with a meaningful HTTP status.

---

## Troubleshooting

| Symptom | Meaning | What to do |
| --- | --- | --- |
| `HTTP 403 on GET /api/…` | GitHub refused the request. | Check the quota shown in step 1 (or `GET /api/rate-limit`): if it is exhausted, wait for the reset. Otherwise the token lacks **Contents/Pull requests** write permission on that repo, or the organisation requires **SSO authorisation** for the token. |
| `Too many requests` (429) | Primary or secondary GitHub rate limit. | Wait the announced delay (a `Retry-After` header is sent) and retry. Each page refresh only costs a few calls; the heaviest operation is the plan (one tree + one blob per file). |
| `HTTP 502/503/504` | The Render instance is waking up or GitHub is unavailable. | The UI retries automatically twice. On the free plan the first request after ~15 min of inactivity can take 30-60 s. |
| `HTTP 401` / session lost | The token was revoked, the session expired after 8 h, or `SESSION_SECRET` changed. | Reconnect in step 1. Never regenerate `SESSION_SECRET` unless you want to log everyone out. |
| `Nothing to commit` | Every file is already identical on the target branch. | Expected: the block is idempotent. Change the content or the branch. |
| `SEARCH block not found` | The `action=patch` block does not match the file byte for byte. | Use **Edit an existing file…** to copy the exact lines (indentation included). |
| `The file already exists` with `action=create` | Safety net against overwriting. | Use `upsert`, or `update` to rewrite it. |

Every error message now contains the HTTP status, the endpoint called and — when the answer is not
JSON — a snippet of the raw body, so a response coming from the host (Render) instead of the app is
immediately visible.

---

## Security notes

* The PAT is encrypted with **AES-256-GCM** (key derived from `SESSION_SECRET`) and stored in an
  `httpOnly`, `SameSite=Lax`, `Secure` cookie. It is never logged (the logger redacts anything that
  looks like a token) and never exposed to JavaScript.
* The browser only talks to this server; all GitHub calls are made server-side.
* Requests are rate limited per IP (240 reads / 60 writes per minute by default).
* Paths are re-validated server-side on every commit: `..`, absolute paths, `.git/` and duplicate
  entries are rejected.
* Use a **fine-grained token limited to the repositories you need**, and revoke it when you are done.

## Limitations

* Text files only: binary files can be deleted but not edited or diffed.
* 1 MiB per file, 200 files and 4 MiB per paste by default (configurable).
* Very large repositories: the recursive tree can be truncated by GitHub, in which case filter files
  by name rather than browsing the whole tree.
* Merging requires the token to satisfy the branch protection rules (reviews, required checks) —
  otherwise GitHub refuses and the reason is shown in the UI.

## Tests

```bash
npm test
```

Covers the specification parser (paths, actions, patch blocks, front matter, error reporting), the
planner (create/update/append/prepend/patch/delete resolution, diffs, statistics) and the session
cookie encryption.
