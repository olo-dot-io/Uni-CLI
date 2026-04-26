# Uni-CLI Architecture

> Uni-CLI is the CLI-native bridge between agents and software. MCP is a
> compatibility transport; the command line is the primary execution contract.

## Current Shape

Uni-CLI exposes one searchable command surface across:

- **Web APIs**: public, cookie, and header-authenticated HTTP adapters.
- **Browser automation**: Chrome/CDP, UI, intercept, snapshot, and operate flows.
- **Desktop/local tools**: subprocess-backed apps such as ffmpeg, Blender,
  ImageMagick, LibreOffice, and Office adapters.
- **Services**: local or remote HTTP/WebSocket services such as Ollama, ComfyUI,
  and OBS.
- **Bridge CLIs**: passthrough adapters for existing tools such as `gh`, `jq`,
  `docker`, `yt-dlp`, and cloud CLIs.

The generated catalog is the source of truth: **223 sites**, **1304 commands**,
**987 adapters**, **59 pipeline steps**, and **7311 tests** in v0.215.1.

## Why CLI-First

Coding agents already have a shell. Uni-CLI uses that native substrate instead
of requiring every integration to be registered as a live protocol server.

| Dimension      | Uni-CLI                                           | MCP-only tool servers                   |
| -------------- | ------------------------------------------------- | --------------------------------------- |
| Discovery      | `unicli search`, `unicli list`, `unicli describe` | Server-specific tool registration       |
| Execution      | One process call, structured stdout/stderr        | Persistent client/server session        |
| Composition    | Shell pipes, files, `jq`, `xargs`, scripts        | Agent-orchestrated tool chaining        |
| Failure repair | Error envelope points to adapter YAML             | Server implementation is usually opaque |
| Context cost   | 357-415 response tokens for benchmarked calls     | Often pays schema/snapshot overhead     |
| Compatibility  | CLI, MCP, ACP, JSON stream                        | MCP clients only                        |

This is not anti-MCP as a transport. Uni-CLI ships `unicli mcp serve` because
some clients need it. The architectural choice is that MCP wraps Uni-CLI; it
does not define Uni-CLI.

## Differentiation

The current ecosystem separates into recognizable categories:

| Category             | Examples                               | Strength                              | Limit                                  |
| -------------------- | -------------------------------------- | ------------------------------------- | -------------------------------------- |
| Browser agents       | browser-use, Stagehand, Playwright MCP | Flexible UI navigation                | Higher token and latency cost per step |
| Data extraction APIs | Firecrawl, scraping MCP servers        | Fast read/extract/crawl               | Not a general write/control surface    |
| Tool gateways        | Composio, MCP server registries        | Auth and SaaS breadth                 | Central gateway and schema overhead    |
| CLI-native execution | Uni-CLI                                | Fast, composable, repairable hot path | Requires shell/filesystem access       |

Uni-CLI's thesis is compile-then-run: use browser/CUA when discovery is needed,
then encode the stable path as a typed adapter. The next call is a deterministic
command, not another exploratory agent trajectory.

## Self-Repair Loop

Every adapter call returns a v2 `AgentEnvelope`. Failure envelopes contain the
fields an agent needs to act without guessing:

```json
{
  "ok": false,
  "schema_version": "2",
  "command": "twitter.timeline",
  "meta": { "duration_ms": 91 },
  "data": null,
  "error": {
    "code": "auth_required",
    "message": "401 Unauthorized",
    "adapter_path": "src/adapters/twitter/timeline.yaml",
    "step": 1,
    "suggestion": "Run: unicli auth setup twitter",
    "retryable": false,
    "alternatives": ["twitter.search"]
  }
}
```

The repair loop is deliberately small:

1. Run `unicli <site> <command> -f json`.
2. On failure, read `error.adapter_path`.
3. Patch the YAML or TypeScript adapter.
4. Verify with `unicli repair <site> <command>` or `unicli test <site>`.
5. Persist local overrides under `~/.unicli/adapters/` when the fix is local.

The important part is not that the model is smart. The important part is that
the search space is constrained to one adapter file, one failing step, one
semantic exit code, and one reproducible verification command.

## Runtime Layers

```text
Agent intent
  |
  v
unicli search / describe / schema
  |
  v
Adapter registry and manifest
  |
  v
Pipeline engine
  |
  +-- http.fetch
  +-- cdp-browser.*
  +-- subprocess.exec
  +-- desktop-ax / desktop-uia / desktop-atspi
  +-- cua.*
  |
  v
AgentEnvelope v2
```

## Adapter Types

| Type      | Runtime                          | Typical use                                |
| --------- | -------------------------------- | ------------------------------------------ |
| `web-api` | HTTP fetch and transforms        | Public or authenticated APIs               |
| `browser` | Chrome/CDP operation             | Login-gated, dynamic, or intercepted sites |
| `desktop` | Local subprocess / OS automation | Apps and local binaries                    |
| `service` | HTTP/WebSocket                   | Local services and daemons                 |
| `bridge`  | Existing CLI passthrough         | Tools with mature CLIs                     |

YAML is preferred because agents can read and patch it cheaply. TypeScript is
kept as an escape hatch for cases where finite pipeline primitives are not
enough.

## Measured Bar

`docs/BENCHMARK.md` is the public measurement contract. The current fixture
bench shows adapter responses at **357-415 tokens** for representative
`--limit 5` calls and a **133.8x median reduction** against a 55K-token GitHub
MCP catalog baseline. `unicli list` is intentionally large because it is the
whole catalog; agents should use `unicli search` and `unicli describe` before
asking for the full registry.

## Direction

The long-term path is:

1. Operate a new surface once with browser/CUA or an external tool.
2. Record the reliable API, DOM, or subprocess path.
3. Compile it into a small adapter.
4. Run the adapter directly on future calls.
5. Let failure envelopes drive repair when upstream software drifts.

That is the practical route to replacing protocol-heavy agent tooling in
coding-agent workflows: keep compatibility surfaces, but make the fastest,
smallest, most repairable interface the default.
