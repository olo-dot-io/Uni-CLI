<!-- AGENT: npm install -g unicli && unicli list | 582 commands across 96 sites. JSON when piped. Self-repairing YAML adapters. See AGENTS.md -->

<h1 align="center">Uni-CLI</h1>

<p align="center">
  <strong>The universal interface between AI agents and the world's software.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/unicli"><img src="https://img.shields.io/npm/v/unicli?style=flat-square" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/unicli?style=flat-square" alt="Node.js"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="AGPL-3.0"></a>
</p>

<p align="center">
  96 sites · 582 commands · 23 pipeline steps · 29 template filters · Zero runtime dependencies beyond Node.js
</p>

---

Agents cannot draw in SolidWorks. Cannot design PCBs. Cannot run CFD simulations. Cannot send Outlook emails. Cannot access most websites.

Uni-CLI fixes this. One command, structured JSON output, self-repairing YAML adapters. **~80 tokens per invocation** — two orders of magnitude cheaper than MCP.

```bash
npm install -g unicli
unicli hackernews top --limit 5          # Public API
unicli bilibili hot                      # Chinese platform
unicli twitter search "AI agents"        # Authenticated
unicli blender render scene.blend        # Desktop software
unicli cursor ask "explain this code"    # Electron app
```

## Why CLI

| Criterion           | MCP                                     | CLI (Uni-CLI)                            |
| ------------------- | --------------------------------------- | ---------------------------------------- |
| Cost per invocation | 550–1,400 tokens (tool definition)      | ~80 tokens                               |
| Context overhead    | 3 servers = 72% of 200K window consumed | Zero                                     |
| Composability       | Single-tool calls                       | Unix pipes, `jq`, shell scripts          |
| Self-repair         | Agents cannot read server source        | Agent reads 20-line YAML, edits, retries |
| Universality        | Requires MCP client support             | Every agent has Bash                     |
| Auth reuse          | Per-server configuration                | Chrome login sessions via daemon         |

CLI is: universal, composable, self-repairable, and context-efficient. MCP is a protocol for tool registration. **They solve different problems.** Uni-CLI supports both — use `unicli mcp` for MCP-only environments.

## Architecture

```
                         unicli <site> <command> [args]
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              YAML Adapter    TS Adapter      Bridge (passthrough)
              (20 lines)      (complex logic)   (gh, docker, vercel)
                    │               │               │
                    ▼               ▼               ▼
              ┌─────────────────────────────────────────┐
              │          Pipeline Engine (23 steps)      │
              │  fetch · navigate · evaluate · click     │
              │  type · press · scroll · wait · tap      │
              │  intercept · snapshot · download          │
              │  websocket · exec · write_temp · ...      │
              └─────────┬───────────────┬───────────────┘
                        │               │
              ┌─────────▼─────┐ ┌───────▼───────┐
              │  Direct CDP   │ │    Daemon      │
              │  (fast, local)│ │  (persistent,  │
              │               │ │  reuses Chrome │
              │               │ │  login state)  │
              └───────────────┘ └───────────────┘
                        │               │
              ┌─────────▼───────────────▼───────┐
              │       Output Formatter           │
              │  table · json · yaml · csv · md  │
              │  (auto-JSON when piped)          │
              └─────────────────────────────────┘
```

## Self-Repair

This is the core differentiator. When a command fails:

```
unicli <site> <cmd> fails
  → structured error JSON: { adapter_path, step, action, suggestion }
  → agent reads the 20-line YAML at that path
  → agent edits the YAML (selector changed, API versioned, auth rotated)
  → agent retries → fixed
  → fix persists in ~/.unicli/adapters/ (survives npm update)
```

Verification: `unicli repair <site> <command>` diagnoses, `unicli test [site]` validates.

## Coverage

### Web Platforms (67 sites)

| Category                   | Sites                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Tech / Dev**             | hackernews, stackoverflow, devto, lobsters, producthunt, hf, github-trending, substack, lesswrong                         |
| **Social — International** | twitter (25 cmds), reddit (16), instagram (19), tiktok (15), facebook (10), bluesky, medium                               |
| **Social — Chinese**       | bilibili (13), weibo, zhihu, xiaohongshu (13), douyin (13), jike, douban, weread, tieba, v2ex, linux-do, zsxq, xiaoyuzhou |
| **Video / Media**          | youtube (5), bilibili, douyin, tiktok                                                                                     |
| **Finance**                | xueqiu, sinafinance, barchart, yahoo-finance                                                                              |
| **News**                   | bbc, bloomberg (10), reuters, 36kr, google news                                                                           |
| **Shopping**               | amazon (8), xianyu, coupang, smzdm, jd                                                                                    |
| **Jobs**                   | boss (14), linkedin                                                                                                       |
| **AI Platforms**           | gemini (5), grok, doubao-web (9), notebooklm (15), yollomi (12), jimeng, yuanbao                                          |
| **Education**              | chaoxing, arxiv, wikipedia                                                                                                |
| **Other**                  | ones (11), band, xiaoe, pixiv (6), hupu (7), ctrip, sinablog, steam, lobsters                                             |

### Desktop Software (28 apps)

| Category         | Apps                                                        |
| ---------------- | ----------------------------------------------------------- |
| **3D / CAD**     | blender (13 cmds), freecad (15), cloudcompare (4), openscad |
| **Image**        | gimp (12), inkscape, imagemagick (6), krita (4)             |
| **Video**        | ffmpeg (11), kdenlive (3), shotcut (3), musescore (5)       |
| **Diagram**      | drawio, mermaid                                             |
| **Document**     | libreoffice, pandoc                                         |
| **Audio**        | audacity (8)                                                |
| **Streaming**    | obs (8, WebSocket)                                          |
| **Productivity** | zotero (8)                                                  |
| **Dev Services** | wiremock (5), adguardhome (5), novita (3)                   |
| **Game**         | slay-the-spire-ii (6, HTTP bridge mod)                      |
| **Design**       | sketch (3)                                                  |

### Electron Apps (8 apps, 66 commands)

| App             | Commands                                                                                       | Method    |
| --------------- | ---------------------------------------------------------------------------------------------- | --------- |
| **Cursor**      | ask, send, read, model, composer, extract-code, new, status, screenshot, dump, history, export | CDP :9226 |
| **Codex**       | ask, send, read, model, extract-diff, new, status, screenshot, dump, history, export           | CDP :9222 |
| **ChatGPT**     | ask, send, read, model, new, status, screenshot, dump                                          | CDP :9236 |
| **Notion**      | search, read, write, new, status, sidebar, favorites, export, screenshot                       | CDP :9230 |
| **Discord**     | servers, channels, read, send, search, members, status                                         | CDP :9232 |
| **ChatWise**    | ask, send, read, model, new, status, screenshot, dump                                          | CDP :9228 |
| **Doubao**      | ask, send, read, new, status, screenshot, dump                                                 | CDP :9225 |
| **Antigravity** | ask, send, read, model, new, status, screenshot, dump                                          | CDP :9234 |

### Bridge (passthrough to existing CLIs)

docker, gh, jq, yt-dlp — more planned for v0.205 (vercel, netlify, railway, flyctl, supabase, wrangler, lark, dingtalk)

## Pipeline Engine

23 steps execute in sequence. Each YAML adapter is a pipeline of these steps.

| Step         | Type      | What it does                                                                  |
| ------------ | --------- | ----------------------------------------------------------------------------- |
| `fetch`      | API       | HTTP JSON with retry, backoff, cookie injection, concurrent fan-out (limit=5) |
| `fetch_text` | API       | HTTP raw text (RSS, HTML, XML)                                                |
| `parse_rss`  | API       | RSS 2.0 + Atom feed parser                                                    |
| `html_to_md` | API       | HTML → Markdown via Turndown                                                  |
| `select`     | Transform | Navigate JSON by dot-path (`data.items[]`)                                    |
| `map`        | Transform | Transform each item via `${{ }}` templates                                    |
| `filter`     | Transform | Keep items matching expression                                                |
| `sort`       | Transform | Sort by field (numeric-aware)                                                 |
| `limit`      | Transform | Cap result count                                                              |
| `exec`       | Desktop   | Run subprocess with stdin, env, file output                                   |
| `write_temp` | Desktop   | Create ephemeral script file                                                  |
| `navigate`   | Browser   | Navigate Chrome to URL via CDP                                                |
| `evaluate`   | Browser   | Execute JS in page context                                                    |
| `click`      | Browser   | Click element by CSS selector                                                 |
| `type`       | Browser   | Type text into input                                                          |
| `press`      | Browser   | Keyboard key with modifiers (Ctrl+A, Enter)                                   |
| `wait`       | Browser   | Wait for time, selector, or text                                              |
| `scroll`     | Browser   | Direction scroll, auto-scroll to bottom                                       |
| `intercept`  | Browser   | Capture fetch + XHR responses (dual-patched, stealthed)                       |
| `snapshot`   | Browser   | DOM accessibility tree with interactive refs                                  |
| `tap`        | Browser   | Vue Store Action Bridge (Pinia/Vuex → capture network)                        |
| `download`   | Media     | HTTP + yt-dlp, batch concurrent, skip_existing                                |
| `websocket`  | Service   | WebSocket connect/send/receive (OBS auth support)                             |

### Template Expressions

29 pipe filters: `join`, `urlencode`, `urldecode`, `slice`, `replace`, `lowercase`, `uppercase`, `trim`, `default`, `split`, `first`, `last`, `length`, `strip_html`, `truncate`, `slugify`, `sanitize`, `ext`, `basename`, `keys`, `json`, `abs`, `round`, `ceil`, `floor`, `int`, `float`, `str`, `reverse`, `unique`

```yaml
${{ item.title | truncate(50) }}
${{ item.tags | join(', ') }}
${{ args.query | urlencode }}
${{ item.url | basename | sanitize }}
${{ item.score > 100 ? 'hot' : 'normal' }}
```

VM sandbox with null-prototype isolation, 50ms timeout, forbidden pattern blocklist.

## Authentication Strategies

| Strategy    | Auth          | How                                                      |
| ----------- | ------------- | -------------------------------------------------------- |
| `public`    | None          | Direct HTTP fetch                                        |
| `cookie`    | Cookie file   | `~/.unicli/cookies/<site>.json` injected into headers    |
| `header`    | Cookie + CSRF | Cookie + auto-extracted CSRF token (ct0, bili_jct, etc.) |
| `intercept` | Browser       | Navigate page, capture XHR/fetch responses               |
| `ui`        | Browser       | Direct DOM interaction (click, type, submit)             |

Strategy cascade: auto-probes PUBLIC → COOKIE → HEADER on first run.

## Browser Daemon

Persistent background process that bridges CLI commands to Chrome tabs. Reuses existing Chrome login sessions — no cookie files, no extension install required for basic operation.

```
unicli daemon status              # Check daemon state
unicli daemon stop                # Graceful shutdown (auto-exits after 4h idle)

unicli operate open <url>         # Navigate browser
unicli operate state              # DOM snapshot (accessibility tree)
unicli operate click <ref>        # Click by ref from snapshot
unicli operate type <ref> <text>  # Type into element
unicli operate eval <js>          # Execute JavaScript
unicli operate screenshot [path]  # Capture page
unicli operate network            # View captured requests

unicli record <url>               # Auto-generate adapter from page traffic
```

## Plugin System

```bash
unicli plugin install github:user/repo     # From GitHub
unicli plugin install /local/path          # From local directory
unicli plugin list                         # Show installed
unicli plugin update                       # Update all
```

Plugins can register custom pipeline steps via `registerStep()` and lifecycle hooks:

```typescript
import { onBeforeExecute, onAfterExecute } from "unicli/hooks";
onBeforeExecute(async (ctx) => {
  /* rate limiting, logging */
});
onAfterExecute(async (ctx, result) => {
  /* analytics, caching */
});
```

## Shell Completion

```bash
unicli completion bash >> ~/.bashrc
unicli completion zsh >> ~/.zshrc
unicli completion fish > ~/.config/fish/completions/unicli.fish
```

## Anti-Detection

13-layer stealth injection for browser automation:

1. `navigator.webdriver` removal
2. `window.chrome.runtime` mock
3. Plugin array normalization
4. Language header consistency
5. Permissions API notification fix
6. `Function.prototype.toString` spoofing
7. CDP global cleanup (`cdc_`, `__playwright`, `__puppeteer`)
8. `Error.stack` frame filtering
9. `outerWidth`/`outerHeight` normalization
10. Performance API entry filtering
11. Document-level CDP marker cleanup
12. iframe `contentWindow.chrome` consistency
13. Reserved (debugger trap neutralization)

## Exit Codes

Following `sysexits.h`:

| Code | Meaning     | When                          |
| ---- | ----------- | ----------------------------- |
| `0`  | Success     | Command completed             |
| `1`  | Error       | Unexpected failure            |
| `2`  | Usage       | Bad arguments                 |
| `66` | Empty       | No data returned              |
| `69` | Unavailable | Browser/service not connected |
| `75` | Temporary   | Timeout — retry               |
| `77` | Auth        | Not logged in                 |
| `78` | Config      | Missing credentials           |

## Development

```bash
git clone https://github.com/ZenAlexa/Uni-CLI.git && cd Uni-CLI
npm install
npm run dev -- list                   # Test adapter loading
npm run verify                        # format + typecheck + lint + test + build
npm run test:adapter                  # Validate all 582 YAML/TS adapters
```

| Command                | Purpose                   |
| ---------------------- | ------------------------- |
| `npm run dev`          | Development run           |
| `npm run build`        | Production build          |
| `npm run typecheck`    | TypeScript strict check   |
| `npm run lint`         | Oxlint                    |
| `npm run test`         | Unit tests (231)          |
| `npm run test:adapter` | Adapter validation (2041) |
| `npm run verify`       | Full pipeline             |

## Technology

| Layer    | Technology                                                 |
| -------- | ---------------------------------------------------------- |
| Language | TypeScript (strict)                                        |
| Runtime  | Node.js ≥ 20                                               |
| CLI      | Commander                                                  |
| Browser  | Raw CDP via `ws` (WebSocket) — no Puppeteer, no Playwright |
| Test     | Vitest                                                     |
| Lint     | Oxlint                                                     |
| Format   | Prettier                                                   |
| Template | VM sandbox (null-prototype, 50ms timeout)                  |

Zero production dependencies beyond: `chalk`, `cli-table3`, `commander`, `js-yaml`, `turndown`, `undici`, `ws`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The fastest way to contribute: write a 20-line YAML adapter for a site you use.

## License

[AGPL-3.0](./LICENSE) — Commercial license available. See [LICENSE-COMMERCIAL](./LICENSE-COMMERCIAL).

---

<p align="center">
  <sub>v0.204.0 — Vostok · Nikolayev</sub><br>
  <sub>96 sites · 582 commands · 23 pipeline steps · 29 filters · 2,272 tests</sub>
</p>
