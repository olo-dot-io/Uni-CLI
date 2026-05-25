<!-- Generated from docs/index.md. Do not edit this copy directly. -->

# Overview

- Canonical: https://olo-dot-io.github.io/Uni-CLI/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/index.md
- Section: Start

## Operations substrate for agents that use real software

Uni-CLI turns websites, logged-in browsers, desktop apps, local tools, MCP servers, and system capabilities into searchable, governed, repairable operations. Agents use one path to discover capabilities, inspect risk, execute with policy, return evidence, and repair the exact adapter or pipeline step that failed.

## Capability Wall

- Intent search
- Policy-gated execution
- AgentEnvelope v2
- MCP + ACP
- Desktop AX
- Visual fallback
- Adapter self-repair

## First Command

```bash
npm install -g @zenalexa/unicli
unicli do "find the Hacker News frontpage"
unicli extract https://example.com --max-chars 1200
unicli compute snapshot --app Calculator --format compact
unicli mcp serve --transport streamable --port 19826
```

## Positioning

Agent execution does not need a longer resident tool list or another website wrapper. It needs a small, auditable operations substrate over real software. Catalog search handles discovery. Operation policy exposes permissions and risk. The v2 AgentEnvelope stabilizes output. Run evidence supports review. The repair loop points failures to adapters and pipeline steps.

- **Discover.** Bilingual BM25 search turns a natural-language task into a site, command, arguments, auth strategy, and risk fields.
- **Execute.** HTTP, cookies, browser CDP, macOS AX, subprocess, service, and visual fallback return the same envelope.
- **Evidence.** Markdown is the agent-friendly default; JSON, YAML, CSV, and compact formats serve programs.
- **Repair.** Structured errors include adapter path, step, retryable, suggestion, and alternatives.

## Common Tasks

- `unicli search` and `unicli do` read the local catalog first, then execution can inspect command, args, auth, risk, and output fields.
- When a page or API changes, the error envelope names the adapter file and failing pipeline step.
- Web APIs, browser automation, macOS, desktop apps, external CLIs, MCP, ACP, HTTP API, and agent backend routes share the same catalog and receipt.

## Coverage

- Sites and tools: 311
- Commands: 1753
- Pipeline steps: 103
- Tests: 8915

These numbers come from the current generated repo artifacts: adapters, commands, pipeline steps, tests, and transports are counted by the build.

## Entrypoints

- [First Run](/guide/getting-started): install, search, execute, authenticate, choose output formats, and read exit codes.
- [Command Catalog](/reference/sites): browse by site, surface, auth strategy, and examples.
- [Adapters](/guide/adapters): YAML adapters, pipeline steps, self-repair, and verification.
- [Integrations](/guide/integrations): native CLI, MCP, ACP, and output modes for agent runtimes.

## Current Version

Latest: v0.223.1 · Apollo · Lovell.

## Agent Index

- [/llms.txt](/llms.txt)
- [/llms-full.txt](/llms-full.txt)
