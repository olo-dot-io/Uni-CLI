# /verify — run full verification pipeline

Run the full Uni-CLI verification gate and report the outcome.

## What it does

Executes `npm run verify`, which chains seven gates in order:

1. `format:check` — Prettier formatting
2. `typecheck` — TypeScript strict mode, `--noEmit`
3. `lint` — oxlint on `src/`
4. `lint:context` — agent-lint rubric on AGENTS.md / CLAUDE.md / skills
5. `build:manifest` — regenerate `dist/manifest*.json`
6. `test` — Vitest unit project
7. `build` — `tsc` + AGENTS.md regeneration

Exits non-zero on the first failure. A clean run produces a compact
summary with test count and manifest stats.

## Usage

```
/verify
```

## Ground rules

- Never claim "done" before this passes.
- On failure, show the tail of the output and the first red step.
- `format:check` failures: run `npm run format` and re-try.
- `test` failures: investigate root cause; no `--bail` loops.

## Why

CI runs this exact chain on six matrix cells (Node 20/22 × ubuntu/
macos-14/windows). Local green means CI is likely green — but trust
CI, not the local run.
