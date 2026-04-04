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
├── engine/              # Execution engines per adapter type
├── output/formatter.ts  # Multi-format output (table/json/yaml/csv/md)
├── discovery/loader.ts  # YAML + TS adapter scanner
├── adapters/            # Built-in adapters (YAML + TS)
├── browser/             # Chrome Extension bridge
├── hub/                 # External CLI hub (passthrough)
├── plugin/              # Plugin system
└── mcp/                 # MCP stdio server
```

## Technology Stack

| Layer    | Technology           |
| -------- | -------------------- |
| Language | TypeScript (strict)  |
| Runtime  | Node.js >= 20        |
| CLI      | Commander            |
| Test     | Vitest               |
| Lint     | Oxlint               |
| Format   | Prettier             |
| Docs     | VitePress            |
| Browser  | Chrome Extension CDP |

## Commands

| Purpose         | Command                          |
| --------------- | -------------------------------- |
| Dev run         | `npm run dev`                    |
| Build           | `npm run build`                  |
| Type check      | `npm run typecheck`              |
| Lint            | `npm run lint`                   |
| Test (unit)     | `npm run test`                   |
| Test (adapters) | `npm run test:adapter`           |
| Test (all)      | `npm run test:all`               |
| Full verify     | `npm run verify`                 |
| Format check    | `npm run format:check`           |
| Diagnostics     | `npm run doctor`                 |
| Repair adapter  | `unicli repair <site> <command>` |
| Test adapters   | `unicli test [site]`             |

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

- Version: 0.200.0
- Apache-2.0 license
- Strict TypeScript — no `any` unless unavoidable
- YAML adapters are the preferred contribution format
- All commands support `--json` output

**Every task is complete only after `npm run verify` passes.**
