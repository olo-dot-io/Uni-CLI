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

Uni-CLI follows semver. The `0.400.0` line is an epoch-scale minor release:
it replaces per-command browser ownership with one shared runtime and adds a
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

## Historical Release Audit

The public git/tag history starts in 2026 with the `0.200.x` line. The current
release, `0.400.1 — Apollo · Young`, is published on npm and GitHub from the
exact annotated tag recorded below.

Release facts:

- npm registry state after publication:
  `@zenalexa/unicli@latest` is `0.400.1`;
- annotated tag `v0.400.1` resolves to main commit
  `5a1d0b782ef0dfd1af0f977d98b43c7293ab4f45`;
- main CI run `29635957077` passed the Linux, macOS, Windows, Node 22/24, and
  Rust-sidecar matrix; tag workflow `29636301437` then repeated the release gate
  and published through npm Trusted Publishers without a fallback token;
- npm records a SLSA v1 provenance attestation for the tagged workflow. The
  published artifact has 4,067 files, SHA-1
  `32316309b474269874950c74d8f33c12f2347eeb`, and integrity
  `sha512-8H6xxZ6ExeH0qoPAZNkn/95kWYEc4WnEQYLxtXDYFGsCi+vqxYTcdw7ijUW0u7IJ19321AMKvkKPSY+YVBHaBQ==`;
- the GitHub Release contains x64 and arm64 Windows process-owner executables
  that are byte-identical to the corresponding files in the npm tarball;
- a fresh production-only registry install exposed 41 generic retrieval and 35
  AI sources, executed a live PubMed query, and started broker protocol v5 from
  the compiled artifact without starting a browser provider or Chrome;
- the complete repository gate passed 3,131 unit tests (4 skipped), 94
  integration tests (16 platform-skipped), 6,528 adapter tests, 5 performance
  tests (1 skipped), and 23 targeted coverage behaviors at 100%; the production
  audit found zero vulnerabilities and installed registry signatures and
  attestations verified successfully.

| Release line | Historical role                                                                                                 | Audit lesson                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `0.200.0`    | First Vostok public adapter platform with build manifest and self-repair architecture.                          | A release must expose a machine-readable surface, not just prose.                                                  |
| `0.208.0`    | Skills export, MCP gateway, eval catalog, usage ledger, operate/observe, and documented 4-reviewer hardening.   | Review findings must be explicit and fixed before tag, especially security and release wiring.                     |
| `0.213.0`    | GA for engine rigor, split executor/runtime/steps, schema-v2 adapters, and v2 `AgentEnvelope`.                  | Stable behavior contracts outrank marketing claims.                                                                |
| `0.217.0`    | Execution-substrate framing with operation policy, run recording, browser evidence, and agent backend matrix.   | Product framing can become too small as real control surfaces expand.                                              |
| `0.218.0`    | Cross-platform browser cookie import and auth diagnostics.                                                      | Auth and platform boundaries must be explicit; unsupported paths must fail honestly.                               |
| `0.221.0`    | Patent and scholarly verticals with typed records and source routing.                                           | Vertical breadth matters only when records, provenance, and tests stay coherent.                                   |
| `0.222.0`    | Local computer-use and compute capture entered the release surface.                                             | Desktop/computer control is a core substrate, not a sidecar demo.                                                  |
| `0.224.0`    | Callable architecture audit/tree and live registry-backed search caching.                                       | Architecture audit must not omit core control commands or reduce the product to adapter lifecycle.                 |
| `0.225.0`    | Universal computer-control platform framing with intent, policy, action substrates, evidence, delivery, repair. | Product claims need live health gates, not catalog counts alone.                                                   |
| `0.227.1`    | Portable release truth, credential privacy, exact repair, and cross-platform publication gates.                 | A release candidate must stop before publication when host-contaminated evidence fails.                            |
| `0.400.0`    | Shared browser/computer runtime plus direct generic Agent browser control, search, and foreground presence.     | Runtime reuse is safe only with explicit target ownership, bounded perception, and no-focus truth.                 |
| `0.400.1`    | Domain-neutral federated retrieval plus a role-aware AI infrastructure intelligence overlay.                    | Breadth stays maintainable only when source execution, evidence contracts, and domain attribution remain separate. |

`0.400.0` is an epoch-scale minor release because it changes the runtime
ownership and Agent-facing browser protocol surfaces while keeping the package
name and command-envelope contract stable.

`0.400.1` is a patch release because it extends that stable package surface with
backward-compatible retrieval commands and closes production-package parity,
cross-platform broker-launch verification, and publication-truth gaps.

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

For the 0.400 line, the release label format is unchanged. The published
release label is `Apollo · Young`.

Candidate delivery uses the default `local` status, so generated docs cannot
turn an unobserved npm or GitHub Release event into a publication claim. Only
after both public endpoints are verified should metadata move to `published`:

```bash
npx tsx scripts/release.ts --codename "Apollo · Young" --status published
```

For `0.400.1`, that transition followed registry, provenance, Release asset,
production-only installation, live PubMed, retrieval-source, and stopped-browser
broker probes.

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
