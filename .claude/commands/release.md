# /release — atomic version bump + publish

Cut a Uni-CLI release from a clean `main`.

## Usage

```
/release <version> [codename]
```

Example: `/release 0.212.0 "Shatalov"`

## What it does

1. Confirms `main` is clean and up to date with origin.
2. Runs `npm run verify` (must pass).
3. Runs `npm run changeset:version` to fold pending changesets into
   `CHANGELOG.md` and bump `package.json`.
4. Updates the six other files that must change atomically (AGENTS.md
   counts, README badges/footer, `docs/ROADMAP.md` progress,
   `docs/TASTE.md` current-version, codename series). Handled by
   `scripts/release.ts`.
5. Runs `npm run verify` again (regenerated AGENTS.md must be clean).
6. Creates a single commit: `release: v<version> — <codename>`.
7. Tags `v<version>` with annotated message.
8. Shows what will happen on `git push origin main --tags`:
   - Release workflow triggers, publishes to npm with provenance
     via OIDC (see `contributing/release.md`).
   - GitHub release drafted from changelog.

## Safety

- NEVER push without explicit user confirmation.
- NEVER run `npm publish` locally from this command — CI owns publish.
- NEVER skip `verify` — a red build becomes a red published package.
- NEVER amend or force-push an existing tag.

## What you see

```
Cut release v0.212.0 — Shatalov

  package.json       0.211.2 → 0.212.0
  CHANGELOG.md       +47 lines
  AGENTS.md          195 → <new> sites, 956 → <new> commands
  README.md          badges updated
  docs/ROADMAP.md    phase 8 marked ✓
  docs/TASTE.md      current version line

Verify: 881 tests passed, build green.

Next step: git push origin main --tags
           (type `y` to push now, `n` to stop here)
```
