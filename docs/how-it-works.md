---
title: How Uni-CLI Works
description: A deep walkthrough of the Uni-CLI Agent-Computer Interface runtime — discovery, selection, policy, action, observation, and repair.
---

# How Uni-CLI Works

Uni-CLI is the open Agent-Computer Interface runtime for real software. It gives agents one searchable boundary across websites, logged-in browsers, desktop apps, local tools, files, operating-system capabilities, MCP servers, external CLIs, accessibility, and visual control. This page follows the current loop: how intent ranks cataloged operations, how an agent selects an operation with a declared substrate, how policy gates execution, how AgentEnvelope reports the call, and how repair keeps a path diagnosable when real software changes.

## The Agent-Computer Interface contract

The six public verbs are a compact model of the current executable stages, not
a claim that every transport has identical dispatch or evidence behavior.

1. **Discover (`intent`).** `unicli search "<intent>"` and plan-only `unicli do
"<intent>"` retrieve a small ranked set. Neither performs the external action.
2. **Select (`select`).** The agent selects an operation whose contract declares
   a strategy and substrate. Automatic arbitration across every alternative is
   a roadmap capability, not current behavior.
3. **Govern (`govern`).** Permission profiles, deny rules, capability scope, and
   local policy expose or gate supported effects before invocation.
4. **Act (`act`).** Adapter commands use the shared adapter kernel. Fixed core
   commands retain their native CLI handlers.
5. **Observe (`observe`, `diagnose`, `deliver`).** AgentEnvelope always
   distinguishes success from error and carries timing metadata. Artifacts,
   recordings, post-state checks, and trajectory evidence are operation-specific.
6. **Repair (`repair-or-reroute`).** Structured error and delivery fields can
   bound the next diagnosis, repair, or reroute when the operation supplies them.

`expose` is the ninth executable stage. Adapter operations are projected into
native CLI and MCP default/deferred/expanded profiles. Native CLI is currently
canonical for fixed core commands; full cross-protocol parity is roadmap work.

## Substrates, not identities

Browser automation, computer-use sandboxes, local execution, MCP servers,
page-native tools, and per-app harnesses are useful, but they are not Uni-CLI's
category. They are concrete technical boundaries that the Agent-Computer
Interface can execute through or expose.

| Substrate          | What it contributes                                               | What Uni-CLI keeps above it                             |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------- |
| Web/API            | typed fetch, cookie/header auth, downloads, extraction            | operation contracts, policy, structured results         |
| Browser            | CDP control, DOM/accessibility refs, screenshots, network capture | declared strategies, recordings, diagnostics            |
| Desktop/OS         | installed apps, accessibility trees, screenshots, local state     | governed actions and platform diagnostics               |
| Local tools/files  | subprocesses, PDFs, media tools, developer CLIs                   | typed args, output envelopes, retryability              |
| Protocols          | MCP, ACP, Streamable HTTP, JSON streams                           | adapter projection today; broader parity on the roadmap |
| Visual coordinates | explicit pixel-only screen interaction                            | route gate, exact evidence, foreground impact           |

## Where it sits in the protocol stack

The 2026 agent stack is specializing by boundary. [ARD](https://agenticresourcediscovery.org/spec/) and the [MCP Registry](https://modelcontextprotocol.io/registry/about) publish where capabilities exist. [MCP](https://modelcontextprotocol.io/) connects agents to tools and data. [WebMCP](https://developer.chrome.com/docs/ai/webmcp) lets an opted-in page publish live tools. [A2A](https://developers.googleblog.com/en/how-a2a-is-building-a-world-of-collaborative-agents/) connects collaborating agents. None of those layers must be replaced for Uni-CLI to work.

Uni-CLI owns the local operation boundary after discovery: check an executable
path, inspect the operation's declared substrate, apply available policy,
invoke it, report the result, and retain repair context where supported. ARD,
registry ingestion, and broader semantic substrate arbitration are architecture
directions rather than shipped automatic behavior. As standards mature, they
should enter as discovery inputs, substrates, or exposure formats—not trigger
an architecture rewrite.

## Domain-aware discovery

The catalog search layer is not a plain site-name lookup. It combines bilingual BM25 with command metadata, aliases, and domain vocabulary so an agent can search for an entity first and only then pick the right surface. For example, a query such as `Sparkle Honkai Star Rail character` can route toward character/wiki/anime sources, while `blue_archive rating:safe` can route toward booru tag search. Japanese names, romaji variants, Chinese names, and English titles are represented as aliases on the relevant adapter surfaces rather than hard-coded as one-off site shortcuts.

The same rule keeps broad searches honest. Domain boosts only apply when the query uses explicit ACG, paper, wiki, tag, game, anime, manga, or visual-novel vocabulary; generic queries still rank the normal web, developer, finance, or app commands by their own evidence.

### AI primary-source intelligence

`unicli ai` applies the same operation contract to AI research and engineering
signals. `ai profiles` describes what foundation-model, training, inference,
world-model, embodied-AI, hardware, agent, evaluation, and research roles watch
daily. `ai landscape` projects the maintained laboratory, vendor, runtime,
model-hub, venue, benchmark, robotics, and community directory. `ai search`
uses that role to select live native adapters and relevant first-party domains;
`ai pulse` executes the role's bounded queries and fuses timestamp-verifiable
results. ModelScope, OpenCSG, Bluesky posts, OpenReview, OpenAlex, Crossref, ACL
Anthology, YouTube, and the existing GitHub/Hugging Face/web/community adapters
share one normalized provenance contract.

These commands fetch upstream state when invoked; they do not imply a
background crawler or invent freshness. Authenticated X, Reddit, Linux.do,
Zhihu, and Bilibili sources are visible in `ai sources` and require explicit
selection (or `ai pulse --include-auth`). A community platform URL remains
community evidence even when the platform itself is listed in the landscape;
only a matched maintainer-owned domain or exact GitHub repository is labeled
first-party.

```bash
unicli ai profiles -f json
unicli ai landscape --profile world-models -f json
unicli ai pulse --profile inference --window week -f json
unicli ai search "KV cache scheduler" --profile inference --sort latest -f json
```

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

The runtime exposes <span><!-- STATS:pipeline_step_count -->113<!-- /STATS --></span>
built-in action names, but they are not one flat programming language:
<span><!-- STATS:pipeline_registered_step_count -->58<!-- /STATS --></span> are
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

## Declared web strategies

Authentication is the messiest part of touching the modern web. An operation
declares one of five strategies. The runtime executes that declared path; it
does not probe other strategies after failure.

| Strategy    | Auth source                               | Typical cost                               |
| ----------- | ----------------------------------------- | ------------------------------------------ |
| `public`    | None                                      | Direct fetch                               |
| `cookie`    | One declared site-bound credential source | Inject into target request headers         |
| `header`    | Cookie + auto-extracted CSRF              | Read CSRF, inject into target request      |
| `intercept` | Live browser session                      | Navigate page, capture XHR/fetch responses |
| `ui`        | Live browser session                      | Click, type, snapshot                      |

`public`, `cookie`, and `header` are separate structured HTTP authentication
contracts. `intercept` and `ui` are browser-backed contracts. Switching between
them is an adapter repair or explicit replan because the session, evidence,
cost, and side-effect boundaries differ.

Normal invocation reads persisted site credentials. `--auth-retry` explicitly
selects one source from the structured failure: the selected local-browser
profile for `auth_required`, or the live CDP target for
`challenge_required`. Fresh cookie values stay behind an opaque capability
that can be consumed by exactly one new invocation and only for the matching
site and domain. A miss or source failure ends the refresh without changing
authority. Only explicit `auth import` or `browser cookies` commands persist
plaintext JSON under `~/.unicli/cookies/`.

## The v2 AgentEnvelope

Every registered adapter command rendered by the CLI formatter returns a v2
AgentEnvelope with success and failure arms. Agents parse one schema across the static adapter
catalog of <span><!-- STATS:command_count -->1830<!-- /STATS --></span>
commands; fixed core and host-discovered commands are listed separately at
runtime.

```json
{
  "ok": true,
  "schema_version": "2",
  "command": "hackernews.top",
  "meta": {
    "duration_ms": 412,
    "count": 5,
    "surface": "web"
  },
  "data": [
    /* the result */
  ],
  "error": null
}
```

On failure, `ok` becomes `false`, `data` becomes `null`, and `error` always has
`code` plus `message`; other repair fields are conditional. The CLI maps
structured failures to process exit classes beside the envelope so shell
pipelines can route without adding an `exit_code` field to the JSON schema.

## The self-repair loop

This is the design choice that makes the rest of the architecture worth
building. When a site changes shape and the owned path is known, the error
envelope can give the agent a bounded fix:

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

This example includes the file to edit, failing step, hypothesis, and
alternatives because that failure class can supply them; other failures omit
fields that do not apply. After the YAML edit, `unicli repair twitter search`
re-runs the original command as a bounded JSON oracle and requires its envelope
and process exit to agree. The patch persists in `~/.unicli/adapters/`, so
`npm update` cannot wipe it. The economic argument for YAML is inspectable,
small source changes plus executable verification—not an unmeasured universal
time-saving claim.

## Why CLI is the native runtime surface

CLI is the native full surface, not the product boundary. It is the direct
contract for any host that can spawn a process. MCP exposes adapter operations
through default, deferred, and expanded profiles. ACP, HTTP-compatible routes,
and skills are integrations with their own supported subsets; they should not
be read as command-by-command parity claims.

**On-demand context.** `search -> describe -> invoke` lets a subprocess host
load only the selected operation. [docs/BENCHMARK.md](/BENCHMARK) measures
representative Uni-CLI `--limit 5` list-style calls at a 364-423 token total
budget (median 412). That is a Uni-CLI fixture, not a third-party protocol
comparison. Default/deferred MCP profiles and modern host-side tool search can
also load schemas on demand.

**Inspectability.** A CLI preserves arguments, stdout, stderr, exit status,
environment, and file artifacts at a familiar process boundary. Network,
browser, and desktop effects remain stateful and non-deterministic; Uni-CLI
does not relabel them as pure functions.

**Composability.** Shell pipelines, files, CI, and existing local tools can use
the CLI without a resident service. MCP is the stronger composition surface
inside a host that already owns protocol sessions and deferred tool discovery.

## When MCP still wins

CLI is not a universal replacement. MCP is often the better surface for:

- **Stateful auth** — long-lived OAuth flows, refreshing tokens, session-bound resources.
- **Real-time** — WebSocket-driven chat platforms, server-sent events, streaming completions.
- **Host-native discovery** — default meta-tool search or deferred tool loading inside an MCP-capable runtime.
- **Remote execution boundaries** — a governed server that should not be represented as a local subprocess.

Most production agent stacks need both. Uni-CLI ships `unicli mcp serve` with
default, deferred, and expanded profiles over adapter operation contracts.
Fixed core commands remain canonical on native CLI until the parity work in the
roadmap lands.

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

That is the canonical full exposure path. Adapter operation contracts can also
run through MCP profiles; ACP, HTTP, skills, and CI expose documented subsets.
One command shape covers the static catalog of
<span><!-- STATS:site_count -->326<!-- /STATS --></span> adapter sites and
<span><!-- STATS:command_count -->1830<!-- /STATS --></span> registered adapter
commands; fixed core and host-discovered commands join the native CLI at
runtime. Rendered calls share the v2 success/error envelope shape; optional
evidence and repair fields depend on the operation and failure class.

## Further reading

- [Adapter Format](/ADAPTER-FORMAT) — full reference for the YAML adapter schema.
- [Pipeline Reference](/reference/pipeline) — every pipeline step and its parameters.
- [Self-Repair Guide](/guide/self-repair) — the repair loop in detail.
- [FAQ](/faq) — quick answers to the most common questions.
- [Glossary](/glossary) — definitions for every term used in this guide.
