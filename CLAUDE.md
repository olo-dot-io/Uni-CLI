# Uni-CLI — Project Guidelines

## What is this

Uni-CLI ("CLI IS ALL YOU NEED") is a universal CLI framework that turns any website, desktop app, cloud service, or system tool into a CLI command. It supports five adapter types — `web-api`, `desktop`, `browser`, `bridge`, `service` — through a unified YAML format or TypeScript adapters.

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

| Layer     | Technology           |
|-----------|----------------------|
| Language  | TypeScript (strict)  |
| Runtime   | Node.js >= 20       |
| CLI       | Commander            |
| Test      | Vitest               |
| Lint      | Oxlint               |
| Format    | Prettier             |
| Docs      | VitePress            |
| Browser   | Chrome Extension CDP |

## Commands

| Purpose        | Command                |
|----------------|------------------------|
| Dev run        | `npm run dev`          |
| Build          | `npm run build`        |
| Type check     | `npm run typecheck`    |
| Lint           | `npm run lint`         |
| Test           | `npm run test`         |
| Full verify    | `npm run verify`       |

**Every task is complete only after `npm run verify` passes.**

## Adapter Format

Two patterns:

### YAML (preferred for simple adapters)

```yaml
site: example
name: command-name
type: web-api          # web-api | desktop | browser | bridge | service
strategy: public       # public | cookie | header | intercept | ui
pipeline:
  - fetch: { url: "..." }
  - map: { title: "${{ item.title }}" }
columns: [title, score]
```

### TypeScript (for complex logic)

```typescript
import { cli, Strategy } from '../../registry.js';

cli({
  site: 'example', name: 'command',
  strategy: Strategy.COOKIE,
  args: [{ name: 'query', required: true, positional: true }],
  func: async (page, kwargs) => { /* ... */ },
});
```

## Code Standards

- Apache-2.0 license
- Strict TypeScript — no `any` unless unavoidable
- Exit codes follow sysexits.h conventions
- All commands support `--json` output
- Piped output auto-switches to JSON
- YAML adapters are the preferred contribution format
