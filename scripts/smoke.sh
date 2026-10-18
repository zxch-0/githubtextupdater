#!/usr/bin/env bash
#
# End-to-end smoke test against a running instance (local or deployed).
#
#   BASE_URL=http://localhost:3000 \
#   GITHUB_TOKEN=ghp_xxx \
#   REPO=owner/name \
#   BASE_BRANCH=main \
#   ./scripts/smoke.sh
#
# It creates a temporary branch (tmp/gtu-smoke-*), appends a file to it with
# action=append, opens a pull request against BASE_BRANCH, merges it (squash)
# and finally deletes the temporary branch. Nothing is merged into your default
# branch unless you point BASE_BRANCH at it.
#
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
REPO="${REPO:?set REPO=owner/name}"
BASE_BRANCH="${BASE_BRANCH:-main}"
GITHUB_TOKEN="${GITHUB_TOKEN:?set GITHUB_TOKEN=...}"
HEAD_BRANCH="tmp/gtu-smoke-$(date +%s)"
COOKIES="$(mktemp)"
trap 'rm -f "$COOKIES"' EXIT

api() { # api METHOD PATH [json]
  local method="$1" path="$2" data="${3-}"
  if [ -n "$data" ]; then
    curl -fsS -b "$COOKIES" -c "$COOKIES" -X "$method" "$BASE_URL$path" \
      -H 'content-type: application/json' --data-binary "$data"
  else
    curl -fsS -b "$COOKIES" -c "$COOKIES" -X "$method" "$BASE_URL$path"
  fi
}

echo "== health =="
curl -fsS "$BASE_URL/healthz"; echo

echo "== connect =="
api POST /api/session "$(jq -nc --arg t "$GITHUB_TOKEN" '{token:$t}')"; echo

spec=$(cat <<EOF
\`\`\`txt path=tmp-gtu-smoke.txt action=append
smoke test $(date -u +%FT%TZ)
\`\`\`
EOF
)

echo "== plan =="
api POST /api/plan "$(jq -nc --arg r "$REPO" --arg b "$BASE_BRANCH" --arg h "$HEAD_BRANCH" --arg s "$spec" \
  '{repo:$r, ref:$b, branch:$h, text:$s}')" | jq '{planRef, summary}'

echo "== apply =="
api POST /api/apply "$(jq -nc --arg r "$REPO" --arg b "$BASE_BRANCH" --arg h "$HEAD_BRANCH" --arg s "$spec" \
  '{repo:$r, base:$b, branch:$h, commitMessage:"chore: smoke test", text:$s}')" | jq '{branch, branchExisted, commit}'

echo "== pull request =="
pr=$(api POST /api/pulls "$(jq -nc --arg r "$REPO" --arg b "$BASE_BRANCH" --arg h "$HEAD_BRANCH" \
  '{repo:$r, base:$b, head:$h, title:"chore: smoke test", body:"Opened by scripts/smoke.sh", draft:false}')")
echo "$pr" | jq '.pullRequest | {number, url, state}'
number=$(echo "$pr" | jq -r '.pullRequest.number')

owner="${REPO%%/*}"
name="${REPO##*/}"

echo "== status =="
api GET "/api/pulls/$owner/$name/$number" | jq '{canMerge, mergeableState: .pullRequest.mergeableState}'

echo "== merge =="
api POST "/api/pulls/$owner/$name/$number/merge" '{"mergeMethod":"squash","deleteBranch":true}' | jq '{merged, branchDeleted}'

echo "== cleanup =="
curl -fsS -X DELETE -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$owner/$name/git/refs/heads/$HEAD_BRANCH" > /dev/null 2>&1 \
  && echo "branch $HEAD_BRANCH deleted" || echo "branch already deleted"

echo "SMOKE TEST OK"
