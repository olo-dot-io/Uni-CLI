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

## Agent Routing Rule

Before using raw browser tools, legacy OpenCLI, curl, or computer-use for a
website, logged-in browser session, desktop app, macOS state, local tool, or
external CLI, run `unicli search "<intent>"` or `unicli list --site <site>`.
If auth is needed, first check `unicli browser profiles --json` and
`unicli browser doctor --json`; explicit cookie repair remains available via
`unicli auth import` or `unicli browser cookies <domain> --profile-id <id>`.
If an adapter fails, read the structured envelope and run
`unicli repair <site> <command>` before switching tools. Browser work is
background-first: daemon commands default to `windowFocused: false`,
doctor/session probes must not create `about:blank` placeholder tabs,
foreground startup requires explicit `unicli browser --focus start`, and CDP
must use process-verified live profiles or Uni-CLI automation profiles under
`~/.unicli/` rather than Chrome's default user-data-dir. Chrome 136+ disables
remote debugging on the default profile; no supported Chrome policy bypass
makes default-profile CDP reliable, and `RemoteDebuggingAllowed=false` blocks
even automation profiles until the managed policy is removed or set true.
Default browser startup reuses login state by attaching to an already-exposed
local profile when available, otherwise by seeding a Uni-CLI-owned automation
profile from the preferred local Chrome profile. Empty profiles require
explicit `unicli browser start --ephemeral` or `UNICLI_BROWSER_EPHEMERAL=1`.
For any browser failure, read `unicli browser doctor --json`: `default_path`
tells whether delivery can proceed now, `profile_source` tells whether the path
is attach, seeded, remote, or ephemeral, `chrome_remote_debugging` gives the
Chrome 136+/policy truth, `checks[*].next_step` gives the exact repair command,
and `unicli browser doctor --repair` is the safe first repair for local CDP
because it starts only the Uni-CLI automation profile.

<!-- BEGIN COUNTS -->

> <!-- STATS:site_count -->320<!-- /STATS --> sites, <!-- STATS:command_count -->1798<!-- /STATS --> commands, <!-- STATS:pipeline_step_count -->103<!-- /STATS --> pipeline steps, BM25 bilingual search. `npm install -g @zenalexa/unicli`

<!-- END COUNTS -->

<!-- BEGIN ADAPTERS -->

## What You Can Do

### Web (182+ sites)

**Chinese**: zhihu (27), xiaohongshu (22), bilibili (20), douyin (13), douban (12), v2ex (12), weibo (12), linux-do (11), +28 more (`unicli list`)

**International**: twitter (47), instagram (29), reddit (24), tiktok (18), youtube (17), nowcoder (16), discord-app (15), facebook (15), +78 more (`unicli list`)

**AI / ML**: chatgpt (17), antigravity (16), chatwise (16), notebooklm (15), claude (14), doubao-app (13), yollomi (12), deepseek (9), +16 more (`unicli list`)

**Finance**: eastmoney (18), xueqiu (14), binance (13), coingecko (7), sinafinance (5), barchart (4), yahoo-finance (3), coinbase (2), +2 more (`unicli list`)

**Developer**: codex (18), cursor (18), stackoverflow (10), vscode (10), docker-desktop (7), github-desktop (7), gitkraken (7), insomnia (7), +29 more (`unicli list`)

**News**: hackernews (11), bloomberg (10), 36kr (5), bbc (5), reuters (5), ithome (3), cnn (2), infoq (2), +3 more (`unicli list`)

**Reference**: spotify (24), netease-music (17), linear (10), imdb (7), marxists-cn (7), bitwarden (7), todoist (7), wikipedia (6), +15 more (`unicli list`)

### macOS (60 cmds)

active-app, app-actions, apps, apps-list, automation-smoke, battery, bluetooth, brightness, caffeinate, calendar-create, calendar-list, calendar-today, … (`unicli list --site macos`)

### Desktop (28 apps)

freecad (15 cmds), blender (13 cmds), gimp (12 cmds), ffmpeg (11 cmds), audacity (8 cmds), figma (8 cmds), obs (8 cmds), docker (7 cmds), +20 more (`unicli list --category desktop`)

### Bridge (1 CLIs)

jq (2 cmds)

<!-- END ADAPTERS -->

## Done = these commands exit 0

```
npm run typecheck && npm run lint && npm test
```

Full E2E + adapter coverage: `npm run verify`. Required before any release.

## Project conventions

Uni-CLI is adapter-heavy; patch-rot is the failure mode that kills us fastest.

- **Engine code lives in `src/engine/`, browser in `src/browser/`, commands in `src/commands/`, adapters in `src/adapters/`.** Map by responsibility — never by version.
- **Errors emit structured envelopes** to stderr with `code`, `adapter_path`, `step`, `suggestion`. Pipeline steps that fail must surface the real cause, never coerce to a generic `internal_error`.
- **Tests under `tests/` and `*.test.ts` exercise real owned code** — engine, registry, adapter loader. External boundaries (network fetch, subprocess, Chrome CDP) may be stubbed with one `// REASON:` line.
- **`unicli test [site]` runs adapter E2E.** Never substitute a fixture for the YAML pipeline runner.
- **Multi-file change in `src/engine/`, `src/browser/`, or new adapter type → independent code review before PR.**

## Project references

| Topic                       | Where                    |
| --------------------------- | ------------------------ |
| Adapter format              | `docs/ADAPTER-FORMAT.md` |
| Pipeline steps (live count) | `unicli list`            |
| Strategy semantics          | `src/types.ts`           |

`unicli list` is more authoritative than any inventory in this file — the
project ships at high cadence, written counts go stale fast.

## Public surface boundary (machine-enforced)

This repo's public surface is a pure engineering tool. Theoretical framing,
formal-proof scaffolding, and academic identity bridges are blocked from
public files by `scripts/boundary-guard.ts` (runs on `npm run verify` and on
`lefthook` pre-commit). Run `npm run boundary:check` to verify locally.

Banned in public files: `Banach`, `Rice's restriction`, `Lehman's mandate`,
`Hellman–Cover`, `sequential-Fano`, `agent-tool trilemma`,
`Deterministic Compilation Thesis`, `triple-intersection`,
`envelope-to-operator mapping`, `|A|=5`, `Cox PH cloglog DTH GLMM`,
`Theorem 1/2`, `Author: Claude`, `docs/superpowers/`, `internal/refs.bib`.
Allowlist: `ref/**`, `archive/**`, `CHANGELOG.md` (frozen history).

Public OSS idiom that stays on the public surface: `structured error
envelope`, `envelope completeness`, `agent self-repair`, `repair loop`,
`agent-readable YAML`. These read as engineering on the public surface.

If `boundary-guard` flags a file, the fix is either to rewrite the term in
engineering vocabulary or to move the file under `ref/`. Do not add an
allowlist entry without a one-line `// REASON:` justification in
`scripts/boundary-guard.ts` patterns array.

## Version

0.226.0 — Apollo · Stafford

## MCP one-liner (Claude Desktop / Cursor / Continue)

```json
{
  "mcpServers": {
    "unicli": {
      "command": "npx",
      "args": ["-y", "@zenalexa/unicli-mcp"]
    }
  }
}
```

Equivalent: `npx -y @zenalexa/unicli mcp serve`. Default profile exposes 4
meta-tools (~200 tokens); `--expanded` exposes one tool per command (3,319
tools, ~160K tokens). The registry manifest is shipped at `server.json` for
the official MCP registry.
