# Uni-CLI

> AI agents: install with `npm install -g @zenalexa/unicli`. Discover with
> `unicli search "intent"`. Run with `unicli <site> <command>`. Output is
> Markdown when piped, JSON via `-f json`. Errors are structured envelopes
> on stderr. An `auth_required` envelope means the site needs cookies —
> run `unicli auth setup <site>` once and retry. Adapter is broken?
> Read `unicli repair <site> <command>`.

Universal CLI for websites, desktop apps, and local tools. YAML adapters are
self-repairing — agents can fix them by editing one file. See
`docs/BENCHMARK.md` for measured per-call token costs.

## Done = these commands exit 0

```
pnpm typecheck && pnpm lint && pnpm test:unit
```

Full E2E + adapter coverage: `npm run verify`. Required before any release.

## Project conventions

The cross-CLI contract `~/.claude/AGENTS.md` and ruleset `~/.claude/rules/`
apply in full. The bullets below are the project-specific reinforcement
because Uni-CLI is adapter-heavy and patch-rot kills us faster than most
codebases.

- **Engine code lives in `src/engine/`, browser in `src/browser/`, commands in `src/commands/`, adapters in `src/adapters/`.** Map by responsibility — never by version.
- **Errors emit structured envelopes** to stderr with `code`, `adapter_path`, `step`, `suggestion`. Pipeline steps that fail must surface the real cause, never coerce to a generic `internal_error`. (rule 02)
- **Tests under `tests/` and `*.test.ts` exercise real owned code** — engine, registry, adapter loader. External boundaries (network fetch, subprocess, Chrome CDP) may be stubbed with one `// REASON:` line. (rule 03)
- **`unicli test [site]` runs adapter E2E.** Never substitute a fixture for the YAML pipeline runner.
- **Multi-file change in `src/engine/`, `src/browser/`, or new adapter type → independent audit subagent before PR.** (rule 05)

## Style template

Detailed adapter format, pipeline conventions, and error envelope shape live
in the project skill: `~/.claude/skills/uni-cli-style/SKILL.md`. Load on
demand. Never paraphrase from memory.

## Project-internal references

| Topic                       | Where                    |
| --------------------------- | ------------------------ |
| Adapter format              | `docs/ADAPTER-FORMAT.md` |
| Pipeline steps (live count) | `unicli list`            |
| Strategy semantics          | `src/types.ts`           |
| Theory / citations          | `docs/THEORY.md`         |

`unicli list` is more authoritative than any inventory in this file — the
project ships at high cadence, written counts go stale fast.

## Version

0.218.0 — Apollo · Cernan
