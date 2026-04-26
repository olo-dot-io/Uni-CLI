# Release Process

Policy, versioning, codenames, and npm Trusted Publishers live in
[`docs/reference/release.md`](../docs/reference/release.md). This file is the
hands-on contributor procedure.

Uni-CLI uses [Changesets](https://github.com/changesets/changesets) to manage
per-PR version notes and npm OIDC Trusted Publishing to push artifacts.
This document describes how to ship a release from a clean main.

## 1. Per-PR: add a changeset

Every PR that modifies production code under `src/` (excluding `src/adapters/`)
must include a `.changeset/*.md` entry. CI enforces this via the
`verify-changesets` job (`.github/workflows/ci.yml`).

```bash
npm run changeset
# Follow the prompts:
#   - Select bump type: patch | minor | major
#   - Write a one-sentence, user-facing summary
# Commit the generated `.changeset/<hash>-<slug>.md` alongside your code.
```

The changeset note lands verbatim in `CHANGELOG.md` at release time. Write it
for downstream agents, not for the reviewer — state the behavior change, not
the implementation detail.

## 2. Version bump on main

After merging PRs, open a release PR that collapses all pending changesets
into a single `CHANGELOG.md` update and bumps `package.json` version:

```bash
npm run changeset:version
# Creates:
#   - version bump in package.json
#   - consolidated CHANGELOG.md
#   - removes consumed .changeset/*.md files
git add -A && git commit -m "chore(release): vX.Y.Z"
```

The seven other files that must update atomically
(`AGENTS.md`, `README.md`, `docs/ROADMAP.md`, `contributing/COPY.md`, plus codename
series) are handled by `scripts/release.ts` — run `npm run release` after
merging the version PR, or fold it into a single release PR.

## 3. Publish via OIDC trusted publishing

Tag and push. The `release` workflow (`.github/workflows/release.yml`) triggers
on `v*` tags and publishes to npm with **provenance** via GitHub-issued OIDC
tokens — no long-lived `NPM_TOKEN` required.

```bash
git tag -a vX.Y.Z -m "vX.Y.Z — Codename"
git push origin main --tags
```

The workflow runs `npm publish --provenance --access public` inside a job with
`permissions: id-token: write`. npm's registry verifies the OIDC claim against
the package's **Trusted Publishing** configuration (set once via
[npmjs.com › package settings › Trusted Publishers]).

### First-time setup (one-off, per package)

1. Log in to `npmjs.com` as a package maintainer.
2. Navigate to `@zenalexa/unicli` → Settings → Trusted Publishers.
3. Click "Add GitHub Actions publisher".
4. Enter:
   - Organization: `olo-dot-io`
   - Repository: `Uni-CLI`
   - Workflow filename: `release.yml`
   - Environment: _(leave blank)_
5. Save.

Until this is done, the workflow falls back to `NODE_AUTH_TOKEN` from
repo secret `NPM_TOKEN` (granular access token, bypasses 2FA for CI).
Keep the fallback only as long as needed; OIDC is the long-term answer.

### Why OIDC matters

- No token to rotate, revoke, or leak.
- Provenance attestation lets downstream consumers verify `dist/` was built
  by this exact workflow run on this exact commit.
- Signed provenance shows up on the npm package page.

Reference: [npm docs — Trusted Publishing](https://docs.npmjs.com/trusted-publishers).

## 4. Post-publish verification

```bash
npm view @zenalexa/unicli version     # confirm CDN has the new version
gh release view vX.Y.Z                 # confirm release notes
```

CDN propagation takes 1–3 minutes for scoped packages.

## Security

- Never commit tokens, keys, or credentials to git.
- `NPM_TOKEN` lives only in the repo's **Actions secrets**, never in
  `~/.npmrc` on CI.
- Local-dev `~/.npmrc` retains a maintainer's personal token for emergency
  manual publishes only.
- If a token appears in any log, rotate immediately.
