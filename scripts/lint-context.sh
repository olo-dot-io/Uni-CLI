#!/usr/bin/env bash
#
# Context lint — score AGENTS.md / CLAUDE.md / skills / docs against the
# Agent Lint quality rubric (12 dimensions: skills 6, agents 5, workflows 5+).
#
# Resolution order — first hit wins:
#   1. `agent-lint` on PATH (globally installed)
#   2. ref/agentlint/packages/cli/dist/index.js (vendored + built)
#   3. Soft skip with a warning (does NOT fail verify)
#
# We deliberately do NOT fall back to `npx @agent-lint/cli` because npx will
# attempt to install the package on first run, which silently fetches code
# from npm during `npm run verify`. The vendored or globally-installed paths
# are explicit enough that the user knows what they're running.
#
# Threshold: any artifact scoring < 60/100 fails the lint. Threshold checking
# requires `jq`; without `jq` the script just prints the agent-lint output and
# exits 0 (still useful, just no machine threshold gate).
#
# Override the threshold via UNICLI_LINT_THRESHOLD (env). Set
# UNICLI_LINT_DISABLE=1 to skip entirely (e.g. for CI runners that have no
# Node available).

set -u
cd "$(dirname "$0")/.." || exit 1

THRESHOLD="${UNICLI_LINT_THRESHOLD:-60}"

# ── Retired claim guard ────────────────────────────────────────────────────
# The "~80 tokens per call" figure conflated the invocation string length
# with the full response payload (measured at 15-25x that). It was retired
# in v0.212 Phase 0.5 in favour of docs/BENCHMARK.md. Fail fast if it
# resurfaces in any tracked, shippable surface. The check scans only paths
# we own publicly; local-only paths (.claude/, ref/) are exempt.
RETIRED_PATTERN='~80 token\|80 tokens per\|~80_tokens\|80_tokens'
RETIRED_PATHS=(README.md AGENTS.md DESIGN.md docs src)
RETIRED_HITS=$(grep -RIn --exclude-dir=node_modules --exclude-dir=dist \
  "$RETIRED_PATTERN" "${RETIRED_PATHS[@]}" 2>/dev/null || true)
if [ -n "$RETIRED_HITS" ]; then
  echo "context-lint: FAIL — retired '~80 tokens per call' claim found:"
  echo "$RETIRED_HITS"
  echo "  reference docs/BENCHMARK.md instead (retired 2026-04-15)."
  exit 1
fi

if [ "${UNICLI_LINT_DISABLE:-0}" = "1" ]; then
  echo "context-lint: disabled via UNICLI_LINT_DISABLE=1"
  exit 0
fi

# Resolve the runner command
RUNNER=""
if command -v agent-lint >/dev/null 2>&1; then
  RUNNER="agent-lint"
elif [ -f ref/agentlint/packages/cli/dist/index.js ]; then
  RUNNER="node ref/agentlint/packages/cli/dist/index.js"
fi

if [ -z "$RUNNER" ]; then
  echo "context-lint: agent-lint not installed — skipping (soft pass)"
  echo "  install with:  npm i -g @agent-lint/cli"
  echo "  or build vendored: (cd ref/agentlint && pnpm install && pnpm build)"
  exit 0
fi

echo "context-lint: running $RUNNER scan"

# Run scan with --json so we can threshold-gate via jq.
OUT=""
if ! OUT=$($RUNNER scan --json 2>&1); then
  echo "$OUT"
  echo "context-lint: agent-lint scan exited non-zero"
  exit 1
fi

# Pretty-print summary
if command -v jq >/dev/null 2>&1; then
  COUNT=$(echo "$OUT" | jq -r '.artifacts // [] | length' 2>/dev/null || echo "0")
  MIN=$(echo "$OUT" | jq -r '.artifacts // [] | map(.score // 100) | min // 100' 2>/dev/null || echo "100")
  echo "context-lint: $COUNT artifacts scanned, lowest score=$MIN, threshold=$THRESHOLD"
  if [ -n "$MIN" ] && [ "$MIN" != "null" ]; then
    if [ "$MIN" -lt "$THRESHOLD" ] 2>/dev/null; then
      echo "$OUT" | jq -r '.artifacts // [] | map(select((.score // 100) < '"$THRESHOLD"')) | .[] | "  fail: \(.path) score=\(.score)"' 2>/dev/null || true
      echo "context-lint: FAIL — at least one artifact below threshold $THRESHOLD"
      exit 1
    fi
  fi
  echo "context-lint: PASS"
else
  # No jq — just print and trust exit code from the runner
  echo "$OUT"
  echo "context-lint: jq not installed, skipping threshold check (soft pass)"
fi
