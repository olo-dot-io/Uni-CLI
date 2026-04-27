<!-- Generated from docs/ARCHITECTURE.md. Do not edit this copy directly. -->

# Architecture

- Canonical: https://olo-dot-io.github.io/Uni-CLI/ARCHITECTURE
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/ARCHITECTURE.md
- Section: Explanation

> Uni-CLI is the CLI-native bridge between agents and software. The primary
> contract is a command invocation plus a structured `AgentEnvelope`; protocol
> servers are compatibility surfaces over the same catalog.

## Current Shape

Uni-CLI exposes one searchable command surface across:

- **Web APIs**: public, cookie, and header-authenticated HTTP adapters.
- **Browser automation**: Chrome/CDP, UI, intercept, snapshot, and operate flows.
- **Desktop/local tools**: subprocess-backed apps, macOS automation, media tools,
  design tools, Office adapters, and local developer utilities.
- **Services**: local or remote HTTP/WebSocket services.
- **Bridge CLIs**: passthrough adapters for mature command-line tools.
- **Agent backends**: routing and setup helpers for agent runtimes that can call
  shell commands or protocol servers.

The generated catalog is the source of truth: **235 sites**, **1448 commands**,
**1039 adapters**, **59 pipeline steps**, and **7396 tests** in v0.216.3.

## Execution Contract

Coding agents already have a shell. Uni-CLI uses that native substrate first and
keeps every other transport as an adapter over the same registry.

| Layer             | Contract                                                      |
| ----------------- | ------------------------------------------------------------- |
| Discovery         | `unicli search`, `unicli list`, `unicli describe`             |
| Execution         | `unicli <site> <command> [args]`                              |
| Output            | v2 `AgentEnvelope` in Markdown, JSON, YAML, CSV, or compact   |
| Repair            | Error envelope with adapter path, failing step, and next move |
| Composition       | Shell pipes, files, scripts, JSON streams, and protocol wraps |
| Compatibility     | MCP, ACP, HTTP API, and generated agent configuration         |
| Extension surface | YAML adapters first; TypeScript only where the pipeline ends  |

The architectural rule is simple: a protocol server may wrap Uni-CLI, but it
does not define Uni-CLI. The stable primitive is still a command that an agent
can search, execute, inspect, and repair.

## Capability Model

Adapters declare the smallest capability they need. Dispatchers can then route a
command without guessing.

| Capability family | Typical use                                                   |
| ----------------- | ------------------------------------------------------------- |
| `http.fetch`      | Public APIs, authenticated APIs, feeds, search endpoints      |
| `cdp-browser`     | Login-gated pages, dynamic sites, DOM extraction, intercepts  |
| `subprocess`      | Local CLIs, media tools, desktop applications, file workflows |
| `desktop-*`       | Native desktop automation surfaces                            |
| `cua`             | Last-mile UI control when no narrower interface exists        |
| `bridge`          | Reuse of existing installed tools                             |

This lets Uni-CLI be broad without turning every operation into a full browser
or remote protocol session. The fast path stays narrow; broader paths exist when
the task really needs them.

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

The important part is not model cleverness. The important part is that the
search space is constrained to one adapter file, one failing step, one semantic
exit code, and one reproducible verification command.

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
bench shows representative `--limit 5` adapter responses at **357-415
tokens**, with total invocation-plus-response budgets at **364-423 tokens**.
The full catalog command is intentionally much larger because it emits all
235 sites and 1448 commands; agents should search and describe before asking
for the full registry.

## Direction

The long-term path is:

1. Operate a new surface once with the narrowest available transport.
2. Record the reliable API, DOM, subprocess, or desktop path.
3. Compile it into a small adapter.
4. Run the adapter directly on future calls.
5. Let failure envelopes drive repair when upstream software drifts.

That is the practical route to making CLI-native execution the default layer for
agent work: keep compatibility surfaces, but make the fastest, smallest, most
repairable interface the first-class path.
