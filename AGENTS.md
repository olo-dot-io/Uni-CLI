# Uni-CLI

<!-- IF YOU ARE AN AI AGENT: Read this file. It tells you everything you need.
     Install: npm install -g @zenalexa/unicli
     Discover: unicli search "your intent" (bilingual EN/ZH)
     Run: unicli <site> <command> [args]
     Output is JSON when piped. Errors are structured JSON to stderr.
     You can fix broken adapters yourself — read the Self-Repair section. -->

<!-- BEGIN COUNTS -->

> <!-- STATS:site_count -->195<!-- /STATS --> sites, <!-- STATS:command_count -->956<!-- /STATS --> commands, <!-- STATS:pipeline_step_count -->31<!-- /STATS --> pipeline steps, BM25 bilingual search. `npm install -g @zenalexa/unicli`

<!-- END COUNTS -->

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

<!-- BEGIN ADAPTERS -->

## What You Can Do

### Web (108+ sites)

**Chinese**: douban (12), hupu (7), jike (10), linux-do (10), tieba (4), v2ex (12), weibo (10), xiaohongshu (22), zhihu (21), bilibili (17), douyin (13), douyu (2), kuaishou (2), 1688 (3), dangdang (2), dianping (2), ele (2), jd (3), maoyan (2), meituan (2), pinduoduo (2), smzdm (3), taobao (2), xianyu (3), sspai (2), weread (7), zsxq (5), baidu (2), ctrip (2), jianyu, jimeng (2), ke (2), maimai, mubu (2), quark (2), sinablog (4), toutiao (2), wechat-channels (2), weixin (4), xiaoe (5), yuanbao (3)

**International**: band (4), bluesky (12), facebook (12), instagram (26), lobsters (5), mastodon (4), reddit (20), twitter (34), tiktok (16), twitch (4), youtube (8), amazon (8), coupang (3), medium (5), pixiv (6), substack (4), boss (14), linkedin (4), steam (6), adguardhome (5), chrome (2), cursor, dingtalk, discord-app, feishu (4), itch-io (3), lesswrong (15), notion (3), notion-app, obs (8), obsidian (3), ones (11), pexels (2), slack (7), threads (2), unsplash (2), vscode (3), ycombinator, yollomi (12), zoom (2), zotero (8)

**AI / ML**: deepseek (2), doubao (3), doubao-web (9), gemini (5), grok, hf (4), huggingface-papers (2), minimax (3), notebooklm (15), novita (3), ollama (4), openrouter (2), perplexity, replicate (3)

**Finance**: barchart (4), binance (3), coinbase (2), eastmoney (4), futu (2), sinafinance (5), xueqiu (12), yahoo-finance (3)

**Developer**: cocoapods (2), crates-io (3), devto (5), docker-hub (3), gitee (3), github-trending (3), gitlab (3), homebrew (2), npm (4), npm-trends (2), producthunt (5), pypi (3), stackoverflow (6)

**News**: 36kr (5), bbc (4), bloomberg (10), cnn (2), hackernews (10), infoq (2), ithome (3), nytimes (2), reuters (4), techcrunch (2), theverge (2)

**Reference**: arxiv (3), chaoxing (2), cnki, dictionary (3), google (4), imdb (7), paperreview (3), wikipedia (5), apple-podcasts (3), netease-music (4), spotify (4), xiaoyuzhou (3), exchangerate (2), ip-info, qweather (2), web

### macOS (58 cmds)

active-app, apps, apps-list, battery, bluetooth, brightness, caffeinate, calendar-create, calendar-list, calendar-today, clipboard, contacts-search, dark-mode, disk-info, disk-usage, do-not-disturb, empty-trash, finder-copy, finder-move, finder-new-folder, finder-recent, finder-selection, finder-tags, lock-screen, mail-send, mail-status, messages-send, music-control, music-now, notes-list, notes-search, notification, notify, open, open-app, photos-search, processes, reminder-create, reminders-complete, reminders-list, safari-history, safari-tabs, safari-url, say, screen-lock, screen-recording, screenshot, shortcuts-list, shortcuts-run, sleep, spotlight, system-info, trash, uptime, volume, wallpaper, wifi, wifi-info

### Desktop (24 apps)

audacity (8 cmds), blender (13 cmds), cloudcompare (4 cmds), comfyui (4 cmds), docker (7 cmds), drawio, ffmpeg (11 cmds), freecad (15 cmds), gimp (12 cmds), godot (2 cmds), imagemagick (6 cmds), inkscape (3 cmds), kdenlive (3 cmds), krita (4 cmds), libreoffice (2 cmds), mermaid, motion-studio, musescore (5 cmds), pandoc, renderdoc (2 cmds), shotcut (3 cmds), sketch (3 cmds), slay-the-spire-ii (6 cmds), wiremock (5 cmds)

### Bridge (3 CLIs)

gh (5 cmds), jq (2 cmds), yt-dlp (4 cmds)

<!-- END ADAPTERS -->

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

0.211.2 — Vostok · Volynov
