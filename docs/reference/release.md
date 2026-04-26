# Release

This page is the canonical release policy and operator reference for Uni-CLI.
It replaces the old split between cadence, versioning, codenames, and trusted
publisher setup.

## Cadence

Uni-CLI ships on a weekly Friday cadence when substantive commits have landed
on `main` since the previous tag.

| Schedule         | Workflow                                    | Behavior                                                      |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------- |
| Friday 01:00 UTC | `.github/workflows/weekly-release.yml`      | Consume changesets, bump version, verify, commit, tag, push.  |
| Manual           | `workflow_dispatch` on `weekly-release.yml` | Same pipeline, with optional `force` and required `codename`. |

Quiet weeks are recorded in the workflow summary and exit `0`. They do not
create a tag or npm publish.

## Versioning

Uni-CLI follows semver while the package is in the `0.x` line.

| Change                                                            | Version bump |
| ----------------------------------------------------------------- | ------------ |
| Adapter fixes, docs, tests, small command additions               | Patch        |
| New transport, new protocol surface, broad output behavior change | Minor        |
| Stable 1.0 compatibility contract or breaking public behavior     | Major        |

Development work for the next large line stays under `[Unreleased]` in
`CHANGELOG.md` plus a `.changeset/*.md` file. Do not bump `package.json`, run
`changeset version`, tag, publish, or create a GitHub Release until the
maintainer explicitly says to release.

## Changesets

Every PR that touches production source should add one changeset:

```bash
npm run changeset
```

The weekly release workflow runs:

```bash
npx changeset version
npm run verify
```

The repository also verifies that source changes did not slip through without
a changeset:

```bash
npm run verify:changesets
```

## Release Labels

Every tagged release must carry a final spaceflight label:

```text
Program · Astronaut
```

Examples: `Vostok · Gagarin`, `Mercury · Glenn`.

Current program map:

| Version range | Program |
| ------------- | ------- |
| `0.1xx`       | Sputnik |
| `0.2xx`       | Vostok  |
| `0.3xx`       | Mercury |
| `0.4xx`       | Gemini  |

Rules:

- Development notes may say `Astronaut TBD`.
- Release headings, README footers, tags, and GitHub Releases must never use
  `TBD`, `TODO`, `Unreleased`, or `Next`.
- The release label must be chosen before `npm run release`, `npm version`,
  tagging, npm publish, or GitHub Release creation.
- Use the exact middle-dot separator: `Program · Astronaut`.

Automation enforces this:

```bash
RELEASE_CODENAME="Vostok · Gagarin" npm run release
npm run release:check -- --strict-codename
```

## Substantive Commits

The weekly workflow ignores bot-only dependency and CI maintenance commits:

- `chore(deps)`
- `chore(deps-dev)`
- `chore(ci)`
- `build(deps)`
- `build(deps-dev)`

Everything else counts as substantive: `feat`, `fix`, `refactor`, `perf`,
`docs`, `test`, `build`, `style`, `revert`, and untyped commits. The filter is
intentionally generous because silently skipping real work is worse than
shipping an occasional docs-only patch.

## Publishing

The release workflow publishes `@zenalexa/unicli` from
`.github/workflows/release.yml` when a `v*` tag is pushed.

Release authority is scoped to the publish job:

- `contents: write` creates the GitHub Release.
- `id-token: write` enables npm Trusted Publishers and provenance.
- The job runs in the `npm-publish` environment.

Stable versions publish to `latest`. Prereleases publish to the channel named
by the semver prerelease prefix, for example `0.216.0-beta.2` publishes with
`--tag beta`.

## Trusted Publishers

npm Trusted Publishers should be configured with this exact tuple:

| Field                           | Value         |
| ------------------------------- | ------------- |
| GitHub organization or username | `olo-dot-io`  |
| Repository name                 | `Uni-CLI`     |
| Workflow filename               | `release.yml` |
| Environment name                | `npm-publish` |

The package owner configures this once at:

```text
https://www.npmjs.com/package/@zenalexa/unicli
```

After two successful OIDC publishes, delete the fallback `NPM_TOKEN` from the
`npm-publish` GitHub environment. A broken binding should then fail fast with a
401 instead of silently falling back to a long-lived token.

## Manual Release

To ship outside the Friday window:

1. Open GitHub Actions.
2. Run **Weekly Release**.
3. Set `codename` to the final `Program · Astronaut` label.
4. Set `force: true` only when the release should happen even if the commit
   filter found no substantive changes.

The manual dispatch follows the same path as the scheduled workflow:
changesets, verify, commit, tag, publish.

## Cancel A Release

Before npm publish completes:

```bash
git tag -d vX.Y.Z
git push origin --delete vX.Y.Z
git revert RELEASE_COMMIT_SHA --no-edit
git push origin main
```

Then cancel the in-flight `release.yml` run from the Actions UI.

After npm publish completes, prefer deprecation over unpublish:

```bash
npm deprecate @zenalexa/unicli@X.Y.Z "see vX.Y.Z+1 for fix"
```

Then ship `vX.Y.Z+1` with the fix and document the reason in `CHANGELOG.md`.

## Escalation

If the Friday release is blocked for two consecutive weeks, open a tracking
issue titled:

```text
release-cadence: Friday blocked YYYY-MM-DD
```

Assign the maintainer and include the failing workflow link.

Common causes:

- `npm run verify` failing on `main`
- changeset corruption
- npm Trusted Publishers binding drift
- GitHub Actions outage across the release window
