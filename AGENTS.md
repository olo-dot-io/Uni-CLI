# Uni-CLI

> AI agents: install with `npm install -g @zenalexa/unicli`. Discover with
> `unicli search "intent"`. Run with `unicli <site> <command>`. Output is
> Markdown when piped, JSON via `-f json`. Errors are structured envelopes
> on stderr. An `auth_required` envelope means the site needs cookies —
> run `unicli auth setup <site>` once and retry. Adapter is broken?
> Read `unicli repair <site> <command>`.

Every structured response can carry `meta.update`. Persistent non-interactive
Agent installations schedule its exact release automatically and report state
under `automatic_update`. Confirm with `unicli --version` before retrying a
version-sensitive task. Use `unicli upgrade --no-auto-update` for explicit
approval. Interactive users can choose Y or N with `unicli upgrade`.

Open Agent-Computer Interface runtime for real software. Rank operations by
intent, explicitly select one with a declared substrate, inspect its structured
result, and repair supported drift paths. Operation-specific evidence is
optional. YAML adapters stay agent-readable and locally repairable. See
`docs/BENCHMARK.md` for measured Uni-CLI call costs.

## Agent Routing Rule

Before raw browser tools, OpenCLI, curl, computer-use, or an external CLI, run
`unicli search "<intent>"` or `unicli list --site <site>`. Read structured
errors and run `unicli repair <site> <command>` before changing tools.

For auth and browser failures, read `unicli browser profiles --json` and
`unicli browser doctor --json`. Browser work starts in the background.
Foreground control requires `unicli browser --focus start`. CDP uses a
Uni-CLI automation profile because Chrome 136 and managed policy can block the
default profile. Empty profiles require an explicit ephemeral session. Follow
`checks[*].next_step` from doctor. Use `unicli browser doctor --repair` only
for the windowless broker.

## Always-on writing rule

Read `skills/human-writing/SKILL.md` before every user-facing reply and prose
artifact. It is the primary Chinese and English writing policy. Its current
discussion scan and hard bans are mandatory. Load references only when the
task calls for them. Run `npm run prose:check -- <path>` on authored files and
apply the same scan manually to chat replies.

<!-- BEGIN COUNTS -->

> Static adapter catalog: <!-- STATS:site_count -->337<!-- /STATS --> sites, <!-- STATS:command_count -->1890<!-- /STATS --> registered commands; fixed core and host-discovered commands join at runtime. <!-- STATS:pipeline_step_count -->113<!-- /STATS --> built-in actions (<!-- STATS:pipeline_registered_step_count -->58<!-- /STATS --> registered + <!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --> transport-native), BM25 bilingual search. `npm install -g @zenalexa/unicli`

<!-- END COUNTS -->

<!-- BEGIN ADAPTERS -->

## What You Can Do

### Web (183+ sites)

**Chinese**: zhihu (37), xiaohongshu (23), bilibili (20), douyin (13), douban (12), v2ex (12), weibo (12), linux-do (11), +28 more (`unicli list`)

**International**: twitter (52), instagram (29), reddit (24), tiktok (18), youtube (17), bluesky (16), nowcoder (16), discord-app (15), +85 more (`unicli list`)

**AI / ML**: chatgpt (18), antigravity (17), chatwise (17), notebooklm (15), claude (14), doubao-app (14), yollomi (12), deepseek (9), +17 more (`unicli list`)

**Finance**: eastmoney (18), xueqiu (14), binance (13), coingecko (7), sinafinance (5), barchart (4), yahoo-finance (3), coinbase (2), +2 more (`unicli list`)

**Developer**: codex (19), cursor (19), gh (16), stackoverflow (10), vscode (10), docker-desktop (7), github-desktop (7), gitkraken (7), +29 more (`unicli list`)

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

| Topic                   | Where                        |
| ----------------------- | ---------------------------- |
| Adapter format          | `docs/ADAPTER-FORMAT.md`     |
| Built-in action surface | `src/engine/step-surface.ts` |
| Strategy semantics      | `src/types.ts`               |

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
Allowlist: `ref/**`, `archive/**`, `CHANGELOG.md` (frozen history), and the
generated `docs/releases.md` plus `docs/zh/releases.md` projections of that
same history.

Public OSS idiom that stays on the public surface: `structured error
envelope`, `envelope completeness`, `agent self-repair`, `repair loop`,
`agent-readable YAML`. These read as engineering on the public surface.

If `boundary-guard` flags a file, the fix is either to rewrite the term in
engineering vocabulary or to move the file under `ref/`. Do not add an
allowlist entry without a one-line `// REASON:` justification in
`scripts/boundary-guard.ts` patterns array.

## Version

1.1.1 — Artemis · Koch

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
meta-tools; `--expanded` exposes those tools plus one tool per
runtime adapter command. Check the exact deferred/expanded count with
`unicli mcp health -f json`. The registry manifest is shipped at `server.json`
for the official MCP registry.
