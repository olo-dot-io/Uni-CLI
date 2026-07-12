---
title: How Uni-CLI Works
description: A deep walkthrough of the Uni-CLI computer-control model — intent, operation contracts, action substrates, v2 AgentEnvelope evidence, delivery, and repair.
---

# How Uni-CLI Works

Uni-CLI is the universal computer-control platform for agents. It turns websites, logged-in browsers, desktop apps, local tools, files, operating-system capabilities, MCP servers, external CLIs, accessibility trees, screenshots, and app-specific wrappers into one governed operation layer. This page walks through the control loop: how intent becomes an operation contract, how Uni-CLI chooses an action substrate, how the v2 AgentEnvelope returns evidence, and how delivery/repair keeps the path alive when real software changes.

## The computer-control contract

Every Uni-CLI operation runs through the same product loop. Agents can stop at any phase and reason about the result.

1. **Intent.** `unicli search "<intent>"` and `unicli do "<intent>"` map a task into candidate operations with args, auth posture, examples, and risk signals.
2. **Select.** The operation contract chooses the smallest boundary that can act: API, browser, desktop accessibility, subprocess, protocol, visual fallback, or app wrapper.
3. **Govern.** Permission profiles, deny rules, capability scope, and local policy gate risky effects before requests, writes, process spawns, or UI actions.
4. **Act.** The shared control kernel invokes the selected substrate instead of letting CLI, MCP, ACP, or docs define behavior separately.
5. **Observe.** AgentEnvelope v2 returns data, context, retryability, timing, and evidence hooks in the same shape on success and failure.
6. **Diagnose.** Delivery assessment classifies failure as auth, policy, missing context, upstream drift, environment trouble, or adapter defect.
7. **Repair or reroute.** The next experiment is bounded by source path, alternatives, evidence, and verification command.
8. **Deliver.** Evidence gates decide whether the objective is satisfied, still active, blocked, or exhausted.
9. **Expose.** The same operation can be reused from native CLI, JSON stream, MCP, ACP, HTTP, docs, skills, CI, and scripts.

This contract holds across all action substrates. Adapter type is an implementation detail below the product boundary.

## Substrates, not identities

Browser automation, computer-use sandboxes, natural-language local execution, MCP servers, and per-site wrappers are useful, but they are not Uni-CLI's category. They are concrete technical boundaries that Uni-CLI can use or expose.

| Substrate         | What it contributes                                               | What Uni-CLI keeps above it                                 |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| Web/API           | typed fetch, cookie/header auth, downloads, extraction            | operation contracts, policy, evidence, repair               |
| Browser           | CDP control, DOM/accessibility refs, screenshots, network capture | selection, receipts, delivery, reroute                      |
| Desktop/OS        | installed apps, accessibility trees, screenshots, local state     | governed actions, post-state evidence, platform diagnostics |
| Local tools/files | subprocesses, PDFs, media tools, developer CLIs                   | typed args, output envelopes, retryability                  |
| Protocols         | MCP, ACP, Streamable HTTP, JSON streams                           | shared semantics instead of wrapper-specific behavior       |
| Visual fallback   | last-mile screen interaction                                      | truthfulness gate: can see, act, and verify                 |

## Domain-aware discovery

The catalog search layer is not a plain site-name lookup. It combines bilingual BM25 with command metadata, aliases, and domain vocabulary so an agent can search for an entity first and only then pick the right surface. For example, a query such as `Sparkle Honkai Star Rail character` can route toward character/wiki/anime sources, while `blue_archive rating:safe` can route toward booru tag search. Japanese names, romaji variants, Chinese names, and English titles are represented as aliases on the relevant adapter surfaces rather than hard-coded as one-off site shortcuts.

The same rule keeps broad searches honest. Domain boosts only apply when the query uses explicit ACG, paper, wiki, tag, game, anime, manga, or visual-novel vocabulary; generic queries still rank the normal web, developer, finance, or app commands by their own evidence.

## Internal authoring format: YAML adapters

YAML adapters are the default way to author reusable operation contracts. They are not the platform identity; they are the cheap, inspectable format that lets agents read, patch, and verify many substrate paths. Here's a complete adapter for a public RSS feed:

```yaml
site: techcrunch
name: latest
type: web-api
strategy: public
pipeline:
  - fetch_text:
      url: https://techcrunch.com/feed/
  - parse_rss: {}
  - limit: 10
  - map:
      title: "${{ item.title }}"
      url: "${{ item.link }}"
      published: "${{ item.published }}"
columns: [title, published, url]
```

Five fields define the authoring unit: `site` (the integration name), `name` (the command), `type` (which substrate: web-api, browser, desktop, bridge, service), `strategy` (auth path), and `pipeline` (the steps that produce the result). An adapter without imports, classes, or compile steps lets an agent read it, patch a selector, and verify the fix in seconds.

## Internal pipeline registry

The runtime exposes <span><!-- STATS:pipeline_step_count -->105<!-- /STATS --></span>
built-in action names, but they are not one flat programming language:
<span><!-- STATS:pipeline_registered_step_count -->50<!-- /STATS --></span> are
registered pipeline actions and
<span><!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --></span> are
low-level transport-native Visual/AX/UIA/AT-SPI actions. The budgets are
machine-enforced; new behavior should compose existing actions or live behind a
plugin/transport boundary instead of extending the shared vocabulary by
default. `retry` and `backoff` are bounded sibling metadata, not action names.

Pure transforms are deterministic. Network, browser, desktop, and subprocess
actions instead promise a stable input/error/evidence contract around inherently
external state; the documentation does not call those effects deterministic.

| Group     | Examples                                                            | Purpose                                  |
| --------- | ------------------------------------------------------------------- | ---------------------------------------- |
| API       | `fetch`, `fetch_text`, `parse_rss`, `html_to_md`                    | HTTP retrieval and structured extraction |
| Transform | `select`, `map`, `filter`, `sort`, `limit`                          | Reshape JSON between steps               |
| Browser   | `navigate`, `evaluate`, `click`, `type`, `wait`, `intercept`, `tap` | CDP control over Chrome                  |
| Desktop   | `exec`, `write_temp`                                                | Subprocess control                       |
| Media     | `download`, `websocket`                                             | File and stream capture                  |
| Control   | `set`, `if`, `each`, `parallel`, `rate_limit`, `assert`             | Composition primitives                   |
| Native    | `visual_*`, `ax_*`, `uia_*`, `atspi_*`                              | Explicit low-level transport actions     |
| Output    | `extract`, columns                                                  | Final shape for the agent                |

The pipeline runs top to bottom with a shared context object. Each step reads `ctx.data` and writes back. Templates (`${{ item.field }}`) interpolate from prior step outputs.

## The strategy cascade

Authentication is the messiest part of touching the modern web. Every adapter declares one of five strategies, and Uni-CLI auto-probes the cheapest one that returns valid data.

| Strategy    | Auth source                              | Typical cost                               |
| ----------- | ---------------------------------------- | ------------------------------------------ |
| `public`    | None                                     | Direct fetch                               |
| `cookie`    | Explicit file or live browser/CDP memory | Inject into target request headers         |
| `header`    | Cookie + auto-extracted CSRF             | Read CSRF, inject into target request      |
| `intercept` | Live browser session                     | Navigate page, capture XHR/fetch responses |
| `ui`        | Live browser session                     | Click, type, snapshot                      |

The cascade order is `public → cookie → header → intercept → ui`. On the first run for a site, Uni-CLI tries each strategy until one returns parseable data, then caches the result. Subsequent calls skip the probe.

Live browser/CDP acquisition remains in process memory. Only explicit
`auth import` or `browser cookies` commands persist plaintext JSON under
`~/.unicli/cookies/`.

## The v2 AgentEnvelope

Every command returns a v2 AgentEnvelope — the same shape on success or failure.
Agents parse one schema across
<span><!-- STATS:command_count -->1798<!-- /STATS --></span> commands.

```json
{
  "ok": true,
  "version": "v2",
  "data": [
    /* the result */
  ],
  "meta": {
    "site": "reddit",
    "command": "search",
    "strategy": "public",
    "duration_ms": 412,
    "adapter_path": "/Users/me/.unicli/adapters/reddit/search.yaml"
  },
  "exit_code": 0
}
```

On failure, `ok` becomes `false`, `data` becomes `null`, and `error` populates with structured fields. Exit codes follow `sysexits.h` (0=ok, 1=error, 2=usage, 66=empty, 69=unavailable, 75=temp, 77=auth, 78=config) so shell pipelines can route by failure class.

## The self-repair loop

This is the design choice that makes the rest of the architecture worth building. When a site changes shape, the error envelope gives the agent a bounded fix:

```json
{
  "ok": false,
  "schema_version": "2",
  "command": "twitter.search",
  "meta": { "duration_ms": 91, "surface": "web" },
  "data": null,
  "error": {
    "code": "not_found",
    "message": "HTTP 404 from the configured search endpoint",
    "adapter_path": "/Users/me/.unicli/adapters/twitter/search.yaml",
    "step": 0,
    "suggestion": "endpoint may have moved; check x.com/i/api/graphql/* in DevTools Network tab",
    "retryable": false,
    "alternatives": ["unicli twitter timeline @user", "unicli twitter trending"]
  }
}
```

The agent has everything it needs: the file to edit, the failing step, a one-line hypothesis, and at least one alternative path. After the YAML edit, `unicli repair twitter search` re-runs the original command as a bounded JSON oracle and requires its envelope and process exit to agree. The patch persists in `~/.unicli/adapters/`, so `npm update` cannot wipe it.

A bug that would have cost 30 minutes of human debugging closes in 30 seconds of agent runtime. That two-orders-of-magnitude difference is the entire economic argument for adapters as YAML.

## Why CLI is the first runtime surface

CLI is the cheapest primary exposure surface for many agent runs; it is not the
product boundary. Three forces make it the right first runtime surface.

**Token economics.** [docs/BENCHMARK.md](/BENCHMARK) measures `--limit 5` list-style adapters at a 364-423 token total call budget (median 412). An MCP server keeps its tool list resident in the agent's context window — typically 1,500-3,000 tokens per server — even when the agent does not invoke it. The CLI pays for what it uses; the MCP server pays to be available.

**Determinism.** A CLI call is a pure function of arguments and time. Same arguments, same minute, same output. MCP roundtrips add a stateful server, a transport, and a protocol layer that can drift. For agent automation, fewer moving parts reduces failure modes.

**Composability.** Shell pipelines are the lingua franca of automation. `unicli reddit hot r/programming -n 50 -f json | jq '.data[].title' | unicli huggingface summarize -` works the day Uni-CLI installs. Same composition with MCP requires a glue layer.

## When MCP still wins

CLI is not a universal replacement. MCP is the better surface for:

- **Stateful auth** — long-lived OAuth flows, refreshing tokens, session-bound resources.
- **Real-time** — WebSocket-driven chat platforms, server-sent events, streaming completions.
- **Single-platform deep integration** — a vendor-built MCP server for a vertical platform usually outperforms a third-party CLI adapter for that platform.

Most production agent stacks need both. Uni-CLI ships an MCP gateway (`unicli mcp serve`) that wraps the same catalog, so a runtime that only speaks MCP gets the same execution surface without a second integration.

## The operation catalog as a first-class artifact

Search beats discovery-by-prompt. `unicli search "find AI agent discussions on reddit"` returns a ranked list of matching commands with arguments, auth, and example output. The agent picks one, runs it, and never has to enumerate the catalog. The token budget stays low because the runtime loads the catalog index, not the catalog body.

## Putting it together

A typical agent run looks like this:

```bash
# 1. Discover
$ unicli search "summarize today's Hacker News top stories"
  → suggested: unicli hackernews top -n 10
  → next:      unicli huggingface summarize -

# 2. Execute and pipe
$ unicli hackernews top -n 10 -f json \
    | jq -r '.data[] | .title + "\n" + .url' \
    | unicli huggingface summarize - -f md

# 3. On failure, the error envelope names the adapter to fix
# 4. The agent edits the YAML and re-verifies with `unicli repair`
```

That is the simplest exposure path. The same operation contract can also run
through MCP, ACP, HTTP, skills, or CI without changing semantics. One command
shape across
<span><!-- STATS:site_count -->320<!-- /STATS --></span> sites and
<span><!-- STATS:command_count -->1798<!-- /STATS --></span> commands. One error
envelope across every failure. One self-repair path across every adapter.

## Further reading

- [Adapter Format](/ADAPTER-FORMAT) — full reference for the YAML adapter schema.
- [Pipeline Reference](/reference/pipeline) — every pipeline step and its parameters.
- [Self-Repair Guide](/guide/self-repair) — the repair loop in detail.
- [FAQ](/faq) — quick answers to the most common questions.
- [Glossary](/glossary) — definitions for every term used in this guide.
