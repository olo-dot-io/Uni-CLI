# Uni-CLI Roadmap — Mission Vostok (0.2xx)

> CLI is all agents need. 126+ sites, 700+ commands by v0.205.0.

## Progress

| Version | Codename            | Sites | Commands | Status     |
| ------- | ------------------- | ----- | -------- | ---------- |
| 0.100.0 | Sputnik             | 6     | 8        | ✅         |
| 0.200.0 | Vostok · Chaika     | 21    | 74       | ✅         |
| 0.201.0 | Vostok · Chaika II  | 43    | 141      | ✅         |
| 0.202.0 | Vostok · Tereshkova | 57    | 203      | ✅         |
| 0.203.0 | Vostok · Leonov     | 57    | 289      | ✅         |
| 0.204.0 | Vostok · Nikolayev  | 96    | 582      | ✅         |
| 0.205.0 | Vostok · Bykovsky   | 114   | 601      | ✅ Current |

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

## Self-Repair Architecture

```
unicli <site> <command>
  → Fails → structured error JSON (adapter_path, step, action, suggestion)
  → Agent reads 20-line YAML adapter
  → Agent edits YAML → re-runs → fixed
  → Fix persists in ~/.unicli/adapters/ (survives npm update)
```
