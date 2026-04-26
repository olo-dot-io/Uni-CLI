---
layout: home

hero:
  name: "Uni-CLI"
  text: "Agent-native command access to software."
  tagline: "Search by intent, run a real command, get a structured envelope, and repair the adapter when the outside world changes."
  image:
    src: /logo-light.svg
    alt: Uni-CLI
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Integrate an Agent
      link: /guide/integrations

features:
  - title: Discover
    details: "Bilingual BM25 search maps natural-language intent to runnable site commands."
  - title: Execute
    details: "One CLI covers web APIs, browser automation, desktop apps, local tools, and external CLIs."
  - title: Inspect
    details: "Every output format uses the same v2 success/error envelope, including machine-actionable failures."
  - title: Repair
    details: "Broken adapters point to the YAML file, step, retryability, suggestion, and alternatives."
  - title: Integrate
    details: "Use the native CLI first, or expose the same catalog over MCP, ACP, JSON stream, and bridge routes."
  - title: Extend
    details: "Small YAML adapters compose 59 typed pipeline steps without adding runtime dependencies."
---

## First Command

```bash
npm install -g @zenalexa/unicli
unicli search "hacker news frontpage"
unicli hackernews top --limit 5
```

## Documentation Map

| Need                 | Start here                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| Install and run      | [Getting Started](/guide/getting-started)                                                                     |
| Wire into an agent   | [Integrations](/guide/integrations)                                                                           |
| Add or repair a tool | [Adapters](/guide/adapters) and [Self-Repair](/guide/self-repair)                                             |
| Check exact behavior | [Adapter Format](/ADAPTER-FORMAT), [Pipeline Steps](/reference/pipeline), [Exit Codes](/reference/exit-codes) |
| Understand the shape | [Architecture](/ARCHITECTURE), [Benchmarks](/BENCHMARK), [Roadmap](/ROADMAP)                                  |

This site keeps the public path small: quick start, task guides, reference,
and explanation. Release mechanics, generated catalogs, and historical notes
stay out of the first path unless they answer a current user question.
