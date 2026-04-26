# Branch Protection

Uni-CLI's `main` branch requires every PR to pass a set of CI gates
before merge. GitHub does not let us define branch protection in a
workflow YAML — it lives on the repo's admin settings. This doc
documents the required rules and ships a shell script
(`scripts/setup-branch-protection.sh`) that applies them via `gh api`.

## Required status checks (9 + 1 nightly)

| #   | Check                                    | Source                                |
| --- | ---------------------------------------- | ------------------------------------- |
| 1   | `PR Title`                               | `.github/workflows/ci.yml`            |
| 2   | `Verify (ubuntu-latest / Node 22)`       | `.github/workflows/ci.yml` verify job |
| 3   | `Verify (ubuntu-latest / Node 20)`       | same, matrix cell                     |
| 4   | `Verify (macos-14 / Node 22)`            | same, matrix cell                     |
| 5   | `Verify (macos-14 / Node 20)`            | same, matrix cell                     |
| 6   | `Verify (windows-latest / Node 22)`      | same, matrix cell                     |
| 7   | `Adapter Tests`                          | `.github/workflows/ci.yml`            |
| 8   | `Verify Changesets`                      | `.github/workflows/ci.yml`            |
| 9   | `unicli-lint` _(runs inside Verify job)_ | `npm run lint:adapters`               |

Nightly-only (not required for merge, but monitored):

- `Nightly Conformance` — runs on schedule, uploads
  `conformance-report.json` as artifact. See contributing/adapter.md
  for the probe semantics.

The Windows × Node 20 cell is NOT in the required set because the
Windows runner has occasional PATH/tool flakiness on older Node
toolchains; it still runs and blocks the PR if it fails (fail-fast
disabled), but a transient Windows failure on Node 20 alone should
not block a merge.

## Other required settings

- **Require pull request before merging**: yes
  - Approving reviews required: 1
  - Dismiss stale reviews when new commits pushed: yes
  - Require review from Code Owners: yes (CODEOWNERS at
    `.github/CODEOWNERS`)
- **Require branches to be up to date before merging**: yes
- **Require signed commits**: no (we do not enforce GPG today)
- **Require linear history**: yes (no merge commits; squash or
  rebase only)
- **Do not allow bypassing the above**: yes (including admins;
  emergency override requires `gh api ... -X DELETE` on the rule)
- **Restrict who can push**: `@olo-dot-io/maintainers` only
- **Allow force pushes**: no
- **Allow deletions**: no

## Applying the rules

The script `scripts/setup-branch-protection.sh` applies all of the above
via `gh api`. Run it once per repo setup, then again whenever the list
of required checks changes.

```bash
# Preflight: confirm gh is authenticated as a repo admin.
gh auth status

# Dry-run (prints the JSON body without posting):
DRY_RUN=1 bash scripts/setup-branch-protection.sh

# Apply:
bash scripts/setup-branch-protection.sh
```

The script is idempotent — re-running with the same list produces no
change. When a new required check is added, update both this doc and
the `REQUIRED_CHECKS` array in the script.

## Emergency override

If a hotfix must land and CI is genuinely broken (not lint-broken;
truly unreachable), an admin can temporarily drop the protection:

```bash
gh api -X DELETE repos/olo-dot-io/Uni-CLI/branches/main/protection
# ... merge hotfix ...
bash scripts/setup-branch-protection.sh   # re-apply
```

Record the override in the emergency-override log in
`.github/EMERGENCY_OVERRIDES.md` (create the file if it does not
exist — first entry opens the log).

## Why these gates

- `typecheck` + `lint` + `test` — source-level correctness.
- `lint:adapters` — schema-v2 correctness; prevents broken YAML
  shipping to users.
- `verify-changesets` — release hygiene; every user-facing change
  has a note.
- `PR Title` — merge commit subjects come from PR titles, so titles
  must follow the same conventional-commit contract as local commits.
- Matrix (Node × OS) — catches platform-specific regressions early.
- Nightly conformance — catches adapter drift across 880+ YAML files
  without blocking individual PRs.

The cost is ~3 minutes of CI per PR. We keep the cost low by running
the six verify cells in parallel.
