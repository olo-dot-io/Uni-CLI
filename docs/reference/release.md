# Release

This page is the public release policy and operator reference for Uni-CLI.
Releases are maintainer-gated. There is no promised calendar cadence: the version
line depends on community feedback, development substance, verification results,
and the maintainer's call on whether the next shipment is patch, minor, major,
or no release yet.

## Authority

Only the maintainer decides when a release is cut. Automation prepares and
verifies a candidate; it does not decide that a release should exist.

| Path              | Workflow                                            | Behavior                                                                    |
| ----------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| Candidate prepare | local maintainer commit on `main`                   | Apply version metadata, changelog, docs, generated assets, and tests.       |
| npm publish       | `.github/workflows/release.yml` on pushed `v*` tags | Check out the tag, verify the package, publish to npm with provenance.      |
| Manual dispatch   | `.github/workflows/release.yml` with `tag=vX.Y.Z`   | Re-run the same GitHub publish path for an existing tag if tag push missed. |

If the maintainer has not explicitly asked to release, development stays under
`[Unreleased]` in `CHANGELOG.md` plus `.changeset/*.md` files.

## Versioning

Uni-CLI follows semver. The `0.220.x` line is a patch release line on top of
the current execution substrate: command-first discovery and execution, v2
`AgentEnvelope` output, repairable adapter errors, operation-policy metadata,
optional run recording, scholarly PDF workflows, and expanded ACG/anime/manga
discovery. It is not a major-version compatibility boundary.

| Change                                                            | Version bump |
| ----------------------------------------------------------------- | ------------ |
| Adapter fixes, docs, tests, small command additions               | Patch        |
| New transport, new protocol surface, broad output behavior change | Minor        |
| Explicit stable-major compatibility contract or breaking behavior | Major        |

Do not bump `package.json`, run `changeset version`, tag, publish, or create a
GitHub Release until the maintainer explicitly says to release.

Before any release, the macOS dynamic discovery work from
`codex/macos-dynamic-actions` must already be audited, reviewed, and merged to
`main`. `npm run verify:release-mainline`, `npm run release`, and
`npm run release:check` enforce this by requiring release commands to run from
`main`, requiring commit `33bafa6087bf81c9b9df5cc0e996e79f6e28f030` to be an
ancestor of `HEAD`, and checking that the first-class `macos app-actions` and
`macos automation-smoke` manifest entries are present before publish.

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

Examples: `Vostok · Gagarin`, `Mercury · Glenn`, `Apollo · Lovell`.

Current program map:

| Version range | Program |
| ------------- | ------- |
| `0.1xx`       | Sputnik |
| `0.200-0.213` | Vostok  |
| `0.216+`      | Apollo  |

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

For the 0.220 line, the release label format is unchanged. The current release
label is `Apollo · Lovell Patch`.

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
`.github/workflows/release.yml` when a `v*` tag is pushed. Local machines should
not be treated as the npm publishing authority. A local `npm whoami` failure is
not a release blocker if the candidate commit and tag can be pushed to GitHub:
the real publish step runs in GitHub Actions through Trusted Publishers or the
`NPM_TOKEN` fallback in the `npm-publish` environment.

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
2. Confirm `codex/macos-dynamic-actions` is merged to `main` with
   `npm run verify:release-mainline`.
3. Run `npm run verify`, `npm run release:check -- --strict-codename`,
   `npm publish --dry-run`, and `npm run docs:check-public`.
4. Commit the release candidate to `main`.
5. Push `main`.
6. Create the release tag with `git tag vX.Y.Z`.
7. Push the tag with `git push origin vX.Y.Z`.
8. Watch **Actions → Release**. The workflow checks out the tag, verifies the
   package surface, publishes to npm with provenance, and creates the GitHub
   Release.

If the tag already exists and the push event did not run or was cancelled,
re-run the same publish path instead of publishing locally:

```bash
gh workflow run release.yml --ref main -f tag=vX.Y.Z
gh run watch --repo olo-dot-io/Uni-CLI
```

The dispatch path requires the tag to exist. It checks out that tag and fails if
the tag does not match `package.json`'s `vX.Y.Z`, preventing an accidental
publish from the wrong branch head.

## Local Auth Failure SOP

Use this branch when the maintainer-approved release is ready but the local npm
or GitHub session is unreliable:

1. Treat `npm publish --dry-run` as the local npm check. Do not run a real local
   `npm publish`.
2. Confirm `npm view @zenalexa/unicli version` before and after the GitHub run.
3. If `npm whoami` returns `E401`, continue with GitHub Actions; the local npm
   session is not used by the release workflow.
4. If `gh auth status` is healthy, push `main` and `vX.Y.Z`, or dispatch
   `release.yml` for an existing tag.
5. If `gh` is unhealthy but `git push` still works, push the tag with Git and
   use the GitHub Actions web UI to monitor or re-run **Release**.
6. If neither `gh` nor `git push` works, stop after local verification and hand
   off the exact commit SHA, tag name, dry-run shasum, and failed auth command.
   Do not publish from an unverified local workaround.

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
