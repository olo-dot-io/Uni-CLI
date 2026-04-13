# Uni-CLI

<!-- IF YOU ARE AN AI AGENT: Read this file. It tells you everything you need.
     Install: npm install -g @zenalexa/unicli
     Discover: unicli search "your intent" (bilingual EN/ZH)
     Run: unicli <site> <command> [args]
     Output is JSON when piped. Errors are structured JSON to stderr.
     You can fix broken adapters yourself — read the Self-Repair section. -->

> 198 sites, 1020 commands, 35 pipeline steps, BM25 bilingual search. `npm install -g @zenalexa/unicli`

## For AI Agents

Universal CLI for websites, desktop apps, and local tools. JSON when piped. Self-repairing YAML adapters.

```bash
unicli search "推特热门"             # Find commands by intent (bilingual)
unicli search "download video"       # → bilibili download, yt-dlp download, ...
unicli <site> <command> [options]    # Run any command
unicli repair <site> <command>       # Diagnose + fix a broken adapter
unicli test [site]                   # Verify adapters work
unicli list                          # All commands (JSON when piped)
```

## Install

```bash
npm install -g @zenalexa/unicli
```

## What You Can Do

### Web (80+ sites)

**Chinese**: bilibili (14), weibo (10), zhihu (9), douban (12), xueqiu (12),
linux-do (10), jike (10), zsxq (5), tieba (4), weread (7), v2ex (12),
xiaohongshu (14), douyin (13), 36kr (5), sspai (2), smzdm (4), taobao (2),
pinduoduo (2), meituan (2), ctrip (2), netease-music (4), eastmoney (4),
cnki, jd (4), 1688 (4), weixin (5), sinablog (5)

**International**: twitter (27), youtube (5), reddit (20), hackernews (10),
bluesky (12), medium (5), substack (4), producthunt (5), lobsters (5), devto (5),
stackoverflow (6), mastodon (4), facebook (12), instagram (21), tiktok (16),
twitch (4), unsplash (2), pexels (2)

**AI / ML**: ollama (4), openrouter (2), hf (4), huggingface-papers (2),
replicate (3), deepseek, perplexity, grok, gemini (5), minimax (3),
doubao (3), doubao-web (9), novita (3), notebooklm (15)

**Finance**: bloomberg (10), sinafinance (5), xueqiu (12), eastmoney (4),
yahoo-finance (3), barchart (5)

**Developer**: github-trending (3), gitlab (3), gitee (3), npm (4),
pypi (3), crates-io (3), cocoapods (2), docker-hub (3), npm-trends (2),
homebrew (2), stackoverflow (6)

**News**: bbc (4), cnn (2), nytimes (2), reuters (5), techcrunch (2),
theverge (2), infoq (2), ithome (2)

**Reference**: google (4), wikipedia (5), arxiv (3), dictionary (3),
paperreview (3), spotify (4), ctrip (2), xiaoyuzhou (3), steam (6), imdb (7),
exchangerate (2), ip-info, qweather (2), web

### macOS (32 cmds)

reminders-list, reminders-complete, shortcuts-list, shortcuts-run,
calendar-today, notes-list, contacts-search, spotlight, system-info,
battery, disk-usage, clipboard, wifi-info, processes, open-app, say,
screenshot, volume, brightness, apps-list, notification, trash, empty-trash,
dark-mode, active-app, uptime, sleep, do-not-disturb, bluetooth,
finder-selection, screen-lock, safari-tabs

### Desktop (15 apps)

ffmpeg (11 cmds), imagemagick (6), blender (4), gimp (3), freecad (2),
inkscape (3), pandoc, libreoffice (2), mermaid, musescore (2), drawio,
ollama (4), comfyui (4), docker (7), macos (32)

### Bridge (3 CLIs)

gh (5 cmds), yt-dlp (4), jq (2)

## Authentication

Some sites require cookies. The engine reads cookies from `~/.unicli/cookies/<site>.json`:

```bash
unicli auth setup <site>    # Show required cookies + template
unicli auth check <site>    # Validate cookie file
unicli auth list            # List configured sites
```

Cookie file format: `{ "SESSDATA": "value", "bili_jct": "value" }`

Sites requiring auth: bilibili, weibo, zhihu, twitter, xueqiu, zsxq, jike, weread, douban, linux-do, v2ex (some commands)

## Output Protocol

- **Piped** → auto-JSON, zero flags needed
- **TTY** → human-readable table
- **Errors** → structured JSON to stderr with `adapter` path, `step`, `suggestion`
- **Exit codes**: 0=ok, 66=empty, 69=unavailable, 77=auth, 78=config

## External CLI Passthrough

32 external CLIs are registered for passthrough. If installed on your system, they're available as top-level commands:

```bash
unicli ext list                    # Show all external CLIs + install status
unicli ext install <name>          # Install an external CLI
unicli ext run <name> [args]       # Run explicitly
unicli lark-cli calendar +agenda   # Direct passthrough (if installed)
```

Key CLIs: lark-cli (200+ cmds), wecom-cli (100+), dws (86), vercel, supabase, stripe, firebase, wrangler, aliyun (1000+), tccli (500+).

## Self-Repair Protocol

When a command fails, you can fix it:

```
1. Read error JSON → get adapter path
2. Read the YAML file (20 lines, no imports)
3. Edit the YAML (URL changed? selector moved? auth needed?)
4. Save to ~/.unicli/adapters/<site>/<command>.yaml
5. Verify: unicli repair <site> <command>
```

Fixes persist in `~/.unicli/adapters/` and survive `npm update`.

## Creating New Adapters

Drop a YAML file into `src/adapters/<site>/<command>.yaml`:

```yaml
site: example
name: search
description: Search example.com
type: web-api
strategy: public

pipeline:
  - fetch:
      url: "https://api.example.com/search"
      params:
        q: "${{ args.query }}"
  - select: data.results
  - map:
      title: "${{ item.title }}"
      url: "${{ item.url }}"
  - limit: ${{ args.limit }}

args:
  query:
    type: str
    required: true
    positional: true
  limit:
    type: int
    default: 20

columns: [title, url]
```

That's it. No TypeScript, no build step, no imports. The engine handles everything.

## Browser Automation

For sites that require a real browser (intercept/UI strategy):

```bash
unicli browser start          # Launch Chrome with CDP
unicli browser status         # Check connection
```

Requires Chrome. The engine connects via raw CDP WebSocket — zero extensions needed.

## Pipeline Steps (35)

| Step         | What it does                                     |
| ------------ | ------------------------------------------------ |
| `fetch`      | HTTP JSON (GET/POST, retry, backoff, cookies)    |
| `fetch_text` | HTTP raw text (RSS, HTML)                        |
| `parse_rss`  | Extract RSS + Atom feed items                    |
| `html_to_md` | Convert HTML to Markdown                         |
| `select`     | Navigate into JSON (`data.items`)                |
| `map`        | Transform each item via `${{ }}` templates       |
| `filter`     | Keep matching items                              |
| `sort`       | Sort by field                                    |
| `limit`      | Cap results                                      |
| `exec`       | Run subprocess (stdin, env, file output)         |
| `write_temp` | Create temp script file (for desktop adapters)   |
| `navigate`   | Navigate Chrome to URL via CDP                   |
| `evaluate`   | Execute JavaScript in page context               |
| `click`      | Click element by CSS selector                    |
| `type`       | Type text into input element                     |
| `wait`       | Wait for time (ms) or CSS selector to appear     |
| `intercept`  | Capture page network requests matching a pattern |
| `press`      | Keyboard key with modifiers (Ctrl+A, Enter)      |
| `scroll`     | Direction scroll, auto-scroll to bottom          |
| `snapshot`   | DOM accessibility tree with interactive refs     |
| `tap`        | Vue Store Action Bridge (Pinia/Vuex → network)   |
| `download`   | HTTP + yt-dlp, batch concurrent, skip_existing   |
| `websocket`  | WebSocket connect/send/receive (OBS auth)        |
| `set`        | Store variables into `vars` context              |
| `if`         | Conditional execution of sub-pipeline branches   |
| `append`     | Push ctx.data into vars array for accumulation   |
| `each`       | Loop sub-pipeline with do-while + max iterations |
| `parallel`   | Run sub-pipelines concurrently with merge        |
| `rate_limit` | Per-domain token bucket request throttling       |
| `assert`     | Verify page state (URL, selector, text)          |
| `extract`    | Structured data extraction with CSS + types      |
| `retry`      | Generic retry with exponential backoff           |

## Strategies

`public` → `cookie` → `header` → `intercept` → `ui`

The engine auto-probes the first three on first run. `intercept` and `ui` require explicit configuration per adapter.

## MCP Server

```bash
npx @zenalexa/unicli mcp serve              # stdio (default, 4 meta-tools)
npx @zenalexa/unicli mcp serve --expanded   # all 1020 tools with full schemas
npx @zenalexa/unicli mcp serve --transport sse --port 19826  # SSE for remote
npx @zenalexa/unicli mcp serve --auth       # OAuth 2.1 PKCE
```

Default tools: `unicli_run` (execute), `unicli_list` (browse), `unicli_search` (BM25 bilingual discovery), `unicli_explore` (auto-discover from URL).

## Version

0.211.1 — Vostok · Volynov
