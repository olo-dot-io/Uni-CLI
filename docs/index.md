---
layout: home

hero:
  name: "Uni-CLI"
  text: "The native command surface for agents."
  tagline: "Search by intent, run typed commands, get structured envelopes, and repair broken tools without leaving the shell."
  image:
    src: /mascot-otter.png
    alt: Uni-CLI otter mascot holding a terminal tablet
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Browse Sites
      link: /reference/sites

features:
  - title: Search By Intent
    details: "Bilingual BM25 maps natural language to runnable commands across 223 sites and 1304 commands."
  - title: Operate Real Surfaces
    details: "The same CLI spans web APIs, browser automation, macOS apps, desktop tools, and external CLIs."
  - title: Return Agent Envelopes
    details: "Markdown, JSON, YAML, CSV, and compact output share the same v2 success/error contract."
  - title: Repair In Place
    details: "Failures include adapter path, pipeline step, retryability, suggestions, and alternatives."
  - title: Plug Into Agents
    details: "CLI-first execution stays native to coding agents; MCP, ACP, and JSON streams are compatibility surfaces."
  - title: Stay Small
    details: "YAML adapters compose typed pipeline steps and avoid heavy per-site SDK dependencies."
---

<SiteStats />

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
