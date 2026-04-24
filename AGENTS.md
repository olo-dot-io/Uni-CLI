# Uni-CLI

<!-- IF YOU ARE AN AI AGENT: Read this file. It tells you everything you need.
     Install: npm install -g @zenalexa/unicli
     Discover: unicli search "your intent" (bilingual EN/ZH)
     Agent routing: unicli agents matrix && unicli agents recommend <agent>
     Run: unicli <site> <command> [args]
     Output is structured Markdown by default (non-TTY + agent UA auto-detected). Use -f json for JSON. Errors are structured envelopes to stderr.
     You can fix broken adapters yourself — read the Self-Repair section. -->

<!-- BEGIN COUNTS -->

> <!-- STATS:site_count -->220<!-- /STATS --> sites, <!-- STATS:command_count -->1283<!-- /STATS --> commands, <!-- STATS:pipeline_step_count -->59<!-- /STATS --> pipeline steps, BM25 bilingual search. `npm install -g @zenalexa/unicli`

<!-- END COUNTS -->

## For AI Agents

Universal CLI for websites, desktop apps, and local tools. Markdown when piped (structured envelope). Self-repairing YAML adapters.

```bash
unicli search "推特热门"             # Find commands by intent (bilingual)
unicli <site> <command> [options]    # Run any command
unicli repair <site> <command>       # Diagnose + fix a broken adapter
unicli list                          # All commands (MD when piped)
```

## Install

```bash
npm install -g @zenalexa/unicli
```

<!-- BEGIN ADAPTERS -->

## What You Can Do

### Web (138+ sites)

**Chinese**: xiaohongshu (22), zhihu (21), bilibili (17), douyin (13), douban (12), v2ex (12), jike (10), linux-do (10), +31 more (`unicli list`)

**International**: twitter (34), instagram (26), reddit (20), tiktok (16), discord-app (15), lesswrong (15), slack (14), boss (14), +36 more (`unicli list`)

**AI / ML**: notebooklm (15), antigravity (14), chatgpt (14), chatwise (14), doubao-app (13), doubao-web (9), perplexity (8), claude (7), +13 more (`unicli list`)

**Finance**: xueqiu (12), sinafinance (5), barchart (4), eastmoney (4), binance (3), yahoo-finance (3), coinbase (2), futu (2)

**Developer**: cursor (18), codex (15), vscode (10), docker-desktop (7), github-desktop (7), gitkraken (7), insomnia (7), postman (7), +16 more (`unicli list`)

**News**: bloomberg (10), hackernews (10), 36kr (5), bbc (4), reuters (4), ithome (3), cnn (2), infoq (2), +3 more (`unicli list`)

**Reference**: netease-music (17), spotify (17), linear (10), imdb (7), bitwarden (7), todoist (7), wikipedia (5), google (4), +11 more (`unicli list`)

### macOS (58 cmds)

active-app, apps, apps-list, battery, bluetooth, brightness, caffeinate, calendar-create, calendar-list, calendar-today, clipboard, contacts-search, … (`unicli list --site macos`)

### Desktop (25 apps)

freecad (15 cmds), blender (13 cmds), gimp (12 cmds), ffmpeg (11 cmds), audacity (8 cmds), figma (8 cmds), docker (7 cmds), imagemagick (6 cmds), +17 more (`unicli list --category desktop`)

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

## Output Contract

Commands return v2 `AgentEnvelope` on stdout across adapter, core, ext/dev, and admin surfaces (`agents matrix/recommend/generate`, `auth`, `mcp`, `repair`, etc.). `mcp serve` and `acp` stay raw stdio protocol servers. Format auto-selected — pipe or set an agent UA env var for Markdown.

### Format auto-selection

Priority: `-f` flag > `UNICLI_OUTPUT` env > non-TTY or agent-UA env (`md`) > `md` default. Values: `json | yaml | md | csv | compact`. Agent-UA env vars: `CLAUDE_CODE`, `CODEX_CLI`, `OPENCODE`, `HERMES_AGENT`, `UNICLI_AGENT`.

### Envelope shape

Success:

```yaml
ok: true
schema_version: "2"
command: "twitter.mentions"
meta:
  duration_ms: 412
  count: 20
  surface: web # web | desktop | system | mobile
  pagination:
    has_more: true
    next_cursor: "abc123"
data:
  - { id: "...", text: "...", author: "..." }
error: null
```

Error:

```yaml
ok: false
schema_version: "2"
command: "twitter.mentions"
meta:
  duration_ms: 91
data: null
error:
  code: auth_required # see error codes below
  message: "401 Unauthorized"
  adapter_path: "src/adapters/twitter/mentions.yaml"
  step: 1
  suggestion: "Run: unicli auth setup twitter"
  retryable: false
  alternatives: ["twitter.search", "twitter.timeline"]
```

### MD body sections

Success: `## Data` (per-item list) · `## Context` (surface, pagination) · `## Next Actions`. Error: `## Error` (code, message, adapter_path, step, retryable) · `## Suggestion` · `## Alternatives`. YAML frontmatter carries `ok`, `schema_version`, `command`, `duration_ms`, `count`.

### Error codes

net: `network_error` `rate_limited` `upstream_error` `api_error` `not_authenticated`
input: `invalid_input` `selector_miss` `not_found`
authz: `auth_required` `permission_denied`
runtime: `internal_error` `quarantined`
ref: `stale_ref` `ambiguous` `ref_not_found`

### Exit codes

0 ok · 66 empty · 69 unavailable · 75 temp-fail · 77 auth · 78 config

## Self-Repair Protocol

When a command fails:

```
1. Read error envelope (MD or JSON) → get adapter_path
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

59 registered pipeline steps across api, transform, control, browser, subprocess, and CUA-oriented families. Common steps include fetch, fetch_text, parse_rss, html_to_md, select, map, filter, sort, limit, set, if, each, parallel, rate_limit, assert, retry, append, navigate, evaluate, click, type, press, scroll, intercept, snapshot, tap, extract, wait, exec, write_temp, download, and websocket. See [`docs/ADAPTER-FORMAT.md`](docs/ADAPTER-FORMAT.md) for examples.

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
unicli acp          # ACP compatibility over stdio
```

ACP is an editor compatibility gateway, not the core runtime. Prefer `unicli agents recommend <agent>` for Claude Code, Codex, Cursor, OpenCode, Gemini, Qwen, Kiro, Aider, Goose, Cline, Roo, AgentAPI, etc.

## External CLI Passthrough

58 registered external CLIs. If installed on your system, they're available as top-level commands:

```bash
unicli ext list                    # Show all external CLIs + install status
unicli ext list --tag agent        # Show coding-agent CLIs
unicli ext install <name>          # Install an external CLI
unicli lark-cli calendar +agenda   # Direct passthrough
```

## Version

0.215.1 — Agent Backend Matrix
