# Release

This page is the public release policy and operator reference for Uni-CLI.
The maintainer chooses the release timing and version from community feedback,
the scope of the changes, and verification results. The same decision
determines whether development continues or a patch, minor, or major ships.

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

Uni-CLI follows semver. The `0.400.0` line is an epoch-scale minor release.
It replaces per-command browser ownership with one shared runtime and adds a
generic Agent browser-control surface. The direct `0.4.0` spelling is not
used because it sorts below the already published `0.227.1`; `0.400.0`
preserves monotonic upgrades.

| Change                                                                                   | Version bump |
| ---------------------------------------------------------------------------------------- | ------------ |
| Adapter fixes, docs, tests, small command additions                                      | Patch        |
| Product-frame rewrite, new transport, new protocol surface, broad output behavior change | Minor        |
| Explicit stable-major compatibility contract or breaking behavior                        | Major        |

Do not bump `package.json`, run `changeset version`, tag, publish, or create a
GitHub Release until the maintainer explicitly says to release.

Before any release, the macOS dynamic discovery work from
`codex/macos-dynamic-actions` must already be audited, reviewed, and merged to
`main`. `npm run verify:release-mainline`, `npm run release`, and
`npm run release:check` enforce this by requiring release commands to run from
`main`, requiring commit `33bafa6087bf81c9b9df5cc0e996e79f6e28f030` to be an
ancestor of `HEAD`, and checking that the first-class `macos app-actions` and
`macos automation-smoke` manifest entries are present before publish.

## Cross-Version Release History

`CHANGELOG.md` is the canonical authored release history. Every production
change enters through one `.changeset/*.md` file. `changeset version` consumes
those files into the next version block, and `scripts/release.ts` adds the final
date and release label.

The documentation build runs `scripts/generate-release-history.ts`. It publishes
two views from that same source.

- [`/releases`](../releases) provides the complete version index, release links,
  npm links, and exact Git comparisons.
- [`release-history.json`](../release-history.json) provides the same history as
  structured data for Agents and other tooling.

The generated English and Chinese pages stay out of the editing path. Historical
claims are corrected in `CHANGELOG.md`, then regenerated with `npm run docs:prepare`. This keeps the repository record, documentation site, Agent
assets, GitHub Releases, and npm versions tied to one version identity.

## Changesets

Every PR that touches production source should add one changeset.

```bash
npm run changeset
```

The release candidate workflow runs.

```bash
npx changeset version
npm run verify
```

The repository also verifies that source changes did not slip through without a
changeset.

```bash
npm run verify:changesets
```

## Release Labels

Every tagged release must carry a final spaceflight label.

```text
Program · Astronaut
```

Examples include `Vostok · Gagarin`, `Mercury · Glenn`, `Apollo · Lovell`.

Current program map.

| Version range | Program |
| ------------- | ------- |
| `0.1xx`       | Sputnik |
| `0.200-0.213` | Vostok  |
| `0.216+`      | Apollo  |
| `1.x`         | Artemis |

Rules.

- Development notes may say `Astronaut TBD`.
- Release headings, README footers, tags, and GitHub Releases must never use
  `TBD`, `TODO`, `Unreleased`, or `Next`.
- The release label must be chosen before `npm run release`, `npm version`,
  tagging, npm publish, or GitHub Release creation.
- Use the exact middle-dot separator in `Program · Astronaut`.

Automation enforces this.

```bash
RELEASE_CODENAME="Vostok · Gagarin" npm run release
npm run release:check -- --strict-codename
```

For the 0.400 line, the release label format is unchanged. Its final published
release label is `Apollo · Duke`.

The 1.x line starts with `Artemis · Glover`. Version `1.0.0` establishes the
stable operation-first compatibility contract. Discovery declares one feasible
provider and its substrate before execution; targets, effects, evidence, errors,
and recovery remain machine-readable across CLI and MCP boundaries. Future 1.x
releases preserve those public contracts unless semver requires another major.

Candidate delivery uses the default `local` status, so generated docs cannot
turn an unobserved npm or GitHub Release event into a publication claim. Only
after both public endpoints are verified should metadata move to `published`.

```bash
npx tsx scripts/release.ts --codename "Artemis · Glover" --status published
```

For `1.0.2`, that transition followed registry, provenance, GitHub Release
asset, complete release-gate, and exact public-version probes.

## Substantive Commits

Release automation filters out bot-only dependency and CI maintenance commits.

- `chore(deps)`
- `chore(deps-dev)`
- `chore(ci)`
- `build(deps)`
- `build(deps-dev)`

The substantive categories include `feat`, `fix`, `refactor`, `perf`,
`docs`, `test`, `build`, `style`, `revert`, and untyped commits. The filter is
intentionally generous because silently skipping real work is worse than
requiring a maintainer decision.

## Publishing

The publish workflow publishes `@zenalexa/unicli` from
`.github/workflows/release.yml` when a `v*` tag is pushed. Local machines should
not be treated as the npm publishing authority. A local `npm whoami` failure is
not a release blocker if the candidate commit and tag can be pushed to GitHub.
The real publish step runs in GitHub Actions through Trusted Publishers or the
`NPM_TOKEN` fallback in the `npm-publish` environment.

Release authority is scoped to the publish job.

- `contents: write` creates the GitHub Release.
- `id-token: write` enables npm Trusted Publishers and provenance.
- The job runs in the `npm-publish` environment.

Stable versions publish to `latest`. Prereleases publish to the channel named by
the semver prerelease prefix, for example `0.216.0-beta.2` publishes with
`--tag beta`.

## Trusted Publishers

npm Trusted Publishers should be configured with this exact tuple.

| Field                           | Value         |
| ------------------------------- | ------------- |
| GitHub organization or username | `olo-dot-io`  |
| Repository name                 | `Uni-CLI`     |
| Workflow filename               | `release.yml` |
| Environment name                | `npm-publish` |

The package owner configures this once at.

```text
https://www.npmjs.com/package/@zenalexa/unicli
```

After two successful OIDC publishes, delete the fallback `NPM_TOKEN` from the
`npm-publish` GitHub environment. A broken binding then returns a
401 and requires repair of the OIDC configuration.

## Manual Release

To ship a release.

1. Confirm the intended version bump and release label.
2. Confirm `codex/macos-dynamic-actions` is merged to `main` with
   `npm run verify:release-mainline`.
3. For a product-frame release, update the historical release audit section on
   this page before tagging.
4. Run `npm run verify`, `npm run release:check -- --strict-codename`,
   `npm publish --dry-run`, and `npm run docs:check-public`.
5. Commit the release candidate to `main`.
6. Push `main`.
7. Create the annotated release tag with
   `git tag -a vX.Y.Z -m "vX.Y.Z — Program · Astronaut"`.
8. Push the tag with `git push origin vX.Y.Z`.
9. Watch **Actions → Release**. The workflow checks out the tag, verifies the
   package surface, publishes to npm with provenance, and creates the GitHub
   Release.

If the tag already exists and the push event did not run or was cancelled,
re-run the same GitHub publish path.

```bash
gh workflow run release.yml --ref main -f tag=vX.Y.Z
gh run watch --repo olo-dot-io/Uni-CLI
```

The dispatch path requires the tag to exist. It checks out that tag and fails if
the tag does not match `package.json`'s `vX.Y.Z`, preventing an accidental
publish from the wrong branch head.

## Local Auth Failure SOP

Use this branch when a maintainer-approved release encounters an unreliable local npm
or GitHub session.

1. Treat `npm publish --dry-run` as the local npm check. Do not run a real local
   `npm publish`.
2. Confirm `npm view @zenalexa/unicli version` before and after the GitHub run.
3. If `npm whoami` returns `E401`, continue with GitHub Actions; the local npm
   session is not used by the release workflow.
4. If `gh auth status` is healthy, push `main` and `vX.Y.Z`, or dispatch
   `release.yml` for an existing tag.
5. If `gh` is unhealthy and `git push` works, push the tag with Git and
   use the GitHub Actions web UI to monitor or re-run **Release**.
6. If neither `gh` nor `git push` works, stop after local verification and hand
   off the exact commit SHA, tag name, dry-run shasum, and failed auth command.
   Do not publish from an unverified local workaround.

## Cancel A Release

Before npm publish completes.

```bash
git tag -d vX.Y.Z
git push origin --delete vX.Y.Z
git revert RELEASE_COMMIT_SHA --no-edit
git push origin main
```

Then cancel the in-flight `release.yml` run from the Actions UI.

After npm publish completes, prefer deprecation over unpublish.

```bash
npm deprecate @zenalexa/unicli@X.Y.Z "see vX.Y.Z+1 for fix"
```

Then ship `vX.Y.Z+1` with the fix and document the reason in `CHANGELOG.md`.

## Escalation

Open a tracking issue when release automation blocks a maintainer-approved
release candidate.

Include.

- failing workflow link;
- intended version and release label;
- exact verify command that failed;
- whether the blocker is changesets, tests, npm Trusted Publishers, or GitHub
  Actions availability.
