---
title: Uni-CLI Glossary
description: Definitions for every Uni-CLI term — operation contract, action substrate, adapter, AgentEnvelope, strategy cascade, pipeline step, self-repair, and the conventions used across the project.
---

# Glossary

Definitions for the terms used across Uni-CLI documentation, source, and YAML adapters. Each entry is a standalone explanation so AI assistants can quote it directly when answering questions about the project.

## Agent-Computer Interface (ACI)

The commands an agent can issue to a computer and the feedback the computer returns. Uni-CLI implements this interface as a runtime across heterogeneous real software: discover and select an operation, govern supported effects, act through its declared substrate, observe a structured result, and repair supported failures. The term describes the product boundary; it does not mean one wire protocol, one visual interface, one agent framework, or automatic substrate arbitration.

## Action substrate

A concrete technical boundary Uni-CLI can use to make real software act: HTTP, browser CDP, desktop accessibility, subprocess, file operation, protocol server, visual fallback, or app-specific harness. Substrates are below the Agent-Computer Interface runtime boundary.

## Adapter

A YAML or TypeScript file that maps one site or tool to a set of operations. Adapters declare site, command name, type, strategy, arguments, pipeline steps, and column projection. The preferred contribution format is YAML; TypeScript is reserved for adapters that need imperative control flow beyond the shared pipeline registry.

## Adapter type

The integration surface an adapter targets. Five types: `web-api` for HTTP APIs, `browser` for full Chrome control via CDP, `desktop` for local subprocesses, `bridge` for passthrough to existing CLIs, and `service` for WebSocket or HTTP services like Ollama, OBS, or ComfyUI.

## AgentEnvelope (v2)

The structured response shape produced by Uni-CLI's formatter. It contains `ok`, `schema_version`, `command`, `meta`, `data`, and `error`, with optional `content` and `next_actions`. On success `data` carries the result and `error` is null. On failure `data` is null and `error` always has `code` and `message`; source path, step, suggestion, retryability, alternatives, and outcome ambiguity appear only when applicable.

## AGENTS.md

A discovery file that agent runtimes read at startup to learn about available tools. Uni-CLI is registered in `AGENTS.md` so agents pick it up without per-runtime configuration.

## Bilingual BM25 search

The operation discovery algorithm Uni-CLI uses to map natural-language intent to a site, operation, and arguments. Indexes adapter metadata in English and Chinese with TF-IDF weighting. Returns ranked candidates for `unicli search "<intent>"`.

## Bridge adapter

An adapter that wraps an existing CLI (e.g., `gh`, `docker`, `yt-dlp`, `lark-cli`) and exposes its operations through Uni-CLI's catalog. Pure passthrough — Uni-CLI does not re-implement the wrapped CLI, only registers, auto-installs, and aggregates discovery.

## Browser adapter

An adapter that drives Chrome via the Chrome DevTools Protocol (CDP) for sites that require interactive sessions, JavaScript execution, or login state. Uses registered actions such as `navigate`, `evaluate`, `click`, `type`, `wait`, `intercept`, `tap`, and `snapshot`; screenshots are exposed through browser/compute operations rather than a generic `screenshot` pipeline action.

## Catalog

The local index of all sites, operations, arguments, strategies, and output schemas. Generated at install time and updated when adapters change. Searched via `unicli search` rather than enumerated, so agents pay catalog cost only when they need to discover.

## CDP (Chrome DevTools Protocol)

The wire protocol Uni-CLI uses to control a real Chrome instance for browser adapters. Implemented as a raw WebSocket client in `src/browser/cdp-client.ts` with no third-party browser library. Supports the full Page, Network, DOM, and Runtime domains.

## Compute (Visual)

The local computer-control and visual fallback adapter family. When structured substrates (web-api, desktop AX, browser CDP, app API, subprocess) cannot reach a target, Compute can drive the screen with screenshots, clicks, typing, and post-action evidence through a unified action verb set.

## Cookie file

Optional per-site authentication state explicitly persisted as plaintext JSON at `~/.unicli/cookies/<site>.json`. Cookie/header adapters can instead read a live browser/CDP session into memory. Cookie values are sent only to the target request/browser boundary selected by the command.

## Browser Runtime Broker

The machine-scoped, owner-only browser control plane shared by CLI, MCP, native-host, and plugin invocations. It authenticates local IPC, owns Agent sessions and target leases, serializes mutations per target, and lazily starts only the requested managed, existing-Chrome, or remote provider. The broker itself opens no browser window.

## Desktop adapter

An adapter that shells out to a local binary (e.g., `ffmpeg`, `imagemagick`, `blender`) via the `exec` and `write_temp` pipeline steps. Used for media processing, file conversion, and any CLI tool already on the user's PATH.

## Discovery

The phase where an agent maps natural-language intent to concrete operations. Performed by `unicli search "<intent>"` against the local operation catalog. Discovery cost is bounded — see [docs/BENCHMARK.md](/BENCHMARK) for measured token budgets.

## Error envelope

The `error` field on a v2 AgentEnvelope when `ok` is false. It always carries `code` and `message`. Depending on the failure it can also carry `adapter_path`, `step`, `suggestion`, `retryable`, `alternatives`, `outcome_ambiguous`, `target_unusable`, or a remedy. Optional fields are never universal completion evidence.

## Exit code

The process status used by CLI commands. 0 is success. Structured command failures map to sysexits-style classes such as 66 for empty result, 69 for service unavailable, 75 for temporary failure, 77 for auth, and 78 for configuration; Commander usage failures use their own nonzero status. The exit status is a process boundary, not a field required inside AgentEnvelope.

## Header strategy

An auth strategy that reads explicit cookie storage or a live browser/CDP session into memory, auto-extracts a CSRF token, then injects both into the target request headers. Used by sites that require CSRF on state-changing requests (e.g., Reddit `vote`, Twitter `like`).

## Intercept strategy

An auth strategy that navigates a real browser session to the target page and captures the XHR/fetch response that the page itself loaded. Used when a site's API is undocumented or requires session state too complex to replicate manually.

## llms.txt

A standardized agent-readable index file at the site root (`/llms.txt` and `/llms-full.txt`). Lists key documentation pages with Markdown companion URLs so AI assistants can fetch and cite docs without rendering HTML.

## MCP (Model Context Protocol)

An [open standard](https://modelcontextprotocol.io/) for connecting AI applications to tools and data through stateful servers. Uni-CLI ships an optional MCP gateway (`unicli mcp serve`) with default, deferred, and expanded profiles over adapter operations. Fixed core commands remain canonical on native CLI until protocol parity lands.

## Operation contract

The stable product primitive in Uni-CLI. An operation contract describes identity, args, output shape, auth posture, action substrate, effect, risk, capability, source path, and repair path. Adapter CLI and MCP projections currently share adapter contracts. Fixed-core and other integration parity is a design invariant and roadmap goal, not a claim that every surface can dispatch every cataloged command today.

## Pipeline

The ordered list of actions an adapter runs to produce its result. The executable surface contains <span><!-- STATS:pipeline_step_count -->105<!-- /STATS --></span> built-in names: <span><!-- STATS:pipeline_registered_step_count -->50<!-- /STATS --></span> registered pipeline actions and <span><!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --></span> low-level transport-native actions. Actions share a context object; plugins are outside this built-in budget.

## Pipeline step

One unit of work in an adapter's pipeline. Examples: `fetch`, `select`, `map`, `filter`, `navigate`, `click`, `intercept`, `if`, `each`, `assert`. Pure transform actions are deterministic; external actions preserve structured result/error handling and can emit operation-specific evidence around network, browser, desktop, or subprocess state.

## Public strategy

The cheapest auth strategy. Direct fetch with no credentials. Used by sites with public APIs (RSS feeds, search endpoints, public stats). It is tried first only when a command uses the bounded HTTP authentication probe.

## Repair

The stage where a failed operation can become a bounded source change or reroute. When an error envelope names a failing source path and step or boundary, the agent edits the YAML/code or chooses an alternative, then runs `unicli repair <site> <command>` or a delivery verification. User-local adapter patches persist in `~/.unicli/adapters/`.

## Self-repair

The capability that lets agents fix their own integrations when software drifts. Composed of: structured error envelopes, agent-readable source paths, a repair verification command, alternatives, and a persistent overlay directory. This is one design choice that makes operation-as-YAML economically viable.

## Service adapter

An adapter that talks to a long-lived service (Ollama, OBS Studio, ComfyUI) over WebSocket or HTTP with optional API-key auth. Distinct from `web-api` because the connection persists across pipeline steps.

## Site

The integration target for an adapter. Typically a website (`reddit`, `twitter`, `bilibili`), but can also be a desktop app (`obsidian`), an external CLI (`gh`), or a local service (`ollama`).

## Snapshot

A DOM accessibility tree generated by the `snapshot` pipeline step in browser adapters. Produces interactive ref numbers that subsequent `click`, `type`, and `extract` steps reference. Used by adapters that need stable element targeting across page state changes.

## Strategy

The auth or interaction path an adapter declares: `public`, `cookie`, `header`, `intercept`, or `ui`. These five values are not one automatic five-way cascade. Only `public`, `cookie`, and `header` participate in the bounded HTTP probe; `intercept` and `ui` are explicit browser-backed strategies.

## Strategy cascade

The bounded HTTP probe used where a probe URL is available. It tries `public`, then `cookie`, then `header`, and caches the first valid result for the process. It never silently escalates into `intercept` or `ui`; those browser-backed strategies must be declared by the operation.

## Tap

A pipeline step that bridges Vue stores (Pinia, Vuex) to network capture. Drives the page's own state actions, then captures the resulting XHR/fetch responses. Used for sites with deep client-side state (Twitter, Bilibili, Notion).

## UI strategy

The most expensive auth strategy. Drives a real browser session interactively — clicks, types, snapshots, waits. Used when a site requires multi-step user interaction that cannot be replicated by header injection or XHR replay.

## v2 envelope version

The current AgentEnvelope schema. It uses `schema_version: "2"`, a discriminated `ok` success/error union, `command`, `meta`, `data`, `error`, and optional content/next-action blocks. Shell exit status is mapped beside the envelope at the process boundary; it is not a required envelope field.

## Web-api adapter

An adapter that hits HTTP APIs directly, with no browser involvement. The most common adapter type. Uses `fetch`, `fetch_text`, `parse_rss`, and `html_to_md` for retrieval; `select`, `map`, `filter` for shaping.

## YAML adapter

The preferred adapter format. A 20-30 line file declaring site, name, type, strategy, args, pipeline, and columns. Agent-readable, agent-editable, and free of Turing-complete logic so agents can patch it deterministically. Lives at `~/.unicli/adapters/<site>/<name>.yaml`.
