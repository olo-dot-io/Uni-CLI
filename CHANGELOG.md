# Changelog

All notable changes to Uni-CLI are documented here.
Version format: `MAJOR.MINOR.PATCH` — see [docs/TASTE.md](./docs/TASTE.md) for the codename system.

## [0.207.1] — 2026-04-06 — Vostok · Gagarin (Hotfix)

### Fixed

- **Node 20 compatibility**: replaced `node:fs` `globSync` (Node 22+) with manual glob implementation in repair engine
- **Shell injection prevention**: all `execSync` string interpolation in repair engine replaced with `execFileSync` + argument arrays; site/command names validated against `[a-z0-9._-]` pattern
- **Lower-direction metric**: verify failures now return `Infinity` (not `0`) for `direction: "lower"`, preventing broken commits from being kept as improvements
- **CDP flat session protocol**: `sessionId` now placed at top-level of JSON-RPC envelope (not inside `params`), fixing multi-tab recording
- **Interceptor data pipeline**: JS interceptor now captures HTTP method, status code, and request body — enables write candidate detection (POST/PUT/PATCH) in `unicli record`
- **Diagnostic crash prevention**: `parseDiagnostic` validates parsed JSON shape before cast, preventing TypeError on truncated payloads
- **DaemonPage network capture**: `startNetworkCapture` and `readNetworkCapture` methods added to DaemonPage, enabling CDP-first path in `unicli operate`

### Security

- **JWT full redaction**: entire JWT token replaced with `[JWT-REDACTED]` (previously only signature was redacted, leaking payload claims)
- **Upload path boundary**: `operate upload` now blocks paths outside workspace and home directory
- **Bracket-notation param redaction**: `token[]`, `auth[token]` etc. now matched by sensitive param filter
- **Body redaction depth limit**: recursive `redactBody` capped at 50 levels to prevent stack overflow

### Changed

- Failure classifier: 404 status only classified as `api_versioned` when URL contains API path pattern; generic 404 falls through to `unknown`
- `extractPerfectScore` cached from first successful verify output instead of re-running verify command each iteration
- `safeRevert` uses `git reset --hard HEAD~1` directly instead of creating noisy revert commits
- `isNoiseUrl` now correctly filters `facebook.com` domain (was dead code with `/tr` path in hostname check)
- `endpointSortKey` uses first array item's key count for wrapped responses like `{data: [...], total: N}`
- `explore.ts` uses real interceptor method/status data instead of fabricating `GET`/`200`
- Record and explore request capture arrays capped at 10,000 entries to prevent OOM
- Record polling has re-entrancy guard to prevent overlapping captures
- `extractMetric` resets `lastIndex` before exec for global/sticky regex safety
- `EvalJudge` type changed to discriminated union for type-safe value access
- `operate` string escaping uses `JSON.stringify` instead of hand-rolled replace chains
- `templatizeUrl` skips duplicate query parameters

## [0.207.0] — 2026-04-06 — Vostok · Gagarin

### Added

- **Self-Repair Loop**: `unicli repair <site> [cmd] --loop` — Karpathy-style autonomous adapter repair with failure-type-aware prompting (selector_miss, auth_expired, api_versioned, rate_limited). 8-phase loop: review → classify → modify (Claude Code) → commit → verify → guard → decide → log. Stuck hint escalation at 3/5/7/9/11 consecutive discards.
- **Eval Harness**: `unicli repair --eval <file>` — run evaluation suite with 4 judge criteria (contains, arrayMinLength, nonEmpty, matchesPattern). Outputs `SCORE=N/M` for metric extraction.
- **Endpoint Analysis Module**: `src/engine/analysis.ts` — shared boolean filters (`isNoiseUrl`, `isStaticResource`, `isUsefulEndpoint`) + transparent sort key (`endpointSortKey`) replacing opaque numeric scoring.
- **Record Multi-Tab**: CDP `Target.setDiscoverTargets` for cross-tab network capture, write candidate generation (POST/PUT/PATCH replay), URL parameter templatization (query → `${{ args.query }}`), request deduplication.
- **Explore Interactive Fuzzing**: `unicli explore --interactive` — click buttons, tabs, and anchors to trigger additional XHR endpoints. iframe re-fetch for empty-body GET JSON endpoints.
- **Operate CDP-First Network**: `operate open` pre-navigation capture, `operate network` prefers CDP `readNetworkCapture()` with JS interceptor fallback.

### Changed

- Endpoint scoring replaced: numeric `scoreEndpoint()` → boolean filter cascade (`isNoiseUrl` → `isStaticResource` → `isUsefulEndpoint`) + `endpointSortKey([itemCount, fieldCount, isApiPath, hasParams])`
- `endpoint-scorer.ts` rewritten as thin facade re-exporting from `analysis.ts`
- `synthesize.ts`: removed `--min-score` parameter, uses `isUsefulEndpoint()` instead

### Security

- Diagnostic redaction: JWT signature stripping (Cloudflare har-sanitizer pattern), sensitive header/URL param/body key redaction, 3-level size degradation (128KB/192KB/256KB cap)
- `redactUrl` handles relative URLs safely, `redactBody` has circular reference protection (WeakSet guard)
- `isNoiseUrl` matches against hostname only (not full URL string), preventing false positives from query parameters

### Fixed

- RegExp matching in analysis: noise domains checked against hostname, capability patterns against pathname only
- Record URL templatization preserves URL auth credentials and port numbers in dedup keys
- Record generates correct YAML args shape (mapping, not list) matching loader expectations
- Repair engine: correct metric comparison for `direction: 'lower'`, scope file re-resolution after Claude modifications

## [0.206.0] — 2026-04-05 — Vostok · Tereshkova

### Added

- **Adapter Generation Engine**: `unicli explore <url>` (API discovery), `unicli synthesize <site>` (YAML candidate generation), `unicli generate <url>` (one-shot explore+synthesize+select) — complete adapter generation pipeline with endpoint scoring algorithm
- **Browser Enhancements**: DOM settle detection via MutationObserver, network body capture with `startNetworkCapture`/`readNetworkCapture`, navigate with `waitUntil: networkidle`, click with x/y coordinates, interceptor regex patterns + text capture + multi-capture
- **Diagnostic Engine**: `RepairContext` module — full error context with DOM snapshot, network requests, console errors, and adapter source for AI agent self-repair. Triggered via `UNICLI_DIAGNOSTIC=1`
- **Plugin System v1**: Custom step registration (`registerStep`), manifest-based plugin loader (`unicli-plugin.json`), `unicli plugin install/uninstall/list/create/steps` commands
- **Agent-Native Primitives**: `assert` step (URL/selector/text/condition), `extract` step (structured browser data extraction with CSS selectors and type coercion), `retry` property on any step with exponential backoff
- **Smart Cookie Refresh**: Auto-detect 401/403 on cookie/header adapters → navigate Chrome → re-extract cookies via CDP
- **Infrastructure**: HTTP proxy support (`http_proxy`/`https_proxy`/`no_proxy` via undici), update auto-checker (24h cache, non-blocking), `unicli health [site]` (adapter health monitoring), `unicli agents generate` (AGENTS.md auto-generation)
- **New Sites (8)**: linkedin, jd, weixin, reuters, barchart, 1688, smzdm, sinablog — 26 new adapter commands
- **Operate Enhancements**: `operate upload <ref> <path>`, `operate hover <ref>`
- **Pipeline Steps**: assert, extract → 30 → 35 total (including retry as a cross-cutting property)

### Changed

- Pipeline engine: `SIBLING_KEYS` extended with `retry`, `backoff`; `executeStep` default case checks plugin custom step registry
- `fetchJson` and `stepFetchText` now use proxy agent when proxy env vars set
- `BrowserPage.goto()` uses DOM settle detection (MutationObserver) instead of simple setTimeout
- CLI startup: non-blocking update check + plugin loading before hook emission

## [0.205.0] — 2026-04-05 — Vostok · Bykovsky

### Added

- **Pipeline**: 7 new steps — `set`, `if/else`, `append`, `each`, `parallel`, `rate_limit`, plus `fallback` property (23 → 30 steps)
- **CDP Direct Mode**: Zero-extension browser auth — direct CDP connection, smart cookie extraction, auto-launch Chrome
- **Self-Repair**: Level 1 auto-fix (detect `selector_miss`, suggest alternative paths), Level 3 community-fix stub
- **Bridge CLIs**: 19 new bridges — vercel, supabase, wrangler, lark, dingtalk, hf, claude-code, codex-cli, opencode, aws, gcloud, az, doctl, netlify, railway, flyctl, pscale, neonctl, slack
- **DX**: `unicli init` (adapter scaffolding), `unicli dev` (hot-reload), `unicli adapter install/list` (marketplace)
- **Documentation**: VitePress site with DESIGN.md theme (Geist Mono + Terminal Green), 7 content pages
- **Browser**: `unicli browser cookies <domain>`, `--profile`, `--headless` options
- **Infrastructure**: npm publish config, rate limiter module, cookie extractor module

### Changed

- `acquirePage()` now prioritizes direct CDP over daemon (CDP → daemon → auto-launch)
- Cookie loading now transparently falls back to CDP extraction from Chrome
- Pipeline engine refactored: `executeStep()` helper, `getActionEntry()` + `SIBLING_KEYS`

### Security

- Path traversal guard on cookie `saveCookies()` and `loadCookies()`
- Port validation for `UNICLI_CDP_PORT` environment variable
- Recursion depth limit (max 10) for nested `if` and `each` steps

---

## [0.204.0] — Vostok · Nikolayev

### Engine Core (Sub-Project A)

- **6 new pipeline steps** — press, scroll, snapshot (DOM a11y tree), tap (Vue Store Bridge), download (HTTP+yt-dlp), websocket (OBS auth)
- **9 new BrowserPage methods** — insertText, nativeClick, nativeKeyPress, setFileInput, autoScroll, screenshot, networkRequests, snapshot, closeWindow
- **9 new pipe filters** — slugify, sanitize, ext, basename, keys, json, abs, round, ceil, floor, int, float, str, reverse, unique (total: 29)
- **VM sandbox migration** — replaced `new Function()` with hardened `vm.runInNewContext()` (null-prototype, frozen built-ins, 50ms timeout)
- **Dual interceptor** — fetch + XHR monkey-patching with WeakMap anti-detection stealth
- **Stealth upgrade** — 6 → 13 anti-detection patches (CDP cleanup, Error.stack filter, Performance API, iframe chrome consistency)

### Daemon + Browser Bridge (Sub-Project B)

- **Browser daemon** — standalone HTTP+WS server (port 19825), auto-spawn, 4h idle timeout, CSRF protection
- **DaemonPage** — IPage implementation over daemon HTTP (reuses Chrome login sessions)
- **Chrome extension** — Manifest V3 service worker, workspace isolation, command dispatch via chrome.debugger
- **`operate` command** — 16 interactive browser subcommands (open, state, click, type, keys, scroll, screenshot, eval, network, etc.)
- **`record` command** — capture network requests and auto-generate YAML adapters
- **Shell completion** — bash, zsh, fish tab completion
- **Daemon-first page acquisition** — yaml-runner tries daemon before direct CDP

### Electron App Control (Sub-Project C)

- **8 Electron apps** — Cursor, Codex, ChatGPT, Notion, Discord, ChatWise, Doubao, Antigravity
- **66 commands** via shared AI chat pattern + per-app specialization
- **App registry** — auto-discovery, CDP port assignment, user-extensible via ~/.unicli/apps.yaml

### New Web Sites (Sub-Project D)

- **+39 sites, +293 commands** — xiaohongshu (13), douyin (13), instagram (19), tiktok (15), facebook (10), amazon (8), boss (14), pixiv (6), hupu (7), xianyu (3), ones (11), notebooklm (15), doubao-web (9), lesswrong (15), gemini (+2 deep-research), yollomi (12), and 13 more P2 sites
- **Existing site gaps filled** — xueqiu fund-holdings, hupu mentions

### Desktop Expansion (Sub-Project E)

- **FreeCAD** 2→15 commands, **Blender** 4→13, **GIMP** 3→12
- **13 new apps** — OBS Studio (8, WebSocket), Zotero (8), Audacity/Sox (8), Krita (4), Kdenlive (3), Shotcut (3), MuseScore (5), CloudCompare (4), WireMock (5), AdGuardHome (5), Novita (3), Sketch (3), Slay the Spire II (6)

### Ecosystem (Sub-Project F)

- **Plugin system** — `unicli plugin install/uninstall/list/update` with GitHub/local sources
- **Lifecycle hooks** — onStartup, onBeforeExecute, onAfterExecute (globalThis singleton, sequential execution)

### Security

- Shell injection fix in plugin.ts (execFileSync replaces execSync)
- Path traversal prevention (plugin name validation + startsWith guard)
- JS injection prevention in operate commands (ref validation, JSON.stringify selectors)
- VM sandbox hardening (null-prototype, frozen built-ins, contextCodeGeneration restrictions)
- Tap step sanitization (identifier regex for store/action names)
- Fetch concurrency cap (mapConcurrent with limit=5)
- Network buffer cap (500 entries max)

### Metrics

| Metric          | v0.203.0 | v0.204.0 |
| --------------- | -------- | -------- |
| Sites           | 57       | 96       |
| Commands        | 289      | 582      |
| Pipeline steps  | 17       | 23       |
| Pipe filters    | 14       | 29       |
| Stealth patches | 6        | 13       |
| Tests           | ~137     | 2272     |

---

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
