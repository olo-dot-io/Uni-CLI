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

<!-- BEGIN COUNTS -->

> <!-- STATS:site_count -->282<!-- /STATS --> sites, <!-- STATS:command_count -->1680<!-- /STATS --> commands, <!-- STATS:pipeline_step_count -->101<!-- /STATS --> pipeline steps, BM25 bilingual search. `npm install -g @zenalexa/unicli`

<!-- END COUNTS -->

<!-- BEGIN ADAPTERS -->

## What You Can Do

### Web (156+ sites)

**Chinese**: zhihu (25), xiaohongshu (22), bilibili (20), douyin (13), douban (12), v2ex (12), weibo (12), linux-do (11), +31 more (`unicli list`)

**International**: twitter (44), instagram (28), reddit (24), tiktok (17), youtube (16), nowcoder (16), discord-app (15), lesswrong (15), +86 more (`unicli list`)

**AI / ML**: chatgpt (17), antigravity (16), chatwise (16), notebooklm (15), claude (14), doubao-app (13), deepseek (9), doubao (9), +13 more (`unicli list`)

**Finance**: eastmoney (18), xueqiu (14), binance (13), sinafinance (5), barchart (4), yahoo-finance (3), coinbase (2), futu (2)

**Developer**: codex (18), cursor (18), stackoverflow (10), vscode (10), docker-desktop (7), github-desktop (7), gitkraken (7), insomnia (7), +21 more (`unicli list`)

**News**: hackernews (11), bloomberg (10), 36kr (5), bbc (5), reuters (5), ithome (3), cnn (2), infoq (2), +3 more (`unicli list`)

**Reference**: spotify (23), netease-music (17), linear (10), imdb (7), bitwarden (7), todoist (7), arxiv (6), wikipedia (6), +17 more (`unicli list`)

### macOS (60 cmds)

active-app, app-actions, apps, apps-list, automation-smoke, battery, bluetooth, brightness, caffeinate, calendar-create, calendar-list, calendar-today, … (`unicli list --site macos`)

### Desktop (28 apps)

freecad (15 cmds), blender (13 cmds), gimp (12 cmds), ffmpeg (11 cmds), audacity (8 cmds), figma (8 cmds), docker (7 cmds), excel (7 cmds), +20 more (`unicli list --category desktop`)

### Bridge (3 CLIs)

gh (6 cmds), jq (2 cmds), yt-dlp (4 cmds)

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
| Theory / citations          | `docs/THEORY.md`         |

`unicli list` is more authoritative than any inventory in this file — the
project ships at high cadence, written counts go stale fast.

## Version

0.220.0 — Apollo · Lovell

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
