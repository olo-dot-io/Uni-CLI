# Release

This page is the public release policy and operator reference for Uni-CLI.
Releases are maintainer-gated. There is no promised calendar cadence: the version
line depends on community feedback, development substance, verification results,
and the maintainer's call on whether the next shipment is patch, minor, major,
or no release yet.

## Authority

Only the maintainer decides when a release is cut. Automation prepares and
verifies a candidate; it does not decide that a release should exist.

| Path              | Workflow                                      | Behavior                                                         |
| ----------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Candidate prepare | `.github/workflows/release-candidate.yml`     | Consume changesets, verify, apply release metadata, tag, push.   |
| npm publish       | `.github/workflows/release.yml` on `v*` tags  | Publish the already-tagged version with provenance.              |
| Manual dispatch   | `workflow_dispatch` with `force` + `codename` | Maintainer-triggered release even when the commit filter is dry. |

If the maintainer has not explicitly asked to release, development stays under
`[Unreleased]` in `CHANGELOG.md` plus `.changeset/*.md` files.

## Versioning

Uni-CLI follows semver while the package is in the `0.x` line.

| Change                                                            | Version bump |
| ----------------------------------------------------------------- | ------------ |
| Adapter fixes, docs, tests, small command additions               | Patch        |
| New transport, new protocol surface, broad output behavior change | Minor        |
| Stable 1.0 compatibility contract or breaking public behavior     | Major        |

Do not bump `package.json`, run `changeset version`, tag, publish, or create a
GitHub Release until the maintainer explicitly says to release.

## Changesets

Every PR that touches production source should add one changeset:

```bash
npm run changeset
```

The release candidate workflow runs:

```bash
npx changeset version
npm run verify
```

The repository also verifies that source changes did not slip through without a
changeset:

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

Release automation filters out bot-only dependency and CI maintenance commits:

- `chore(deps)`
- `chore(deps-dev)`
- `chore(ci)`
- `build(deps)`
- `build(deps-dev)`

Everything else counts as substantive: `feat`, `fix`, `refactor`, `perf`,
`docs`, `test`, `build`, `style`, `revert`, and untyped commits. The filter is
intentionally generous because silently skipping real work is worse than
requiring a maintainer decision.

## Publishing

The publish workflow publishes `@zenalexa/unicli` from
`.github/workflows/release.yml` when a `v*` tag is pushed.

Release authority is scoped to the publish job:

- `contents: write` creates the GitHub Release.
- `id-token: write` enables npm Trusted Publishers and provenance.
- The job runs in the `npm-publish` environment.

Stable versions publish to `latest`. Prereleases publish to the channel named by
the semver prerelease prefix, for example `0.216.0-beta.2` publishes with
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

To ship a release:

1. Confirm the intended version bump and release label.
2. Open GitHub Actions.
3. Run **Release Candidate**.
4. Set `codename` to the final `Program · Astronaut` label.
5. Set `force: true` only when the release should happen even if the commit
   filter found no substantive changes.

The dispatch path consumes changesets, verifies, commits release metadata, tags,
and lets `release.yml` publish from the tag.

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

Open a tracking issue when release automation blocks a maintainer-approved
release candidate.

Include:

- failing workflow link;
- intended version and release label;
- exact verify command that failed;
- whether the blocker is changesets, tests, npm Trusted Publishers, or GitHub
  Actions availability.
