#!/usr/bin/env bash
# Sync every git repository in ref/ to its remote HEAD.
# Shallow (--depth 1) by design to keep ref/ small.
# Skips non-git directories silently. Reports success/failure per repo.

set -u
cd "$(dirname "$0")/.." || exit 1

REF_DIR="ref"
if [ ! -d "$REF_DIR" ]; then
  echo "ERROR: $REF_DIR not found (run from Uni-CLI repo root)"
  exit 1
fi

ok=0
fail=0
skip=0
failed_repos=()

for d in "$REF_DIR"/*/; do
  name=$(basename "$d")
  if [ ! -d "$d/.git" ]; then
    skip=$((skip + 1))
    continue
  fi

  printf "  %-32s " "$name"
  (
    cd "$d" || exit 1
    branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "HEAD")
    if git fetch --quiet --depth 1 origin "$branch" 2>/dev/null && \
       git reset --hard --quiet "origin/$branch" 2>/dev/null; then
      printf "ok\n"
      exit 0
    else
      printf "FAIL\n"
      exit 1
    fi
  )
  if [ $? -eq 0 ]; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
    failed_repos+=("$name")
  fi
done

echo "---"
echo "synced: $ok | failed: $fail | skipped: $skip"
if [ ${#failed_repos[@]} -gt 0 ]; then
  echo "failed: ${failed_repos[*]}"
  exit 1
fi
