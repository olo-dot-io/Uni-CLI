# Uni-CLI

<!-- IF YOU ARE AN AI AGENT: Read this file. It tells you everything you need.
     Install: npm install -g @zenalexa/unicli
     Discover: unicli search "your intent" (bilingual EN/ZH)
     Run: unicli <site> <command> [args]
     Output is JSON when piped. Errors are structured JSON to stderr.
     You can fix broken adapters yourself — read the Self-Repair section. -->

<!-- BEGIN COUNTS -->

> <!-- STATS:site_count -->200<!-- /STATS --> sites, <!-- STATS:command_count -->968<!-- /STATS --> commands, <!-- STATS:pipeline_step_count -->31<!-- /STATS --> pipeline steps, BM25 bilingual search. `npm install -g @zenalexa/unicli`

<!-- END COUNTS -->

## For AI Agents

Universal CLI for websites, desktop apps, and local tools. JSON when piped. Self-repairing YAML adapters.

```bash
unicli search "推特热门"             # Find commands by intent (bilingual)
unicli <site> <command> [options]    # Run any command
unicli repair <site> <command>       # Diagnose + fix a broken adapter
unicli list                          # All commands (JSON when piped)
```

## Install

```bash
npm install -g @zenalexa/unicli
```

<!-- BEGIN ADAPTERS -->

## What You Can Do

### Web (108+ sites)

**Chinese**: xiaohongshu (22), zhihu (21), bilibili (17), douyin (13), douban (12), v2ex (12), jike (10), linux-do (10), +33 more (`unicli list`)

**International**: twitter (34), instagram (26), reddit (20), tiktok (16), lesswrong (15), boss (14), bluesky (12), facebook (12), +38 more (`unicli list`)

**AI / ML**: notebooklm (15), doubao-web (9), gemini (5), hf (4), ollama (4), doubao (3), minimax (3), novita (3), +6 more (`unicli list`)

**Finance**: xueqiu (12), sinafinance (5), barchart (4), eastmoney (4), binance (3), yahoo-finance (3), coinbase (2), futu (2)

**Developer**: stackoverflow (6), devto (5), producthunt (5), npm (4), crates-io (3), docker-hub (3), gitee (3), github-trending (3), +5 more (`unicli list`)

**News**: bloomberg (10), hackernews (10), 36kr (5), bbc (4), reuters (4), ithome (3), cnn (2), infoq (2), +3 more (`unicli list`)

**Reference**: imdb (7), wikipedia (5), google (4), netease-music (4), spotify (4), arxiv (3), dictionary (3), paperreview (3), +8 more (`unicli list`)

### macOS (58 cmds)

active-app, apps, apps-list, battery, bluetooth, brightness, caffeinate, calendar-create, calendar-list, calendar-today, clipboard, contacts-search, … (`unicli list --site macos`)

### Desktop (24 apps)

freecad (15 cmds), blender (13 cmds), gimp (12 cmds), ffmpeg (11 cmds), audacity (8 cmds), docker (7 cmds), imagemagick (6 cmds), slay-the-spire-ii (6 cmds), +16 more (`unicli list --category desktop`)

### Bridge (3 CLIs)

gh (5 cmds), jq (2 cmds), yt-dlp (4 cmds)

<!-- END ADAPTERS -->

## Authentication

Some sites require cookies:

```bash
unicli auth setup <site>    # Show required cookies + template
unicli auth check <site>    # Validate cookie file
unicli auth list            # List configured sites
```

Cookie file format: `{ "SESSDATA": "value", "bili_jct": "value" }`. Store at `~/.unicli/cookies/<site>.json`.

Sites requiring auth: bilibili, weibo, zhihu, twitter, xueqiu, zsxq, jike, weread, douban, linux-do, v2ex (some commands).

## Output Protocol

- **Piped** → auto-JSON, zero flags needed
- **TTY** → human-readable table
- **Errors** → structured JSON on stderr: `{ adapter_path, step, action, suggestion }`
- **Exit codes**: 0 ok, 66 empty, 69 unavailable, 75 temp, 77 auth, 78 config

## Self-Repair Protocol

When a command fails:

```
1. Read error JSON → get adapter_path
2. Open the YAML (~20 lines, no imports)
3. Edit the failing step (URL changed, selector moved, auth needed)
4. Save to ~/.unicli/adapters/<site>/<command>.yaml
5. Verify: unicli repair <site> <command>
```

Fixes persist in `~/.unicli/adapters/` and survive `npm update`.

## Creating Adapters

```yaml
site: example
name: search
type: web-api
strategy: public
pipeline:
  - fetch: { url: "https://api.example.com/search?q=${{ args.query }}" }
  - select: data.results
  - map: { title: "${{ item.title }}", url: "${{ item.url }}" }
  - limit: ${{ args.limit }}
args:
  query: { type: str, required: true, positional: true }
  limit: { type: int, default: 20 }
columns: [title, url]
```

Full reference: [`docs/ADAPTER-FORMAT.md`](docs/ADAPTER-FORMAT.md).

## Pipeline Steps

31 steps across 5 families — api (fetch, fetch_text, parse_rss, html_to_md), transform (select, map, filter, sort, limit), control (set, if, each, parallel, rate_limit, assert, retry, append), browser (navigate, evaluate, click, type, press, scroll, intercept, snapshot, tap, extract, wait), other (exec, write_temp, download, websocket). See [`docs/ADAPTER-FORMAT.md`](docs/ADAPTER-FORMAT.md) for the full table with examples.

## MCP Server

```bash
npx @zenalexa/unicli mcp serve                                # stdio (4 meta-tools)
npx @zenalexa/unicli mcp serve --transport streamable --port 19826
npx @zenalexa/unicli mcp serve --transport sse --port 19826   # SSE for remote
npx @zenalexa/unicli mcp serve --auth                         # OAuth 2.1 PKCE
```

Default tools: `unicli_run`, `unicli_list`, `unicli_search`, `unicli_explore`. Agents call `unicli_search` first (bilingual BM25), then `unicli_run` with the chosen site + command.

## ACP (avante.nvim / Zed)

```bash
unicli acp          # JSON-RPC 2.0 over stdio
```

See [`docs/AVANTE.md`](docs/AVANTE.md).

## External CLI Passthrough

35 registered external CLIs. If installed on your system, they're available as top-level commands:

```bash
unicli ext list                    # Show all external CLIs + install status
unicli ext install <name>          # Install an external CLI
unicli lark-cli calendar +agenda   # Direct passthrough
```

## Version

0.211.2 — Vostok · Volynov
