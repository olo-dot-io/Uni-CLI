# Uni-CLI Roadmap — Mission Vostok (0.2xx)

> CLI is all agents need. <!-- STATS:site_count -->200<!-- /STATS --> sites, <!-- STATS:command_count -->968<!-- /STATS --> commands as of v0.212.1.

## Progress

| Version | Codename             | Sites | Commands | Status     |
| ------- | -------------------- | ----- | -------- | ---------- |
| 0.100.0 | Sputnik              | 6     | 8        | ✅         |
| 0.200.0 | Vostok · Chaika      | 21    | 74       | ✅         |
| 0.201.0 | Vostok · Chaika II   | 43    | 141      | ✅         |
| 0.202.0 | Vostok · Tereshkova  | 57    | 203      | ✅         |
| 0.203.0 | Vostok · Leonov      | 57    | 289      | ✅         |
| 0.204.0 | Vostok · Nikolayev   | 96    | 582      | ✅         |
| 0.205.0 | Vostok · Bykovsky    | 114   | 601      | ✅         |
| 0.206.0 | Vostok · Tereshkova  | 122   | 635      | ✅         |
| 0.207.0 | Vostok · Gagarin     | 122   | 635      | ✅         |
| 0.207.1 | Vostok · Gagarin     | 122   | 635      | ✅         |
| 0.208.0 | Vostok · Titov       | 134   | 711      | ✅         |
| 0.209.0 | Vostok · Popovich    | 167   | 756      | ✅         |
| 0.210.0 | Vostok · Komarov     | 195   | 957      | ✅         |
| 0.211.2 | Vostok · Volynov     | 198   | 1020     | ✅         |
| 0.212.0 | Vostok · Shatalov    | 200   | 968      | ✅         |
| 0.212.1 | Vostok · Shatalov II | 200   | 968      | ✅ Current |

## v0.201.0 ✅ — Engine v2 + Desktop/Bridge

- Engine: POST body templates, exec stdin/env/file_output, html_to_md, retry with backoff
- Web: tieba, 36kr, substack, producthunt, google, imdb, web/read, ctrip, paperreview, spotify
- Desktop: ffmpeg (11), imagemagick (6), pandoc, libreoffice (2), mermaid, inkscape (3), blender (4), musescore (2), drawio, comfyui (4)
- Bridge: gh (5), docker (5), yt-dlp (4), jq (2)
- Infrastructure: single source of truth for version, release script, 592 tests, CI green

## v0.202.0 — Cookie Infrastructure + Chinese Platforms

Engine:

- Cookie injection system (`~/.unicli/cookies/<site>.json`)
- `unicli auth` command for cookie management
- `write_temp` step for scripting desktop apps

Adapters (+26 sites, +160 commands):

- Chinese platforms: bilibili, weibo, zhihu, xiaohongshu, douyin, douban, xueqiu, linux-do, jike, zsxq
- International: twitter (read), youtube, medium, linkedin, reuters, yahoo-finance, sinablog, barchart, smzdm, sinafinance
- Expand existing: v2ex, weread, tieba, reddit (cookie commands)
- Desktop: gimp, freecad (via write_temp)

## v0.203.0 — OAuth + Write Operations

Engine:

- OAuth2 flow step
- WebSocket step

Adapters (+14 sites, +115 commands):

- OAuth: spotify (playback), zoom, obs-studio
- Write operations: twitter, instagram, tiktok, facebook, xiaohongshu, douyin, weibo, jike
- Service: zotero, notebooklm, slack
- Bridge: vercel, obsidian, lark-cli

## v0.204.0 — UI Automation + Engineering Tools

Engine:

- UI automation step (accessibility APIs)

Adapters (+22 sites, +93 commands):

- UI: cursor, chatgpt, codex, notion, discord, chatwise, doubao-app, antigravity
- Desktop: krita, kdenlive, shotcut, cloudcompare, videocaptioner, adguardhome, novita, wiremock
- Engineering: kicad (EDA), openscad (CAD), openfoam (CFD), outlook (Graph API)
- Expand: google, imdb, spotify

## v0.205.0 — Full Parity + Ecosystem

Adapters (+21 sites, +191 commands):

- Remaining: amazon, boss, doubao, gemini, grok, pixiv, band, chaoxing, coupang, jd, jimeng, weixin, producthunt (intercept), bloomberg (news), iterm2, sketch, anygen, rms, intelwatch, mubu, slay_the_spire_ii

Ecosystem:

- npm publish
- VitePress documentation site
- MCP server
- Plugin system
- GitHub Actions integration

## Architecture

```
src/
├── constants.ts          # Single source of truth (version, UA)
├── cli.ts                # Commander routing
├── types.ts              # Core types
├── registry.ts           # Adapter registry
├── engine/
│   └── yaml-runner.ts    # Pipeline engine (fetch, exec, map, etc.)
├── output/formatter.ts   # Multi-format output
├── discovery/loader.ts   # YAML + TS adapter scanner
├── adapters/             # 126+ site directories
├── browser/              # Chrome Extension bridge (v0.202+)
└── mcp/                  # MCP server (v0.205)
```

## v0.213 — Deferred from v0.212 audit (2026-04-15)

The v0.212 Shatalov release ships with several features documented as stubs
so the capability surface is visible to agents without pretending the
bodies work. The v0.213 scope reclaims that honesty:

**CUA real backends**

- `AnthropicPlanner(screenshotSource)` composition — the Anthropic Messages
  API is a planner, not a screen capture service. A real backend must
  compose with `desktop-ax.ax_snapshot` (macOS `screencapture`) or a
  scrapybara/trycua sandbox to supply the screenshot.
- `computer_20260301` tool identifier is env-configurable via
  `ANTHROPIC_CUA_TOOL_VERSION` — track Anthropic's release cadence without
  a code change.
- trycua / OpenCUA / scrapybara backend bodies.

**Desktop transports**

- `desktop-uia.ts` — Windows UI Automation via napi-rs + `windows::UI::UIAutomation`
  crate (no ready-made Node binding exists as of 2026-04 — see the research
  reports in `.claude/plans/sessions/2026-04-14-v212-rethink/`).
- `desktop-atspi.ts` — Linux AT-SPI2 via D-Bus; `at-spi2-core` through a
  napi-rs shim. Node-native bindings are also absent.
- macOS AX tree snapshot via `node-mac-permissions@2.5.0` + napi-rs wrapper
  for `AXUIElement`.

**MCP Streamable HTTP**

- Full `Last-Event-ID` replay buffer (spec 2025-11-25 §5.3). v0.212 accepts
  the header and emits `id:` on every SSE event; v0.213 maintains a
  per-session ring buffer so a reconnecting client gets the events it
  missed.
- GET /mcp with `Accept: text/event-stream` as a server-push channel (today
  the server only streams responses to POST; spec allows bidirectional).

**Workflow adapters** (deferred from Phase 5)

- `gmail`, `gcal`, `drive` OAuth PKCE adapters.
- `spotify` user-scope adapter.
- `unicli inbox` unified cross-source feed.
- `unicli shop track` scheduled-daemon lifecycle.

**Release infrastructure**

- Migrate the canonical publish path to npmjs.com Trusted Publishers;
  retire the `NPM_TOKEN` fallback in `.github/workflows/release.yml`. The
  binding tuple is `(olo-dot-io, Uni-CLI, release.yml, npm-publish)` — one-
  time setup at https://www.npmjs.com/package/@zenalexa/unicli > Settings
  > Trusted Publishers.

## Self-Repair Architecture

```
unicli <site> <command>
  → Fails → structured error JSON (adapter_path, step, action, suggestion)
  → Agent reads 20-line YAML adapter
  → Agent edits YAML → re-runs → fixed
  → Fix persists in ~/.unicli/adapters/ (survives npm update)
```
