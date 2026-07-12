<!-- Generated from docs/index.md. Do not edit this copy directly. -->

# Overview

- Canonical: https://olo-dot-io.github.io/Uni-CLI/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/index.md
- Section: Start

## Universal computer-control platform for agents

Uni-CLI turns websites, logged-in browsers, desktop apps, local tools, files, MCP servers, accessibility trees, screenshots, and system capabilities into searchable, governed, observable, repairable operations. Agents use one path to select an action substrate by intent, inspect risk, execute with policy, return evidence, and repair or reroute the failed source path.

## Control Surface

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

Agent execution does not need a longer resident tool list or another website wrapper. It needs a universal hand for controlling the whole computer. Operation search handles discovery. Operation policy exposes permissions and risk. The control kernel chooses the substrate. The v2 AgentEnvelope stabilizes output. Run evidence supports review. The delivery/repair loop points failures to source paths, alternatives, and verification commands.

- **Intent.** Bilingual BM25 search turns a natural-language task into a site, operation, arguments, auth posture, and risk fields.
- **Substrate.** HTTP, cookies, browser CDP, macOS AX, subprocess, service, protocol, and visual fallback share one control kernel.
- **Evidence.** Markdown is the agent-friendly default; JSON, YAML, CSV, and compact formats serve programs.
- **Repair or reroute.** Structured errors include source path, step or boundary, retryability, suggestion, and alternatives.

## Common Tasks

- `unicli search` and `unicli do` read the local operation catalog first, then execution can inspect operation, args, auth, risk, and output fields.
- When a page, API, app, or local boundary changes, the error envelope names the source path and failing step or boundary.
- Web APIs, browser automation, macOS, desktop apps, external CLIs, files, MCP, ACP, HTTP API, and agent backend routes share the same operation contract and receipt.

## Coverage

- Sites and tools: 320
- Operations: 1798
- Pipeline steps: 103
- Tests: 9247

These numbers come from the current generated repo artifacts: operations, adapters, pipeline steps, tests, and substrates are counted by the build.

## Entrypoints

- [First Run](/guide/getting-started): install, search, execute, authenticate, choose output formats, and read exit codes.
- [Operation Catalog](/reference/sites): browse by site, substrate, auth strategy, and examples.
- [Adapters](/guide/adapters): YAML adapters, pipeline steps, self-repair, and verification.
- [Integrations](/guide/integrations): native CLI, MCP, ACP, and output modes for agent runtimes.

## Current Version

Latest: v0.226.0 · Apollo · Stafford.

## Agent Index

- [/llms.txt](/llms.txt)
- [/llms-full.txt](/llms-full.txt)
