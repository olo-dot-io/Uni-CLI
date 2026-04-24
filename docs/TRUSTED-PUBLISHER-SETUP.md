# Trusted Publisher setup — one-time npmjs.com binding

**Audience**: the maintainer pushing the first `v*` tag after the
`release.yml` workflow was rewritten for OIDC. Everyone else: ignore.

**Goal**: retire the `NPM_TOKEN` fallback in `.github/workflows/release.yml`
by letting npmjs.com verify the GitHub-issued OIDC token directly. Once
bound, publishes become keyless + provenance-signed without any shared
secret in the repository.

## What this replaces

Today the release workflow accepts either path:

1. **OIDC (preferred)** — workflow's GitHub-issued OIDC token is verified
   by npmjs.com against a Trusted Publishers entry. No token required.
2. **NPM_TOKEN fallback** — workflow falls back to the `NPM_TOKEN`
   environment secret if OIDC verification isn't configured.

After the one-time binding below, OIDC always wins and the token can be
deleted from the repository environment secrets.

## The binding tuple

npmjs.com's Trusted Publishers form expects four fields. Match them
character-for-character to what the workflow advertises, or OIDC
verification fails with a generic `401` that doesn't tell you which
field diverged.

| Field                           | Value         |
| ------------------------------- | ------------- |
| GitHub organization or username | `olo-dot-io`  |
| Repository name                 | `Uni-CLI`     |
| Workflow filename               | `release.yml` |
| Environment name                | `npm-publish` |

The workflow file hardcodes `environment.name: npm-publish` in
`.github/workflows/release.yml`. The GitHub App issues the OIDC token
with claims matching this tuple — any mismatch means npmjs.com refuses
the token.

## Steps

1. **Sign in** at https://www.npmjs.com using the account that owns
   `@zenalexa/unicli` (npm username: `zenalexa`).
2. Navigate to the package page: https://www.npmjs.com/package/@zenalexa/unicli
3. **Settings** tab (requires publish access).
4. Scroll to **Trusted Publishers**.
5. Click **Add Trusted Publisher** → choose **GitHub Actions** as the
   provider.
6. Fill in the four fields from the table above **exactly**. Leading
   slashes, trailing whitespace, capitalisation all matter.
7. Save. npmjs.com records the binding server-side — nothing about the
   repository changes.

The binding survives npm token rotations, GitHub Actions version bumps,
and workflow filename renames (as long as you update the binding when
you rename). It does **not** survive if you move the repo to a new
organisation — re-bind.

## Validation

After binding, push a throwaway `v*` tag (or re-run a current release tag) and
watch `.github/workflows/release.yml` run. The "Report publish auth
mode" step prints one of:

- `::notice title=npm auth::No NPM_TOKEN secret — publish MUST succeed
via OIDC Trusted Publishers` — the happy path once the secret is
  deleted.
- `::notice title=npm auth::NPM_TOKEN secret detected — will be used as
a fallback if OIDC Trusted Publishers is not configured on npmjs.com`
  — acceptable during migration; retire the secret once OIDC proves out.

The `npm publish --provenance` step itself logs an attestation URL on
success. Confirm the package detail page shows the green provenance
badge:
https://www.npmjs.com/package/@zenalexa/unicli → **Provenance** section.

## Retire the fallback

Once the OIDC publish has succeeded at least twice:

1. **GitHub → repo Settings → Environments → npm-publish → Environment secrets**
2. Delete `NPM_TOKEN`.
3. The workflow's `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` line
   resolves to an empty string — npm then MUST use OIDC. A regression
   in the binding would surface immediately as a 401 rather than
   silently falling back to a token.

## Failure modes

| Symptom                                                         | Cause                                                                                                          | Fix                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `401 Unauthorized` from `npm publish`, no provenance attempt    | Binding tuple doesn't match the workflow exactly                                                               | Compare the four fields char-for-char                                                       |
| `npm ERR! 403 Forbidden` with "provenance unavailable"          | Token-based publish succeeded but provenance minting failed — usually because `id-token: write` was downgraded | Verify job-level `permissions: id-token: write` in `release.yml`                            |
| Workflow runs from a fork or PR branch                          | OIDC tokens from forks are intentionally unprivileged                                                          | Restrict the release workflow to `push: tags` + `workflow_dispatch` on the canonical branch |
| Environment name drift (e.g. renamed `npm-publish` → `publish`) | Binding tuple stale                                                                                            | Update the binding on npmjs.com to match the new `environment.name`                         |

## References

- npm 2026-04-06 changelog — CircleCI joined the supported provider list,
  confirming the Trusted Publishers model is stable and expanding:
  https://github.blog/changelog/2026-04-06-npm-trusted-publishing-now-supports-circleci
- Changesets + Trusted Publishing on GitHub Actions — end-to-end
  reference workflow with environment gating:
  https://www.adebayosegun.com/blog/changesets-and-trusted-publishing-on-git-hub-actions
- npm docs — "Trusted Publishers" (authoritative):
  https://docs.npmjs.com/trusted-publishers
