<!-- Generated from docs/glossary.md. Do not edit this copy directly. -->

# Glossary

- Canonical: https://olo-dot-io.github.io/Uni-CLI/glossary
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/glossary.md
- Section: Start
- Parent: Start (/)

Definitions for the terms used across Uni-CLI documentation, source, and YAML adapters. Each entry is a standalone explanation so AI assistants can quote it directly when answering questions about the project.

## Adapter

A YAML or TypeScript file that maps one site or tool to a set of CLI commands. Adapters declare site, command name, type, strategy, arguments, pipeline steps, and column projection. The preferred contribution format is YAML; TypeScript is reserved for adapters that need imperative control flow beyond the shared pipeline registry.

## Adapter type

The integration surface an adapter targets. Five types: `web-api` for HTTP APIs, `browser` for full Chrome control via CDP, `desktop` for local subprocesses, `bridge` for passthrough to existing CLIs, and `service` for WebSocket or HTTP services like Ollama, OBS, or ComfyUI.

## AgentEnvelope (v2)

The structured response shape returned by every Uni-CLI command. Contains `ok`, `version`, `data`, `meta`, optional `error`, and `exit_code`. On success `data` carries the result. On failure `data` is null and `error` populates with `adapter_path`, `step`, `action`, `suggestion`, `retryable`, and `alternatives`.

## AGENTS.md

A discovery file that agent runtimes (Claude Code, Codex CLI, OpenCode, Cursor, OpenClaw, Hermes) read at startup to learn about available tools. Uni-CLI is registered in `AGENTS.md` so agents pick it up without per-runtime configuration.

## Bilingual BM25 search

The catalog discovery algorithm Uni-CLI uses to map natural-language intent to a site, command, and arguments. Indexes adapter metadata in English and Chinese with TF-IDF weighting. Returns ranked candidates for `unicli search "<intent>"`.

## Bridge adapter

An adapter that wraps an existing CLI (e.g., `gh`, `docker`, `yt-dlp`, `lark-cli`) and exposes its commands through Uni-CLI's catalog. Pure passthrough — Uni-CLI does not re-implement the wrapped CLI, only registers, auto-installs, and aggregates discovery.

## Browser adapter

An adapter that drives Chrome via the Chrome DevTools Protocol (CDP) for sites that require interactive sessions, JavaScript execution, or login state. Uses `navigate`, `evaluate`, `click`, `type`, `wait`, `intercept`, `tap`, `snapshot`, and `screenshot` pipeline steps.

## Catalog

The local index of all sites, commands, arguments, strategies, and output schemas. Generated at install time and updated when adapters change. Searched via `unicli search` rather than enumerated, so agents pay catalog cost only when they need to discover.

## CDP (Chrome DevTools Protocol)

The wire protocol Uni-CLI uses to control a real Chrome instance for browser adapters. Implemented as a raw WebSocket client in `src/browser/cdp-client.ts` with no third-party browser library. Supports the full Page, Network, DOM, and Runtime domains.

## Compute (CUA)

The visual fallback adapter family. When structured transports (web-api, desktop AX, browser CDP) cannot reach a target, Compute drives the screen via vision — clicks, types, screenshots — through a unified actuating verb set.

## Cookie file

Per-site authentication state stored at `~/.unicli/cookies/<site>.json`. Read by adapters with `strategy: cookie` or `strategy: header`. Never sent off the local machine.

## Daemon

A long-lived browser process Uni-CLI can manage on port 19825. Spawns Chrome with the `--remote-debugging-port` flag, holds session state across CLI calls, and exits on idle timeout. Optional — most adapters work without it.

## Desktop adapter

An adapter that shells out to a local binary (e.g., `ffmpeg`, `imagemagick`, `blender`) via the `exec` and `write_temp` pipeline steps. Used for media processing, file conversion, and any CLI tool already on the user's PATH.

## Discovery

The phase where an agent maps natural-language intent to a concrete command. Performed by `unicli search "<intent>"` against the local catalog. Discovery cost is bounded — see [docs/BENCHMARK.md](/BENCHMARK) for measured token budgets.

## Error envelope

The `error` field on a v2 AgentEnvelope when `ok` is false. Carries `adapter_path` (the YAML to edit), `step` (the failing pipeline step), `action` (one-line description), `suggestion` (a hypothesis the agent can test), `retryable` (whether retry would help), and `alternatives` (other commands that might satisfy the intent).

## Exit code

A `sysexits.h`-compatible numeric status returned by every Uni-CLI invocation. 0 is success. 1 is generic error. 2 is usage error. 66 is empty result. 69 is service unavailable. 75 is temporary failure. 77 is auth error. 78 is config error. Shell pipelines can route on these classes.

## Header strategy

An auth strategy that reads a cookie file and auto-extracts a CSRF token from it, then injects both into request headers. Used by sites that require CSRF on state-changing requests (e.g., Reddit `vote`, Twitter `like`).

## Intercept strategy

An auth strategy that navigates a real browser session to the target page and captures the XHR/fetch response that the page itself loaded. Used when a site's API is undocumented or requires session state too complex to replicate manually.

## llms.txt

A standardized agent-readable index file at the site root (`/llms.txt` and `/llms-full.txt`). Lists key documentation pages with Markdown companion URLs so AI assistants can fetch and cite docs without rendering HTML.

## MCP (Model Context Protocol)

The Anthropic-led protocol for letting AI assistants invoke tools through a stateful server. Uni-CLI ships an optional MCP gateway (`unicli mcp serve`) that wraps the catalog for runtimes that only speak MCP.

## Pipeline

The ordered list of steps an adapter runs to produce its result. Drawn from the <!-- STATS:pipeline_step_count -->101<!-- /STATS -->-step registry covering API fetch, transform, browser, desktop, media, control flow, and assertion. Steps share a context object — each step reads `ctx.data` and writes back.

## Pipeline step

One unit of work in an adapter's pipeline. Examples: `fetch`, `select`, `map`, `filter`, `navigate`, `click`, `intercept`, `if`, `each`, `assert`. Every step is deterministic — same inputs produce same outputs — so adapters compose into reliable execution graphs.

## Public strategy

The cheapest auth strategy. Direct fetch with no credentials. Used by sites with public APIs (RSS feeds, search endpoints, public stats). Always tried first by the strategy cascade.

## Repair

The fourth phase of the four-part contract. After an error envelope names a failing adapter and step, the agent edits the YAML and runs `unicli repair <site> <command>` to verify. Patches persist in `~/.unicli/adapters/`.

## Self-repair

The capability that lets agents fix their own integrations when sites drift. Composed of: structured error envelopes, agent-readable YAML adapters, a repair verification command, and a persistent overlay directory. The single design choice that makes catalog-as-YAML economically viable.

## Service adapter

An adapter that talks to a long-lived service (Ollama, OBS Studio, ComfyUI) over WebSocket or HTTP with optional API-key auth. Distinct from `web-api` because the connection persists across pipeline steps.

## Site

The integration target for an adapter. Typically a website (`reddit`, `twitter`, `bilibili`), but can also be a desktop app (`obsidian`), an external CLI (`gh`), or a local service (`ollama`).

## Snapshot

A DOM accessibility tree generated by the `snapshot` pipeline step in browser adapters. Produces interactive ref numbers that subsequent `click`, `type`, and `extract` steps reference. Used by adapters that need stable element targeting across page state changes.

## Strategy

The auth path an adapter declares. Five strategies in cascade order: `public`, `cookie`, `header`, `intercept`, `ui`. Auto-probed on first run; cached afterward.

## Strategy cascade

The auto-probe sequence Uni-CLI runs on first call to a site. Tries each strategy from cheapest to most expensive (`public` to `ui`) until one returns parseable data. The selected strategy is then cached so subsequent calls skip the probe.

## Tap

A pipeline step that bridges Vue stores (Pinia, Vuex) to network capture. Drives the page's own state actions, then captures the resulting XHR/fetch responses. Used for sites with deep client-side state (Twitter, Bilibili, Notion).

## UI strategy

The most expensive auth strategy. Drives a real browser session interactively — clicks, types, snapshots, waits. Used when a site requires multi-step user interaction that cannot be replicated by header injection or XHR replay.

## v2 envelope version

The current AgentEnvelope schema. v1 was a flat `{ ok, data, error }` shape; v2 added structured `error` fields, `meta`, `version`, and `exit_code` for shell-friendly routing. All adapters as of v0.213 emit v2.

## Web-api adapter

An adapter that hits HTTP APIs directly, with no browser involvement. The most common adapter type. Uses `fetch`, `fetch_text`, `parse_rss`, and `html_to_md` for retrieval; `select`, `map`, `filter` for shaping.

## YAML adapter

The preferred adapter format. A 20-30 line file declaring site, name, type, strategy, args, pipeline, and columns. Agent-readable, agent-editable, and free of Turing-complete logic so agents can patch it deterministically. Lives at `~/.unicli/adapters/<site>/<name>.yaml`.
