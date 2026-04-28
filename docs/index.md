---
layout: home

hero:
  name: "Uni-CLI"
  text: "The agent execution substrate for the world's software."
  tagline: "Discover by intent, execute governed commands across web, apps, local tools, and system capabilities, then return evidence-rich AgentEnvelopes that agents can inspect and repair."
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
  - title: Discover By Intent
    details: "Bilingual BM25 maps natural language to runnable commands across 235 sites and 1448 commands."
  - title: Execute Real Surfaces
    details: "One CLI spans web APIs, browser automation, macOS apps, desktop tools, local services, and external CLIs."
  - title: Return AgentEnvelopes
    details: "Markdown, JSON, YAML, CSV, and compact output share the same v2 success/error contract."
  - title: Govern Side Effects
    details: "Operation policy exposes effect, risk, approval, and capability scope through open, confirm, and locked profiles."
  - title: Record Evidence
    details: "Opt-in run traces and browser action evidence make execution inspectable without changing the command contract."
  - title: Repair In Place
    details: "Failures include adapter path, pipeline step, retryability, suggestions, and alternatives."
  - title: Plug Into Agents
    details: "CLI-first execution stays native to coding agents; MCP, ACP, and JSON streams are compatibility surfaces."
---

<VersionNotice />

<SiteStats />

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
