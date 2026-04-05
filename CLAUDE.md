# Uni-CLI — Project Guidelines

> **CLI (Bash) is all agents need.**

## Philosophy

Uni-CLI is the entry point for AI agents to touch, sense, understand, modify, and control any internet application (via Chrome) and local software (via subprocess). We are not a scraper — we are agent infrastructure. CLI is a stable execution layer, a persistent cache for agent behaviors.

**Agent-Always-First.** Every design decision optimizes for machine consumption:

- Piped output (non-TTY) auto-switches to JSON — zero flags needed
- Errors emit structured JSON to stderr (`adapter_path`, `step`, `action`, `suggestion`)
- Exit codes are machine-parseable (sysexits.h: 0=ok, 1=error, 2=usage, 66=empty, 69=unavailable, 75=temp, 77=auth, 78=config)
- YAML adapters are agent-readable and agent-editable (~20 lines, no imports)
- ~80 tokens per CLI call — cheaper than any MCP roundtrip

## Self-Repair Architecture

The core differentiator. When a command fails, agents can fix it:

```
unicli <site> <cmd> fails
  → structured error JSON (adapter_path, step, action, suggestion)
  → agent reads the YAML adapter at that path
  → agent edits the YAML (selector changed, API versioned, auth rotated)
  → agent retries → fixed
```

Fixes persist in `~/.unicli/adapters/` (survives `npm update`). Verification: `unicli repair <site> <command>` and `unicli test [site]`.

## Multi-Surface Delivery

| Surface        | Purpose                                           |
| -------------- | ------------------------------------------------- |
| CLI (primary)  | `unicli <site> <command>` — direct execution      |
| Skills         | Teach agents how to use Uni-CLI effectively       |
| AGENTS.md      | Discovery — agents find capabilities without docs |
| MCP (optional) | For environments that only speak MCP              |

## Architecture

```
src/
├── main.ts              # Entry point
├── cli.ts               # Commander routing + dynamic command registration
├── types.ts             # Core types: AdapterType, Strategy, IPage, ExitCode
├── registry.ts          # Adapter registry + cli() helper
├── engine/
│   ├── yaml-runner.ts   # Pipeline engine (23 steps: fetch, navigate, press, tap, download...)
│   ├── cookies.ts       # Cookie file reader for authenticated adapters
│   ├── cascade.ts       # Strategy cascade: auto-probe PUBLIC→COOKIE→HEADER
│   ├── interceptor.ts   # Dual fetch+XHR interceptor with anti-detection stealth
│   ├── download.ts      # Download step: HTTP + yt-dlp + document save
│   └── websocket.ts     # WebSocket step with OBS auth support
├── output/formatter.ts  # Multi-format output (table/json/yaml/csv/md)
├── discovery/loader.ts  # YAML + TS adapter scanner
├── adapters/            # Built-in adapters (YAML + TS)
├── browser/
│   ├── cdp-client.ts    # Raw WebSocket CDP client (zero new deps, uses ws)
│   ├── page.ts          # BrowserPage: 22 methods (goto, evaluate, snapshot, screenshot...)
│   ├── snapshot.ts      # DOM accessibility tree generator (interactive refs, scroll markers)
│   ├── launcher.ts      # Chrome discovery + spawn with --remote-debugging-port
│   ├── stealth.ts       # 13 anti-detection patches (webdriver, plugins, CDP cleanup...)
│   ├── daemon.ts        # Standalone daemon HTTP+WS server (port 19825)
│   ├── daemon-client.ts # CLI→daemon HTTP client with retry
│   ├── bridge.ts        # BrowserBridge auto-spawn + DaemonPage (IPage over daemon)
│   ├── discover.ts      # Daemon status discovery
│   ├── protocol.ts      # Shared daemon/extension types + constants
│   └── idle-manager.ts  # Idle timeout auto-exit for daemon
├── commands/
│   ├── auth.ts          # unicli auth setup/check/list
│   ├── browser.ts       # unicli browser start/status
│   ├── daemon.ts        # unicli daemon status/stop/restart
│   ├── operate.ts       # unicli operate (16 browser subcommands)
│   ├── record.ts        # unicli record <url> (adapter generation)
│   └── completion.ts    # unicli completion bash/zsh/fish
├── hub/                 # External CLI hub (passthrough)
├── plugin/              # Plugin system
└── mcp/                 # MCP stdio server
```

## Technology Stack

| Layer    | Technology                   |
| -------- | ---------------------------- |
| Language | TypeScript (strict)          |
| Runtime  | Node.js >= 20                |
| CLI      | Commander                    |
| Test     | Vitest                       |
| Lint     | Oxlint                       |
| Format   | Prettier                     |
| Docs     | VitePress                    |
| Browser  | Raw CDP via `ws` (WebSocket) |

## Commands

| Purpose         | Command                           |
| --------------- | --------------------------------- |
| Dev run         | `npm run dev`                     |
| Build           | `npm run build`                   |
| Type check      | `npm run typecheck`               |
| Lint            | `npm run lint`                    |
| Test (unit)     | `npm run test`                    |
| Test (adapters) | `npm run test:adapter`            |
| Test (all)      | `npm run test:all`                |
| Full verify     | `npm run verify`                  |
| Format check    | `npm run format:check`            |
| Diagnostics     | `npm run doctor`                  |
| Repair adapter  | `unicli repair <site> <command>`  |
| Test adapters   | `unicli test [site]`              |
| Browser start   | `unicli browser start`            |
| Browser status  | `unicli browser status`           |
| Browser cookies | `unicli browser cookies <domain>` |
| Auth setup      | `unicli auth setup <site>`        |
| Daemon status   | `unicli daemon status`            |
| Daemon stop     | `unicli daemon stop`              |
| Operate browser | `unicli operate <subcommand>`     |
| Record adapter  | `unicli record <url>`             |
| Adapter install | `unicli adapter install <s>/<c>`  |
| Adapter list    | `unicli adapter list`             |
| Init adapter    | `unicli init <site> <command>`    |
| Dev hot-reload  | `unicli dev <path>`               |
| Completion      | `unicli completion <shell>`       |
| Docs dev        | `npm run docs:dev`                |
| Docs build      | `npm run docs:build`              |
| Sync refs       | `npm run sync:ref`                |

## Pipeline Steps (30)

| Step         | Type      | What it does                                           |
| ------------ | --------- | ------------------------------------------------------ |
| `fetch`      | API       | HTTP JSON (GET/POST, retry, backoff, cookie injection) |
| `fetch_text` | API       | HTTP raw text (RSS, HTML)                              |
| `parse_rss`  | API       | Extract RSS/Atom feed items                            |
| `html_to_md` | API       | Convert HTML to Markdown                               |
| `select`     | Transform | Navigate into JSON path (`data.items`)                 |
| `map`        | Transform | Transform each item via template                       |
| `filter`     | Transform | Keep matching items                                    |
| `sort`       | Transform | Sort by field                                          |
| `limit`      | Transform | Cap result count                                       |
| `exec`       | Desktop   | Run subprocess (stdin, env, file output)               |
| `write_temp` | Desktop   | Create temp script file for desktop adapters           |
| `navigate`   | Browser   | Navigate Chrome to URL via CDP                         |
| `evaluate`   | Browser   | Execute JS in page context                             |
| `click`      | Browser   | Click element by CSS selector                          |
| `type`       | Browser   | Type text into input                                   |
| `wait`       | Browser   | Wait for time (ms) or selector to appear               |
| `intercept`  | Browser   | Capture page network requests (fetch + XHR, stealthy)  |
| `press`      | Browser   | Press keyboard key with optional modifiers             |
| `scroll`     | Browser   | Scroll page (direction, to element, or auto-scroll)    |
| `snapshot`   | Browser   | DOM accessibility tree snapshot with interactive refs  |
| `tap`        | Browser   | Vue Store Action Bridge (Pinia/Vuex → capture network) |
| `download`   | Media     | Download files (HTTP + yt-dlp, batch, skip_existing)   |
| `websocket`  | Service   | WebSocket connect/send/receive (OBS auth support)      |
| `set`        | Control   | Store variables into `vars` context for templates      |
| `if`         | Control   | Conditional execution of sub-pipeline branches         |
| `append`     | Control   | Push ctx.data into vars array for accumulation         |
| `each`       | Control   | Loop sub-pipeline with do-while + max iteration limit  |
| `parallel`   | Control   | Run sub-pipelines concurrently with merge strategies   |
| `rate_limit` | Control   | Per-domain token bucket request throttling             |

## Strategies

| Strategy    | Auth          | How                                                   |
| ----------- | ------------- | ----------------------------------------------------- |
| `public`    | None          | Direct fetch, no credentials                          |
| `cookie`    | Cookie file   | `~/.unicli/cookies/<site>.json` injected into headers |
| `header`    | Cookie + CSRF | Cookie + auto-extracted CSRF token                    |
| `intercept` | Browser       | Navigate page, capture XHR/fetch responses            |
| `ui`        | Browser       | Interact with page UI (click, type)                   |

Strategy cascade: `unicli` auto-probes PUBLIC → COOKIE → HEADER on first run.

## Adapter Format

Five adapter types: `web-api`, `desktop`, `browser`, `bridge`, `service`.

### YAML (preferred — agent-editable, ~20 lines)

```yaml
site: example
name: command-name
type: web-api # web-api | desktop | browser | bridge | service
strategy: public # public | cookie | header | intercept | ui
pipeline:
  - fetch: { url: "..." }
  - map: { title: "${{ item.title }}" }
columns: [title, score]
```

### TypeScript (for complex logic)

```typescript
import { cli, Strategy } from "../../registry.js";

cli({
  site: "example",
  name: "command",
  strategy: Strategy.COOKIE,
  args: [{ name: "query", required: true, positional: true }],
  func: async (page, kwargs) => {
    /* ... */
  },
});
```

## Code Standards

- Version: 0.205.0
- Apache-2.0 license
- Strict TypeScript — no `any` unless unavoidable
- YAML adapters are the preferred contribution format
- All commands support `--json` output

**Every task is complete only after `npm run verify` passes.**

## Version Release Checklist

When bumping version, ALL of these must update atomically:

| File              | What                                          |
| ----------------- | --------------------------------------------- |
| `package.json`    | `version`                                     |
| `CHANGELOG.md`    | New heading + content                         |
| `CLAUDE.md`       | Version in Code Standards                     |
| `AGENTS.md`       | Header count, site listings, version footer   |
| `README.md`       | Agent comment (line 1), feature table, footer |
| `docs/ROADMAP.md` | Progress table (mark ✅, update counts)       |
| `docs/TASTE.md`   | Current version line                          |

Codename series: 0.1xx=Sputnik, **0.2xx=Vostok**, 0.3xx=Mercury, 0.4xx=Gemini.

After commit: `git tag -a v{X} -m "..."` → `gh release create` → `git push --tags`.
