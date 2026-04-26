<!-- Generated from docs/index.md. Do not edit this copy directly. -->

# Overview

- Canonical: https://olo-dot-io.github.io/Uni-CLI/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/index.md
- Section: Start

## The universal interface between AI agents and the world's software.

A shell-native command layer for real operations: discover by intent, execute typed adapters, return structured AgentEnvelopes, and repair broken automation in place.

## Primary Actions

- [Get Started](/guide/getting-started)
- [Browse Sites](/reference/sites)

## Capabilities

- **Search By Intent.** Bilingual BM25 maps natural language to runnable commands across 223 sites and 1304 commands.
- **Operate Real Surfaces.** The same CLI spans web APIs, browser automation, macOS apps, desktop tools, and external CLIs.
- **Return Agent Envelopes.** Markdown, JSON, YAML, CSV, and compact output share the same v2 success/error contract.
- **Repair In Place.** Failures include adapter path, pipeline step, retryability, suggestions, and alternatives.
- **Plug Into Agents.** CLI-first execution stays native to coding agents; MCP, ACP, and JSON streams are compatibility surfaces.
- **Stay Small.** YAML adapters compose typed pipeline steps and avoid heavy per-site SDK dependencies.

## Catalog Snapshot

- Sites: 223
- Commands: 1304
- Surface families: 5
- Agent envelope: v2

| Surface | Sites |
| --- | ---: |
| bridge | 24 |
| browser | 10 |
| desktop | 32 |
| service | 8 |
| web-api | 149 |

## Positioning

Uni-CLI is built for agents that already have a shell. MCP compatibility is
available, but the primary path is faster and smaller: discover with
`unicli search`, inspect with `unicli describe`, execute with
`unicli <site> <command>`, and repair through the adapter path in the error
envelope.

## First Command

```bash
npm install -g @zenalexa/unicli
unicli search "hacker news frontpage"
unicli hackernews top --limit 5
```

## Choose The Right Entry Point

| Need                 | Start here                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| Install and run      | [Getting Started](/guide/getting-started)                                                                     |
| See supported sites  | [Sites Catalog](/reference/sites)                                                                             |
| Wire into an agent   | [Integrations](/guide/integrations)                                                                           |
| Add or repair a tool | [Adapters](/guide/adapters) and [Self-Repair](/guide/self-repair)                                             |
| Check exact behavior | [Adapter Format](/ADAPTER-FORMAT), [Pipeline Steps](/reference/pipeline), [Exit Codes](/reference/exit-codes) |
| Understand the shape | [Architecture](/ARCHITECTURE), [Benchmarks](/BENCHMARK), [Roadmap](/ROADMAP)                                  |

## Agent Index

The website also publishes an agent-readable index at [`/llms.txt`](/llms.txt).
It points agents to the install path, command catalog, adapter format, and
repair loop without making them crawl the whole site first.
