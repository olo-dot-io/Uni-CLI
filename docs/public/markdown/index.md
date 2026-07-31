<!-- Generated from docs/index.md. Do not edit this copy directly. -->

# Overview

- Canonical: https://olo-dot-io.github.io/Uni-CLI/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/index.md
- Section: Start

## The open Agent-Computer Interface runtime for real software

Uni-CLI provides one searchable boundary between agents and websites, logged-in browsers, desktop apps, local tools, files, MCP servers, accessibility, visual control, and system capabilities. It ranks cataloged operations by intent, runs the selected operation through its declared substrate under supported policy, returns a stable success/error envelope, and keeps supported failure paths repairable.

## Runtime Contract

- Intent discovery
- Declared substrates
- Policy-aware execution
- Structured envelopes
- MCP + ACP
- Browser + Desktop
- Repairable paths

## First Command

```bash
npm install -g @zenalexa/unicli
unicli do "find the Hacker News frontpage"
unicli extract https://example.com --max-chars 1200
unicli compute snapshot --app Calculator --format compact
unicli mcp serve --transport streamable --port 19826
```

## Positioning

Uni-CLI is an Agent-Computer Interface runtime, not an agent model, planner, browser agent, or MCP platform. CLI is the native full process entry point; MCP projects adapter operations; APIs, files, CLIs, browsers, desktops, protocols, and visual control are declared substrates. The compact loop is discover, select, govern, act, observe, and repair.

- **Discover.** Bilingual BM25 search retrieves only the operations, arguments, auth posture, and risk fields relevant to the task.
- **Select and govern.** The agent selects an operation with a declared strategy/substrate; currently covered capability scope, effect, risk, and approval remain inspectable before execution.
- **Act and observe.** The adapter kernel invokes the selected operation; AgentEnvelope distinguishes success from error, and supporting operations can add artifacts, recordings, or post-state evidence.
- **Repair.** Structured errors always include code/message and add source path, failed boundary, retryability, suggestion, or alternatives when applicable.

## Common Tasks

- `unicli search` and `unicli do` read the local operation catalog first, then execution can inspect operation, args, auth, risk, and output fields.
- When a page, API, app, or local boundary changes, an owned failure can name the source path and failing step or boundary in its error envelope.
- Native CLI is the complete command surface; MCP default/deferred/expanded profiles project adapter operations, while fixed-core and other integration parity remain roadmap work.

## Coverage

- Static adapter sites: 326
- Registered adapter operations: 1829
- Built-in actions: 113 (58 registered + 55 transport-native)
- Tests: 9984

Site and operation totals describe the static adapter catalog; fixed core and host-discovered commands join at runtime. Operations, adapters, built-in actions, tests, and substrates are counted by the build.

## Entrypoints

- [First Run](/guide/getting-started): install, search, execute, authenticate, choose output formats, and read exit codes.
- [Operation Catalog](/reference/sites): browse by site, substrate, auth strategy, and examples.
- [Adapters](/guide/adapters): YAML adapters, pipeline steps, self-repair, and verification.
- [Integrations](/guide/integrations): native CLI, MCP, ACP, and output modes for agent runtimes.

## Current Version

Local release: v1.0.1 · Artemis · Glover.

## Agent Index

- [/llms.txt](/llms.txt)
- [/llms-full.txt](/llms-full.txt)
