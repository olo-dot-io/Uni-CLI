#!/usr/bin/env bash
# Synchronize every nested reference checkout without overwriting local work.

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

ref_dir="${UNICLI_REF_DIR:-ref}"
if [ ! -d "$ref_dir" ]; then
  echo "ERROR: $ref_dir not found"
  exit 1
fi

repos=()
while IFS= read -r git_dir; do
  repos+=("${git_dir%/.git}")
done < <(find "$ref_dir" -type d -name .git -prune -print | sort)

if [ ${#repos[@]} -eq 0 ]; then
  echo "ERROR: no git repositories found under $ref_dir"
  exit 1
fi

synced=0
failed=()
for repo in "${repos[@]}"; do
  relative_repo="${repo#"$ref_dir"/}"
  printf "  %-56s " "$relative_repo"

  if [ -n "$(git -C "$repo" status --porcelain 2>/dev/null)" ]; then
    echo "DIRTY"
    failed+=("$relative_repo (dirty)")
    continue
  fi

  branch="$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null)"
  if [ -z "$branch" ]; then
    echo "DETACHED"
    failed+=("$relative_repo (detached HEAD)")
    continue
  fi

  if git -C "$repo" fetch --quiet origin "$branch" &&
    git -C "$repo" merge --quiet --ff-only "origin/$branch"; then
    printf "ok %s\n" "$(git -C "$repo" rev-parse --short=12 HEAD)"
    synced=$((synced + 1))
  else
    echo "FAIL"
    failed+=("$relative_repo")
  fi
done

echo "---"
echo "synced: $synced | failed: ${#failed[@]}"
if [ ${#failed[@]} -gt 0 ]; then
  printf 'failed: %s\n' "${failed[*]}"
  exit 1
fi
