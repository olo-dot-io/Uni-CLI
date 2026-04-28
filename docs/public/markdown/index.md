<!-- Generated from docs/index.md. Do not edit this copy directly. -->

# Overview

- Canonical: https://olo-dot-io.github.io/Uni-CLI/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/index.md
- Section: Start

## The agent execution substrate for the world's software.

Discover by intent, execute governed commands across web, apps, local tools, and system capabilities, then return evidence-rich AgentEnvelopes that agents can inspect and repair.

## Primary Actions

- [Get Started](/guide/getting-started)
- [Browse Sites](/reference/sites)

## Capabilities

- **Discover By Intent.** Bilingual BM25 maps natural language to runnable commands across 235 sites and 1448 commands.
- **Execute Real Surfaces.** One CLI spans web APIs, browser automation, macOS apps, desktop tools, local services, and external CLIs.
- **Return AgentEnvelopes.** Markdown, JSON, YAML, CSV, and compact output share the same v2 success/error contract.
- **Govern Side Effects.** Operation policy exposes effect, risk, approval, and capability scope through open, confirm, and locked profiles.
- **Record Evidence.** Opt-in run traces and browser action evidence make execution inspectable without changing the command contract.
- **Repair In Place.** Failures include adapter path, pipeline step, retryability, suggestions, and alternatives.
- **Plug Into Agents.** CLI-first execution stays native to coding agents; MCP, ACP, and JSON streams are compatibility surfaces.

## Current Version

v1.0.0 (Apollo · Lovell) shipped to npm on 2026-04-28; the @zenalexa/unicli latest tag now points to this release.

Current public catalog: 235 sites, 1448 commands.

### Update Notes

- First stable execution-substrate release for agent-driven web, app, local tool, system, and external CLI operations.
- The public contract is command-first discovery, v2 AgentEnvelope output, repairable adapter errors, operation policy metadata, and optional run recording.
- Browser actions can emit structured pre/post evidence, movement detection, stale-ref failure details, and watchdog results.
- The public docs catalog reports the current 235-site, 1448-command, 1039-adapter, 59-step, 7469-test surface.

### Links

- [@zenalexa/unicli on npm](https://www.npmjs.com/package/@zenalexa/unicli)
- [GitHub Release v1.0.0](https://github.com/olo-dot-io/Uni-CLI/releases/tag/v1.0.0)
- [Changelog](https://github.com/olo-dot-io/Uni-CLI/blob/main/CHANGELOG.md#100--2026-04-28--apollo--lovell)

## Catalog Snapshot

- Sites: 235
- Commands: 1448
- Surface families: 5
- Agent envelope: v2

| Surface | Sites |
| --- | ---: |
| bridge | 24 |
| browser | 10 |
| desktop | 32 |
| service | 8 |
| web-api | 161 |

## Positioning

Uni-CLI sits below agent applications and above websites, desktop apps, local
tools, and system capabilities. It is not a scraper, a protocol-only wrapper, or
a CUA-first product. The stable primitive is a command an agent can search,
inspect, execute, record, and repair.

MCP compatibility is available, but the primary path is still direct and small:
discover with `unicli search`, inspect with `unicli describe`, execute with
`unicli <site> <command>`, optionally record with `--record`, and repair through
the adapter path in the error envelope.

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
