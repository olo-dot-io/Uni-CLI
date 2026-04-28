<!-- Generated from docs/index.md. Do not edit this copy directly. -->

# Overview

- Canonical: https://olo-dot-io.github.io/Uni-CLI/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/index.md
- Section: Start

## Command-grade software access for agents

Uni-CLI puts sites, apps, local tools, MCP, and external CLIs into one searchable catalog. Agents use one command path to search, run, record, repair, and hand results to any client.

## First Command

```bash
npm install -g @zenalexa/unicli
unicli search "connect slack messages"
unicli agents recommend codex
unicli mcp serve --transport streamable --port 19826
```

## Positioning

Agent execution needs an auditable, repairable, reusable command contract. Catalog search handles discovery. The v2 AgentEnvelope stabilizes output. Operation policy exposes permissions and risk. Run evidence supports review. The repair loop points failures to adapters and pipeline steps.

- **Discover.** Bilingual BM25 search turns a natural-language task into a site, command, arguments, and auth strategy.
- **Execute.** HTTP, cookies, browser CDP, desktop AX, subprocess, service, and CUA all return the same envelope.
- **Recover.** Structured errors include adapter path, step, retryable, suggestion, and alternatives.

## Common Tasks

- `unicli search` reads the local catalog first, then execution can inspect command, args, auth, risk, and output fields.
- When a page or API changes, the error envelope names the adapter file and failing pipeline step.
- Web APIs, browser automation, macOS, desktop apps, external CLIs, MCP, ACP, HTTP API, and agent backend routes share the catalog.

## Coverage

- Sites and tools: 235
- Commands: 1448
- Pipeline steps: 59
- Tests: 7525

These numbers come from the current generated repo artifacts: adapters, commands, pipeline steps, tests, and transports are counted by the build.

## Entrypoints

- [First Run](/guide/getting-started): install, search, execute, authenticate, choose output formats, and read exit codes.
- [Command Catalog](/reference/sites): browse by site, surface, auth strategy, and examples.
- [Adapters](/guide/adapters): YAML adapters, pipeline steps, self-repair, and verification.
- [Integrations](/guide/integrations): native CLI, MCP, ACP, and output modes for agent runtimes.

## Current Version

Latest: v0.217.0 · Apollo · Lovell.

## Agent Index

- [/llms.txt](/llms.txt)
- [/llms-full.txt](/llms-full.txt)
