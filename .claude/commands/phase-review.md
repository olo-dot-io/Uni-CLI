# /phase-review — cross-phase review before merge

Review a phase's worktree against the spec before merging into main.

## Usage

```
/phase-review <phase-number>
```

Example: `/phase-review 8` reviews Phase 8 output.

## What it does

1. Locates the phase's branch/worktree from `.claude/plans/sessions/`.
2. Reads the spec section from `FINAL.md`.
3. Runs `git log --oneline main..HEAD` to see all commits on the
   branch.
4. Runs `git diff main...HEAD --stat` for a file-level summary.
5. For each deliverable in the spec, checks whether a matching commit
   exists and whether the expected files are present.
6. Runs `npm run verify` one last time.
7. Returns one of:
   - `DONE` — every deliverable present, verify green.
   - `DONE_WITH_CONCERNS` — all deliverables present, but something
     non-blocking is off (test count lower than promised, skipped
     tests without comments, etc.).
   - `NEEDS_CONTEXT` — cannot verify against spec (missing FINAL.md,
     ambiguous deliverable).
   - `BLOCKED` — a deliverable is missing or verify fails.

## Ground rules

- Never approve a phase that claims files exist when they do not.
- Never approve a phase where `npm run verify` failed locally.
- Trust the spec, not the implementer's summary.
- Show evidence: commit SHAs, file paths, test count deltas.

## Output shape

```
Phase N review: <DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED>

Commits:        <count> (SHAs: abc1234, def5678, ...)
Files touched:  <count> (<adds> additions, <dels> deletions)
Test delta:     +<n> new tests
Verify:         <green | red with first error>

Deliverables:
  8.1  [✓] Changesets + verify-changesets gate
  8.2  [✓] OIDC npm publish + --provenance
  ...

Concerns: <none | bulleted list>
```
