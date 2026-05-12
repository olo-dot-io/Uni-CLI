---
title: How Uni-CLI Works
description: A deep walkthrough of the Uni-CLI execution model — the YAML adapter format, the v2 AgentEnvelope, strategy cascade, the pipeline registry, and the self-repair loop that lets agents fix their own integrations.
---

# How Uni-CLI Works

Uni-CLI is a command-line execution layer that turns websites, desktop apps, MCP servers, and external CLIs into a single searchable command catalog for AI agents. This page walks through the architecture: how a YAML adapter compiles into a CLI command, how the strategy cascade resolves authentication, how the v2 AgentEnvelope returns evidence, and how the self-repair loop closes when a site changes shape.

## The four-part contract

Every Uni-CLI command runs through the same four phases. Agents can stop at any phase and reason about the result.

1. **Discover.** `unicli search "<intent>"` queries the local catalog with bilingual BM25 ranking and returns matching site, command, args, auth strategy, and output schema.
2. **Execute.** `unicli <site> <command> [args]` runs the YAML pipeline and returns a v2 AgentEnvelope.
3. **Recover.** Failures emit `{ adapter_path, step, action, suggestion, retryable, alternatives }` so the agent has a bounded fix path.
4. **Repair.** The agent edits the YAML at `adapter_path` and runs `unicli repair <site> <command>` to verify the patch.

This contract holds across all five adapter types: web-api, browser, desktop, bridge, and service.

## The YAML adapter format

The unit of integration is a 20-line YAML file. Here's a complete adapter for a public RSS feed:

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

Five fields define the contract: `site` (the integration name), `name` (the command), `type` (which surface — web-api, browser, desktop, bridge, service), `strategy` (auth path), and `pipeline` (the steps that produce the result). An adapter without imports, classes, or compile steps lets an agent read it, patch a selector, and verify the fix in seconds.

## The pipeline registry

Every adapter runs through the same <!-- STATS:pipeline_step_count -->101<!-- /STATS -->-step pipeline registry. Steps are grouped by purpose: API fetch, transform, browser, desktop, media, control flow, and assertion. Each step is deterministic — same inputs produce same outputs — so adapters compose into reliable execution graphs.

| Group     | Examples                                                            | Purpose                                  |
| --------- | ------------------------------------------------------------------- | ---------------------------------------- |
| API       | `fetch`, `fetch_text`, `parse_rss`, `html_to_md`                    | HTTP retrieval and structured extraction |
| Transform | `select`, `map`, `filter`, `sort`, `limit`                          | Reshape JSON between steps               |
| Browser   | `navigate`, `evaluate`, `click`, `type`, `wait`, `intercept`, `tap` | CDP control over Chrome                  |
| Desktop   | `exec`, `write_temp`                                                | Subprocess control                       |
| Media     | `download`, `websocket`                                             | File and stream capture                  |
| Control   | `set`, `if`, `each`, `parallel`, `rate_limit`, `assert`, `retry`    | Composition primitives                   |
| Output    | `extract`, columns                                                  | Final shape for the agent                |

The pipeline runs top to bottom with a shared context object. Each step reads `ctx.data` and writes back. Templates (`${{ item.field }}`) interpolate from prior step outputs.

## The strategy cascade

Authentication is the messiest part of touching the modern web. Every adapter declares one of five strategies, and Uni-CLI auto-probes the cheapest one that returns valid data.

| Strategy    | Auth source                                    | Typical cost                               |
| ----------- | ---------------------------------------------- | ------------------------------------------ |
| `public`    | None                                           | Direct fetch                               |
| `cookie`    | Cookie file at `~/.unicli/cookies/<site>.json` | Inject into headers                        |
| `header`    | Cookie + auto-extracted CSRF                   | Read CSRF from cookie, inject into request |
| `intercept` | Live browser session                           | Navigate page, capture XHR/fetch responses |
| `ui`        | Live browser session                           | Click, type, snapshot                      |

The cascade order is `public → cookie → header → intercept → ui`. On the first run for a site, Uni-CLI tries each strategy until one returns parseable data, then caches the result. Subsequent calls skip the probe.

## The v2 AgentEnvelope

Every command returns a v2 AgentEnvelope — the same shape on success or failure.
Agents parse one schema across
<span><!-- STATS:command_count -->1616<!-- /STATS --></span> commands.

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
  "version": "v2",
  "data": null,
  "error": {
    "adapter_path": "/Users/me/.unicli/adapters/twitter/search.yaml",
    "step": "fetch",
    "action": "request returned 404",
    "suggestion": "endpoint may have moved; check x.com/i/api/graphql/* in DevTools Network tab",
    "retryable": false,
    "alternatives": ["unicli twitter timeline @user", "unicli twitter trending"]
  },
  "exit_code": 69
}
```

The agent has everything it needs: the file to edit, the failing step, a one-line hypothesis, and at least one alternative path. After the YAML edit, `unicli repair twitter search` re-runs the failing step against a known-good fixture. The patch persists in `~/.unicli/adapters/`, so `npm update` cannot wipe it.

A bug that would have cost 30 minutes of human debugging closes in 30 seconds of agent runtime. That two-orders-of-magnitude difference is the entire economic argument for adapters as YAML.

## Why CLI is the right shape for agent tools

Three forces make CLI the cheaper primary surface for agent tooling.

**Token economics.** [docs/BENCHMARK.md](/BENCHMARK) measures `--limit 5` list-style adapters at a 364-423 token total call budget (median 412). An MCP server keeps its tool list resident in the agent's context window — typically 1,500-3,000 tokens per server — even when the agent does not invoke it. The CLI pays for what it uses; the MCP server pays to be available.

**Determinism.** A CLI call is a pure function of arguments and time. Same arguments, same minute, same output. MCP roundtrips add a stateful server, a transport, and a protocol layer that can drift. For agent automation, fewer moving parts reduces failure modes.

**Composability.** Shell pipelines are the lingua franca of automation. `unicli reddit hot r/programming -n 50 -f json | jq '.data[].title' | unicli huggingface summarize -` works the day Uni-CLI installs. Same composition with MCP requires a glue layer.

## When MCP still wins

CLI is not a universal replacement. MCP is the better surface for:

- **Stateful auth** — long-lived OAuth flows, refreshing tokens, session-bound resources.
- **Real-time** — WebSocket-driven chat platforms, server-sent events, streaming completions.
- **Single-platform deep integration** — a vendor-built MCP server for a vertical platform usually outperforms a third-party CLI adapter for that platform.

Most production agent stacks need both. Uni-CLI ships an MCP gateway (`unicli mcp serve`) that wraps the same catalog, so a runtime that only speaks MCP gets the same execution surface without a second integration.

## The catalog as a first-class artifact

Search beats discovery-by-prompt. `unicli search "find AI agent discussions on reddit"` returns a ranked list of matching commands with arguments, auth, and example output. The agent picks one, runs it, and never has to enumerate the catalog. This is the same pattern Apideck CLI and OnlyCLI report 96-99% token savings on — load the catalog index, not the catalog body.

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

That is the entire interaction model. One command shape across
<span><!-- STATS:site_count -->268<!-- /STATS --></span> sites and
<span><!-- STATS:command_count -->1616<!-- /STATS --></span> commands. One error
envelope across every failure. One self-repair path across every adapter.

## Further reading

- [Adapter Format](/ADAPTER-FORMAT) — full reference for the YAML adapter schema.
- [Pipeline Reference](/reference/pipeline) — every pipeline step and its parameters.
- [Self-Repair Guide](/guide/self-repair) — the repair loop in detail.
- [Theory](/THEORY) — the CS-theoretical grounding (Rice's restriction, Lehman's mandate, Banach convergence, the agent-tool trilemma).
- [FAQ](/faq) — quick answers to the most common questions.
- [Glossary](/glossary) — definitions for every term used in this guide.
