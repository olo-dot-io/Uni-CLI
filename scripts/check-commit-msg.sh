#!/usr/bin/env bash
#
# check-commit-msg.sh — reject non-standard commit messages and messages
# that describe the work session instead of the product change.
#
# Enforced by the lefthook `commit-msg` hook.
#
# Subject contract:
#   type(scope): summary
#
# Allowed types:
#   feat, fix, docs, test, refactor, perf, build, ci, chore, release, revert
#
# Forbidden patterns (case-insensitive):
#   - "codex" as a standalone word
#   - "subagent"
#   - "batch N" / "batch N/M"
#   - "round-N/round-N" / "round-N" in audit context
#   - "spec drift"
#   - "strategic-design"
#
# Usage:
#   bash scripts/check-commit-msg.sh <path-to-commit-message>
#
# Skip with `LEFTHOOK=0 git commit` only for legitimate false positives
# (e.g. editing this file itself). PR titles are checked in CI and have
# no escape hatch.

set -euo pipefail

msg_file=${1:-}
if [ -z "$msg_file" ] || [ ! -f "$msg_file" ]; then
  echo "check-commit-msg: usage: $0 <commit-message-file>" >&2
  exit 2
fi

# Read the message, strip comment lines (git's `#` prefix).
msg=$(grep -vE '^\s*#' "$msg_file" || true)
subject=$(printf '%s\n' "$msg" | sed -n '/[^[:space:]]/{p;q;}')

conventional_re='^(feat|fix|docs|test|refactor|perf|build|ci|chore|release|revert)(\([A-Za-z0-9._-]+\))?!?: .+'
if ! printf '%s\n' "$subject" | grep -Eq "$conventional_re"; then
  printf >&2 '\ncommit-msg: rejected — subject must be a conventional commit:\n\n'
  printf >&2 '  received: %s\n\n' "${subject:-<empty>}"
  printf >&2 '  expected: type(scope): summary\n'
  printf >&2 '  allowed types: feat, fix, docs, test, refactor, perf, build, ci, chore, release, revert\n\n'
  printf >&2 '  examples:\n'
  printf >&2 '    feat(office): add Word font adapter\n'
  printf >&2 '    fix(windows): normalize site memory paths\n'
  printf >&2 '    docs: define documentation maintenance policy\n\n'
  exit 1
fi

# Each entry: "pattern|human description"
violations=()
while IFS='|' read -r pattern description; do
  if echo "$msg" | grep -iqE "$pattern"; then
    violations+=("$description")
  fi
done <<'PATTERNS'
\bcodex\b|"codex" — agent reference
\bsubagent\b|"subagent" — orchestration term
\bbatch [0-9]|"batch N" — workflow step
round-?[0-9]+/round-?[0-9]+|"round-N/round-M" — audit round marker
\bspec drift\b|"spec drift" — use "contract drift" instead
\bstrategic-design\b|"strategic-design" — planning term
PATTERNS

if [ ${#violations[@]} -eq 0 ]; then
  exit 0
fi

printf >&2 '\ncommit-msg: rejected — message describes the work session instead of the product change:\n\n'
for v in "${violations[@]}"; do
  printf >&2 '  • %s\n' "$v"
done
printf >&2 '\n  CLAUDE.md rule: git commit messages describe WHAT changed, not HOW\n'
printf >&2 '  the change was developed. Rewrite the message or, for a\n'
printf >&2 '  legitimate false positive, use LEFTHOOK=0 git commit ...\n\n'
exit 1
