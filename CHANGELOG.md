# Changelog

All notable changes to Uni-CLI are documented here.
Version format: `MAJOR.MINOR.PATCH` — see [docs/TASTE.md](./docs/TASTE.md) for the codename system.

## [0.203.0] — Vostok · Leonov

### Engine — Browser Strategy

- **CDP client** — raw WebSocket Chrome DevTools Protocol, zero new runtime dependencies
- **BrowserPage** — goto, evaluate, click, type, press, cookies, scroll, waitForSelector
- **Chrome launcher** — auto-discover/start Chrome with `--remote-debugging-port`
- **Stealth injection** — anti-detection evasions (webdriver, plugins, permissions, toString)
- **6 new pipeline steps** — navigate, evaluate, click, type, wait, intercept
- **Strategy cascade** — auto-probe PUBLIC → COOKIE → HEADER
- CLI: `unicli browser start`, `unicli browser status`

### Web Adapters — Write Operations

- twitter: +15 write commands (post, like, reply, follow, unfollow, block, unblock, bookmark, unbookmark, delete, hide-reply, download, article, accept, reply-dm) — total 25 commands

### Web Adapters — Platform Expansions

- jike: +9 (create, like, repost, comment, search, notifications, post, topic, user)
- douban: +6 (subject, top250, marks, reviews, photos, download)
- weibo: +4 (feed, post, search, user)
- weread: +4 (book, highlights, notebooks, notes)
- zsxq: +3 (dynamics, search, topic)
- reddit: +7 (comment, read, save, saved, subscribe, upvote, upvoted)
- linux-do: +8 (categories, category, feed, search, tags, topic, user-posts, user-topics)
- xueqiu: +8 (stock, fund-snapshot, comments, feed, watchlist, search, hot-stock, earnings-date)
- medium: +2 (feed, user)
- producthunt: +3 (browse, posts, today)
- sinafinance: +2 (news, stock)
- 36kr: +3 (article, hot, search)
- v2ex: +2 (daily, user)
- substack: +2 (feed, publication)
- imdb: +2 (person, reviews)
- bloomberg: +1 (news), google: +2 (search, trends), bilibili: +1 (dynamic), zhihu: +1 (download), tieba: +1 (read)

### Infrastructure

- Manifest builder includes TS adapter metadata
- Browser module: cdp-client.ts, page.ts, launcher.ts, stealth.ts
- 119 unit tests (was 42)

**Stats: 57 sites, 289 commands (was 203 — +86 commands, +77 tests)**

---

## [0.202.0] — Vostok · Tereshkova

### Engine

- Cookie authentication strategy — reads cookies from `~/.unicli/cookies/<site>.json`
- Cookie injection in fetch/fetch_text pipeline steps (strategy=cookie)
- `write_temp` pipeline step for desktop adapters (temp file creation + auto-cleanup)
- `auth` CLI commands: `auth setup`, `auth check`, `auth list`
- Async TS adapter loading via dynamic import (loadTsAdapters)
- `PipelineOptions` for passing site/strategy context to pipeline engine

### Web Adapters — Chinese Platforms (3 new sites, 18 commands)

- bilibili: 12 commands (hot, ranking, feed, following, me, history, favorites, search, user-videos, comments, subtitle, download) — WBI signed + cookie auth
- weibo: 5 commands (hot, timeline, profile, comments, me) — cookie auth
- zhihu: 6 commands (hot, feed, question, search, me, notifications) — cookie auth

### Web Adapters — International (2 new sites, 15 commands)

- twitter: 10 commands (search, profile, timeline, bookmarks, trending, likes, thread, followers, following, notifications) — GraphQL + Bearer token + cookie auth
- youtube: 5 commands (search, video, channel, comments, transcript) — InnerTube API

### Web Adapters — P1/P2 Sites (8 new sites, 19 commands)

- douban: 3 commands (movie-hot, book-hot, search)
- xueqiu: 2 commands (hot, quote)
- linux-do: 2 commands (hot, latest) — Discourse API
- jike: 1 command (feed) — GraphQL
- zsxq: 2 commands (groups, topics) — cookie auth
- medium: 1 command (search)
- sinafinance: 2 commands (rolling-news, stock-rank)
- Expanded: v2ex (+2: notifications, me), weread (+1: shelf), tieba (+2: search, posts), reddit (+1: comments)

### Desktop Adapters (2 new apps, 5 commands)

- gimp: 3 commands (resize, convert, info) — Script-Fu via exec stdin
- freecad: 2 commands (export-stl, info) — Python via write_temp + exec

### Infrastructure

- Reference repos (opencli, CLI-Anything) synced to `/ref/` (gitignored, `npm run sync:ref`)
- `authCookies` field in adapter manifests for declaring required cookies
- `Strategy` re-exported from registry.ts for TS adapter pattern
- Manifest builder now includes TS adapter metadata (regex extraction from source)
- Fixed `sync:ref` script to use `--rebase` for divergent branches

**Stats: 57 sites, 203 commands (was 43 sites, 141 commands — +14 sites, +62 commands)**

---

## [0.201.0] — Vostok · Chaika II

### Engine

- POST JSON body template resolution in fetch steps
- Exec stdin pipe for desktop tools (mermaid, pandoc, jq)
- Exec environment variables and file output support
- HTML-to-Markdown conversion step via turndown
- Retry with exponential backoff for fetch steps (429/5xx)

### Web Adapters (12 new sites)

- tieba, 36kr, substack, producthunt
- google (suggest, news), imdb (search, title, top, trending)
- web/read (HTML to Markdown), ctrip, paperreview, spotify
- xiaoyuzhou expanded (episode, podcast-episodes)

### Bridge Adapters (4 new tools, 16 commands)

- gh (repo, issue, pr, release, run)
- docker (ps, images, run, build, logs)
- yt-dlp (download, info, search, extract-audio)
- jq (query, format)

### Desktop Adapters (10 new apps, 36 commands)

- ffmpeg expanded to 11 commands (probe, trim, gif, etc.)
- imagemagick (convert, resize, identify, composite, montage, compare)
- pandoc (universal document converter)
- libreoffice (headless convert, print)
- mermaid (diagram rendering via stdin)
- inkscape (SVG export, convert, optimize)
- blender expanded (info, convert, animation)
- musescore (export, convert)
- drawio (diagram export)
- comfyui (generate, status, history, nodes)

### Stats

- Sites/apps: 21 → 43 (+22)
- Commands: 74 → 141 (+67)
- Engine steps: 9 → 10 (html_to_md)
- Unit tests: 18 → 27

## [0.200.0] — Vostok · Chaika

> _1961 — First human in space. Yuri Gagarin orbited Earth in 108 minutes._
> _Chaika (Seagull) — Valentina Tereshkova's call sign. First woman in space._

### Engine

- Pipe filter system: 15 filters (join, urlencode, truncate, strip_html, slice, replace, split, first, last, length, trim, default, lowercase, uppercase)
- RSS/XML parsing: `fetch_text` + `parse_rss` pipeline steps
- Desktop exec: `exec` step with json/lines/csv/text output parsing
- Sort step: `sort` with by/order
- Resilient loader: skip malformed YAML gracefully

### Self-Repair Architecture

- Structured pipeline errors: JSON with adapter_path, step, action, suggestion
- `unicli repair <site> <command>` — diagnostic + fix suggestions
- `unicli test [site]` — smoke test runner
- User adapter overlay: `~/.unicli/adapters/` overrides built-in (survives updates)

### Adapters (21 sites, 74 commands)

New sites: lobsters (4), stackoverflow (4), bluesky (9), devto (3), dictionary (3), steam (1), bbc (1), wikipedia (4), arxiv (2), apple-podcasts (3), hf (1), bloomberg (9), v2ex (7), weread (2), xiaoyuzhou (1)
Completed: hackernews (8/8), reddit (8/8)
Pre-existing: github-trending (1), ollama (1), blender (1), ffmpeg (1)

### Infrastructure

- Build manifest: auto-generated dist/manifest.json
- Version bump: 0.100.1 → 0.200.0

## [0.100.1] — Sputnik · Kedr

> _1957 — The first artificial satellite. First signal from orbit. Proof that it works._
> _Kedr (Cedar) — Gagarin's call sign. The very first patch._

### Added

- YAML pipeline execution engine: `fetch`, `select`, `map`, `filter`, `limit`
- 5 adapter types: `web-api`, `desktop`, `browser`, `bridge`, `service`
- TypeScript adapter support via `cli()` registration helper
- Multi-format output: `table`, `json`, `yaml`, `csv`, `md`
- Auto-detection of piped output (switches to JSON for AI agents)
- Adapter discovery from `src/adapters/` and `~/.unicli/adapters/`
- Exit codes following `sysexits.h` conventions
- Positional and option argument parsing from YAML adapter definitions

### Adapters (6 sites, 8 commands)

- **hackernews**: `top`, `search` — web-api, public
- **reddit**: `hot`, `search` — web-api, public
- **github-trending**: `daily` — web-api, public
- **blender**: `render` — desktop (requires blender)
- **ffmpeg**: `convert` — desktop (requires ffmpeg)
- **ollama**: `list` — service (requires ollama at localhost:11434)

### Agent Integration

- Agent Skills: `unicli-usage`, `unicli-explorer`, `unicli-operate`, `unicli-oneshot`
- AGENTS.md for cross-agent discoverability (Codex, Copilot, Cursor, OpenCode)
- CLAUDE.md for Claude Code integration
- MCP server stub for universal agent connectivity

### Community

- Apache-2.0 license
- CODE_OF_CONDUCT.md, GOVERNANCE.md, CODEOWNERS
- Issue templates: bug report, feature request, adapter request
- CI workflow: Node.js 20/22 matrix on Ubuntu
- Aerospace theme system: [docs/TASTE.md](./docs/TASTE.md)
- Full spaceflight codename registry: [docs/VERSION_CODENAMES.md](./docs/VERSION_CODENAMES.md)
