# Release Cadence

> Introduced in v0.213 (Gagarin). See `.github/workflows/weekly-release.yml`.

Uni-CLI ships on a **weekly Friday cadence**. The goal is a predictable public
heartbeat that keeps pace with the agent-infrastructure space — OpenCLI ships
near-daily, and long silences between our version bumps misrepresent how much
is actually landing on `main`. Weekly releases make the activity visible
without bouncing contributors through a bump-per-commit firehose.

## 1. Cadence promise

A patch release is cut every **Friday 09:00 HKT (01:00 UTC)** whenever
substantive commits have landed on `main` since the previous tag. Quiet weeks
are recorded in the workflow summary and exit `0` — they don't trigger a
release, they don't trigger a failure, they just tell you nothing shipped.

The gate lives in `.github/workflows/weekly-release.yml`. It runs on:

- `schedule: "0 1 * * 5"` — every Friday at 01:00 UTC
- `workflow_dispatch` — manual trigger, optional `force: true` input

## 2. Dependabot bundling

Dependabot opens a **single grouped PR every Monday 01:00 HKT** for npm
dependencies (`all-deps` group) and a separate grouped PR for GitHub Actions
bumps (`all-actions` group). Both carry the `deps-only` label.

The intended flow is:

| Day          | Action                                                           |
| ------------ | ---------------------------------------------------------------- |
| Monday 01:00 | Dependabot opens grouped PRs                                     |
| Mon–Thu      | Review, merge (or close) PRs                                     |
| Friday 01:00 | Weekly release workflow fires; merged deps ride along in the tag |

Ungrouped per-dependency PRs were explicitly replaced with grouping in v0.213.
Preserving individual bumps defeats the purpose: it re-floods the commit log
and drowns out substantive work.

## 3. Versioning

The project uses [semver](https://semver.org) with this split:

- **Patch** (`0.213.X`) — bug fixes, adapter additions, doc touch-ups, small
  features. The default for every weekly cadence release.
- **Minor** (`0.214.0`) — major surface changes: new transport, new command
  class, codename bump, breaking behavior behind a flag. Not cut by the weekly
  cron; handled by an explicit release commit and tag.
- **Major** (`1.0.0`) — reserved. Requires an RFC-style design doc and an
  explicit decision from the maintainer.

Changesets (`.changeset/*.md`) drive the version math. Contributors add one
per PR that touches `src/`; the weekly workflow calls `npx changeset version`
to consume them and compute the bump.

## 4. What counts as substantive

The detection filter in the weekly workflow considers a commit substantive
when its conventional-commit prefix is **NOT** one of:

- `chore(deps)` — dependabot npm bumps
- `chore(ci)` — dependabot GitHub-actions bumps

Everything else counts: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`,
`build`, `style`, `revert`, and untyped commits. The filter is intentionally
generous — the failure mode we optimize against is silently skipping a week
with real work, not releasing an occasional docs-only patch.

If your PR truly should not trigger a release (e.g. a README typo nobody
cares about), land it under `chore(ci)` or `chore(deps)`. In practice this
almost never matters — the cost of a patch bump for a docs fix is zero.

## 5. Manual override

To ship outside the Friday window:

1. From the GitHub Actions UI → **Weekly Release** → **Run workflow**.
2. (Optional) Set `force: true` to release even if the filter shows no
   substantive commits — useful when dependabot work was material enough
   to warrant a version bump on its own (a security patch, a breaking
   dependency).

The manual dispatch follows the exact same pipeline: changesets → verify →
commit → tag → trigger `release.yml`.

## 6. Cancelling a release

If the cron fires a release you didn't want, or a post-release regression is
discovered before the npm publish completes, the procedure is:

### Before the tag has been published to npm

1. Delete the tag locally and on the remote:
   ```bash
   git tag -d vX.Y.Z
   git push origin --delete vX.Y.Z
   ```
2. Revert the release commit:
   ```bash
   git revert <release-commit-sha> --no-edit
   git push origin main
   ```
3. Cancel the in-flight `release.yml` run from the Actions UI.

### After the tag has been published to npm

npm publishes are **not revocable** past 72 hours, and even within 72 hours
unpublishing a scoped package removes it from the registry for 24 hours.
Prefer deprecation:

```bash
npm deprecate @zenalexa/unicli@X.Y.Z "see vX.Y.Z+1 for fix"
```

Then ship `vX.Y.Z+1` with the fix via the normal manual dispatch. Document
the reason in `CHANGELOG.md` under the new version.

## 7. Drop-dead escalation

If the Friday release is blocked for **two consecutive weeks**, open a
tracking issue titled `release-cadence: Friday blocked {date}` and assign
the maintainer. Common causes:

- `npm run verify` failing on `main` (not caught by CI before merge)
- Changesets file corruption
- Trusted Publishers OIDC disconnect on npmjs.com
- GitHub Actions outage across the release window

The issue is the root-cause signal. Two weeks of silence is the maximum
acceptable gap; anything longer compromises the public heartbeat the whole
cadence is designed to produce.

---

Questions on cadence or release mechanics: see [`contributing/release.md`](../contributing/release.md)
for the hands-on procedure; this doc covers policy only.
