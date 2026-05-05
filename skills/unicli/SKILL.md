---
name: unicli
description: >
  Comprehensive guide to using Uni-CLI — the universal CLI for AI agents.
  Trigger when the user needs to fetch data from websites (Twitter, Bilibili,
  HackerNews, GitHub, Reddit, Bloomberg, Zhihu, WeChat, and 230+ more);
  interact with news, finance, social, academic, shopping, or video platforms;
  control macOS desktop apps (Blender, GIMP, Figma, VS Code, Cursor, Terminal,
  Discord, Slack, etc.) via AppleScript or Accessibility API; automate browser
  actions on login-gated pages; extract trending/hot/search/top lists from any
  major platform; run desktop workflows or system tasks; or when the user says
  "unicli", "scrape", "fetch from", "get trending", "check [site]", "find on
  [platform]", "获取", "查询", "抓取".
version: 0.218.0
category: core
depends-on:
  - talk-normal
allowed-tools: [Bash, Read]
protocol: 2.0
triggers:
  - "unicli"
  - "fetch from"
  - "get from"
  - "check twitter"
  - "bilibili"
  - "hackernews"
  - "scrape"
  - "trending"
  - "hot topics"
  - "desktop app"
  - "macOS app"
  - "browser automation"
  - "search web"
  - "social media"
  - "获取"
  - "查询"
  - "抓取"
---

# Uni-CLI — Agent Usage Guide

unicli converts 237 websites, 2,000+ desktop apps, and macOS system tools into
deterministic CLI commands. Each command is a ≤20-line YAML pipeline: fetch data,
transform it, emit a v2 AgentEnvelope. When a command breaks, read the structured
error, edit the YAML adapter, and it stays fixed for all future calls.

**Install** (once): `npm install -g @zenalexa/unicli`

---

## Five-Command Quick Start

```bash
unicli list                              # browse all 3,319 commands
unicli list --site hackernews            # commands for one site
unicli hackernews top --limit 5          # run a command
unicli hackernews top --limit 5 -f json  # machine-readable JSON envelope
unicli describe hackernews top           # full schema + example payload
```

---

## Step 1 — Discover the Right Command

### Find by site

```bash
unicli list --site <site>          # all commands for a site
unicli describe <site> <command>   # args, output columns, example
```

### Search by keyword

```bash
unicli search "trending"           # semantic search across all commands
unicli search "hot stock"          # natural language
```

### Browse by type

```bash
unicli list --type web-api         # REST API adapters (1,138 commands)
unicli list --type desktop         # desktop app control (2,068 commands)
unicli list --type browser         # browser automation (23 commands)
unicli list --type service         # local/remote services (43 commands)
unicli list --type bridge          # passthrough CLI bridges (47 commands)
```

### Check if a site exists

```bash
unicli list --site github-trending  # returns commands or empty
unicli health                        # adapter index summary
```

---

## Step 2 — Run Commands

### Basic syntax

```bash
unicli <site> <command> [<positional-arg>] [--flag value] [-f json|md|yaml|csv]
```

### Key flags (universal)

| Flag                 | Effect                                                     |
| -------------------- | ---------------------------------------------------------- |
| `--limit N`          | Cap output rows (default varies, max 100)                  |
| `-f json`            | Machine-readable v2 AgentEnvelope JSON to stdout           |
| `-f md`              | Agent-native Markdown (default, frontmatter + sections)    |
| `-f yaml`            | YAML envelope                                              |
| `-f csv`             | Flat CSV (array data only)                                 |
| `-f compact`         | One row per line, `\|` separator                           |
| `--args-file <path>` | Read args from a JSON file (avoids shell-quote issues)     |
| `--cursor <token>`   | Pagination cursor from previous envelope `meta.pagination` |

### Common patterns

```bash
# Search
unicli hackernews search "AI agents" --limit 10

# Trending
unicli weibo hot
unicli bilibili hot --limit 20

# Finance
unicli xueqiu hot-stock --limit 10 -f json

# Desktop control
unicli blender render scene.blend output.png
unicli ffmpeg compress video.mp4 -o compressed.mp4

# macOS system
unicli macos volume 60
unicli macos screenshot ~/Desktop/capture.png
```

### Pagination

```bash
# First page
unicli reddit hot --limit 25 -f json | jq '.meta.pagination.next_cursor'

# Next page (use cursor from previous response)
unicli reddit hot --limit 25 --cursor <token> -f json
```

---

## Step 3 — Read the Output

Every command emits a **v2 AgentEnvelope**. Learn the shape once; it applies to
all 3,319 commands.

### JSON structure

```json
{
  "ok": true,
  "schema_version": "2",
  "command": "hackernews.top",
  "meta": {
    "duration_ms": 2805,
    "count": 5,
    "surface": "web",
    "pagination": { "next_cursor": "...", "has_more": true }
  },
  "data": [{ "rank": 1, "title": "...", "score": 80, "url": "..." }],
  "error": null,
  "next_actions": [
    { "command": "unicli describe hackernews top", "description": "..." }
  ]
}
```

### Key fields

| Field             | Meaning                                                      |
| ----------------- | ------------------------------------------------------------ |
| `ok`              | `true` = success, `false` = failure — **always check first** |
| `schema_version`  | Always `"2"` — confirms v2 envelope                          |
| `meta.count`      | Rows returned                                                |
| `meta.pagination` | Non-null when more pages exist; use `.next_cursor`           |
| `data`            | Payload array or object                                      |
| `error`           | `null` on success; structured on failure (see Step 5)        |
| `next_actions`    | HATEOAS hints — valid commands to run next, trust these      |

### Markdown format (default)

When piped or called by an agent, the default format is `md` — YAML frontmatter
followed by formatted sections. Use `-f json` for programmatic parsing.

### Parse with jq

```bash
unicli hackernews top -f json | jq '.[].title'           # WRONG: data is nested
unicli hackernews top -f json | jq '.data[].title'       # correct
unicli hackernews top -f json | jq '.data[] | {title, url}'
unicli xueqiu hot -f json | jq '.data[] | select(.change | tonumber > 5)'
```

---

## Step 4 — Authentication

unicli uses a **strategy cascade** that auto-probes on first run. Most sites need
no manual setup — the cascade promotes from `public` → `cookie` → `header`
automatically.

### Strategy ladder

| Strategy    | Auth needed           | How to set up                                          |
| ----------- | --------------------- | ------------------------------------------------------ |
| `public`    | None                  | Works out of the box                                   |
| `cookie`    | Browser login         | `unicli auth setup <site>` → log in once in browser    |
| `header`    | Cookie + CSRF         | Same as `cookie`; auto-extracted per request           |
| `intercept` | Browser session       | `unicli browser start` then `unicli auth setup <site>` |
| `ui`        | Browser + interaction | Same; unicli clicks through login flow                 |

### Auth setup workflow

```bash
# First time — unicli guides you through browser login
unicli auth setup twitter

# Verify credentials are stored
unicli auth status twitter

# List all authenticated sites
unicli auth list

# Re-authenticate when cookies expire (exit code 77)
unicli auth setup <site>
```

Cookie files live at `~/.unicli/cookies/<site>.json` — never read or edit these
directly; use `unicli auth`.

---

## Step 5 — Handle Errors

### Exit code → action (primary decision tree)

| Code | Meaning                | Action                                             |
| ---- | ---------------------- | -------------------------------------------------- |
| 0    | Success                | Read `data`                                        |
| 1    | Generic error          | Read `error.reason` + `error.suggestion`           |
| 2    | Usage error            | Fix arg syntax; run `unicli describe <site> <cmd>` |
| 66   | Empty result           | Try different query terms or `--limit`             |
| 69   | Service unavailable    | `unicli browser start` then retry                  |
| 75   | Temp failure / timeout | Retry once; if persists → load `unicli-repair`     |
| 77   | Auth required          | `unicli auth setup <site>` then retry              |
| 78   | Config error           | Read `error.suggestion`; check `~/.unicli/` config |

### Failure envelope fields

```json
{
  "ok": false,
  "error": {
    "code": "auth_required",
    "exit_code": 77,
    "message": "No cookie file found for twitter",
    "adapter_path": "adapters/twitter/search.yaml",
    "step": 1,
    "retryable": true,
    "suggestion": "Run `unicli auth setup twitter` to authenticate",
    "remedy": {
      "command": "unicli auth setup twitter",
      "message": "Open browser to complete login"
    }
  }
}
```

### Hard rules

- **ALWAYS check `ok` first** before reading `data`.
- **NEVER retry on exit 2** (usage error — fix the args, not the adapter).
- **Follow `error.remedy.command`** exactly — it is generated from the adapter schema.
- **Load `unicli-repair` skill** when the same command fails twice after following
  `remedy` — the adapter likely needs structural repair, not just a retry.

---

## Browser Mode (Escalation Path)

Use browser mode when: a site requires JavaScript rendering, login-gated access,
interaction (click/type/scroll), or the API adapter returns exit 69.

```bash
unicli browser start             # launch Chrome with CDP (required first)
unicli browser status            # confirm CDP is alive + session state
unicli browser open <url>        # navigate to page
unicli browser state             # DOM accessibility tree with [ref] IDs
unicli browser find --css h2     # query specific elements
unicli browser click <ref>       # interact
unicli browser type <ref> "text" # fill input
unicli browser extract           # extract full page text
unicli browser screenshot        # capture to file
```

For a guided browser automation workflow, load skill `unicli-browser`.

---

## Composition Patterns

### Multi-source research

```bash
# Tech trends: query 3 sources
unicli hackernews top --limit 10 -f json | jq '.data[].title'
unicli reddit hot --limit 10 -f json | jq '.data[].title'
unicli github-trending daily --limit 10 -f json | jq '.data[].name'
```

### Cross-platform topic search

```bash
for site in hackernews reddit twitter; do
  echo "=== $site ===" && unicli $site search "AI agents" --limit 5
done
```

### Data pipeline (pipe to jq)

```bash
unicli bilibili hot -f json \
  | jq '.data[] | select(.view | tonumber > 1000000) | {title, view, up}'
```

### Budget rule: 1–2 primary sources + 1 supplementary per user question. Never

query the same site twice in one turn.

---

## Skill Routing

| Scenario                                     | Load skill            |
| -------------------------------------------- | --------------------- |
| Adapter fails with structured error envelope | `unicli-repair`       |
| Search queries across platforms              | `unicli-smart-search` |
| Browser automation, CDP sessions             | `unicli-browser`      |
| Creating a new adapter from scratch          | `unicli-explorer`     |
| One-shot URL → adapter generation            | `unicli-oneshot`      |
| Claude / Claude.ai commands                  | `unicli-claude`       |
| Claude Code commands                         | `unicli-claude-code`  |
| Hermes integration                           | `unicli-hermes`       |
| Detailed command reference                   | `unicli-usage`        |

---

## Efficiency Rules

1. Default output is `md` (Markdown). Use `-f json` for programmatic parsing.
2. Always set `--limit` — default varies per command (5–50); unset = potentially 100+.
3. MCP server (`unicli mcp serve`) wraps all commands as tools; 4 default tools,
   `--expanded` adds all 3,319 (costs tokens: use only in MCP-only environments).
4. Adapter user overlay: fixes go to `~/.unicli/adapters/<site>/<cmd>.yaml`
   and survive `npm update`.
5. `unicli doctor` checks runtime health (Node version, Chrome, auth files,
   adapter index). Run it when unexplained failures occur.
6. `UNICLI_OUTPUT=json unicli <cmd>` sets JSON globally without `-f json` per call.

---

## Reference Index

| Reference                                      | Load when                                |
| ---------------------------------------------- | ---------------------------------------- |
| [`references/sites.md`](references/sites.md)   | Browsing the site catalog by category    |
| [`references/output.md`](references/output.md) | Parsing AgentEnvelope v2 fields in depth |
| [`references/auth.md`](references/auth.md)     | Auth setup per site, cookie management   |

---

## MCP Server

```bash
unicli mcp serve                    # 4 tools: run, list, search, explore
unicli mcp serve --expanded         # all 3,319 commands as individual tools
unicli mcp serve --profile browser  # browser + CDP tools only
```
