#!/usr/bin/env bash
#
# setup-branch-protection — apply the required branch-protection rules
# for the Uni-CLI `main` branch.
#
# Usage:
#   bash scripts/setup-branch-protection.sh           # apply
#   DRY_RUN=1 bash scripts/setup-branch-protection.sh # print, no POST
#
# Requires: gh CLI authenticated as a repo admin (`gh auth status`).
# See contributing/branch-protection.md for the full rule set.

set -euo pipefail

REPO="${REPO:-olo-dot-io/Uni-CLI}"
BRANCH="${BRANCH:-main}"

# Keep this list in lock-step with contributing/branch-protection.md.
# Status-check names must match the `name:` attribute (or the job name
# fallback) surfaced in GitHub Checks.
REQUIRED_CHECKS=(
  "PR Title"
  "Verify (ubuntu-latest / Node 22)"
  "Verify (ubuntu-latest / Node 20)"
  "Verify (macos-14 / Node 22)"
  "Verify (macos-14 / Node 20)"
  "Verify (windows-latest / Node 22)"
  "Adapter Tests"
  "Docs Build"
  "Verify Changesets"
)

# Build JSON body. We use python3 for safe JSON encoding of names
# containing slashes/parens. If python3 is not on PATH, fall back to
# jq; both are universally available on maintainer machines.
if command -v python3 >/dev/null 2>&1; then
  CONTEXTS_JSON=$(
    python3 -c '
import json, sys
names = sys.argv[1:]
print(json.dumps(names))
' "${REQUIRED_CHECKS[@]}"
  )
elif command -v jq >/dev/null 2>&1; then
  CONTEXTS_JSON=$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | jq -R . | jq -s .)
else
  echo "setup-branch-protection: requires python3 or jq on PATH" >&2
  exit 1
fi

BODY=$(cat <<EOF
{
  "required_status_checks": {
    "strict": true,
    "contexts": ${CONTEXTS_JSON}
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "block_creations": false,
  "required_conversation_resolution": true
}
EOF
)

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "Would PUT repos/${REPO}/branches/${BRANCH}/protection with body:"
  echo "${BODY}" | python3 -m json.tool 2>/dev/null || echo "${BODY}"
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "setup-branch-protection: gh CLI not found on PATH" >&2
  exit 1
fi

echo "Applying branch protection on ${REPO}:${BRANCH} ..."
echo "${BODY}" | gh api \
  -X PUT \
  "repos/${REPO}/branches/${BRANCH}/protection" \
  -H "Accept: application/vnd.github+json" \
  --input -

echo "Done. Verify with: gh api repos/${REPO}/branches/${BRANCH}/protection"
