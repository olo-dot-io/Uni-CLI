<!-- Generated from docs/ARCHITECTURE.md. Do not edit this copy directly. -->

# Architecture

- Canonical: https://olo-dot-io.github.io/Uni-CLI/ARCHITECTURE
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/ARCHITECTURE.md
- Section: Project

Uni-CLI is a local command runtime for operating real software. This page describes the runtime in v1.0.2. Its main abstraction is an operation: a named action with arguments, target, effect, execution operator, and result contract.

## Runtime flow

```text
intent
  → local catalog search
  → operation contract
  → argument and permission checks
  → execution operator
  → AgentEnvelope
  → repair or next action
```

The same operation can be discovered from the CLI, MCP, ACP, generated agent assets, and the documentation catalog.

## Catalog

The catalog combines four sources:

1. packaged YAML and TypeScript adapters
2. fixed core commands
3. user adapters under `~/.unicli/adapters/`
4. plugins and host-discovered external CLIs

`unicli search` ranks the catalog by intent. `unicli describe` returns the selected operation's contract. User adapters can replace packaged entries with the same site and command during local development.

## Operation contract

An operation contract records:

- site, command, description, and argument schema
- target surface and compatible platforms
- execution operator and minimum capability
- operation family, effect, and idempotency
- authentication and interaction requirements
- adapter source and repair metadata

These fields are shared by discovery, dry-run, execution, permission checks, and protocol projections.

## Control kernel

The control kernel validates input and coordinates policy before an operator acquires its target. It handles:

- argument schemas and input channels
- permission profiles and approvals
- browser session and target ownership
- run recording and effect metadata
- error mapping and process status

The kernel returns one execution plan to the selected operator.

## Execution operators

| Operator                | Typical boundary                           |
| ----------------------- | ------------------------------------------ |
| `structured-api`        | HTTP API or structured page endpoint       |
| `browser-protocol`      | CDP or browser network protocol            |
| `native-cli`            | Installed external command                 |
| `browser-semantic`      | DOM and accessibility actions in a browser |
| `desktop-accessibility` | OS accessibility tree and native controls  |
| `visual-observation`    | Screenshot or pixel observation            |
| `visual-coordinate`     | Coordinate-based desktop action            |
| `local-runtime`         | Files, local functions, and core services  |

Adapter type, strategy, and operator describe different parts of the call. A browser adapter can expose a protocol operation; a web namespace can wrap a native CLI.

## Adapter engine

YAML adapters describe a pipeline of registered actions such as fetch, transform, browser interaction, file download, and control flow. Transport-native actions add platform capabilities for visual and accessibility providers.

TypeScript adapters use the same metadata and envelope contract for SDKs, streaming services, and custom state machines.

## Browser runtime

The Browser Runtime Broker owns providers, profile partitions, agent sessions, targets, and leases. Browser commands select a visibility mode:

- hidden managed browser
- background existing Chrome
- foreground existing Chrome
- configured remote provider

State reads produce refs tied to a snapshot and target. Later actions resolve those refs through the same session.

## Desktop and visual runtime

`compute` routes actions to available providers on macOS, Windows, Linux, Electron, or an attached visual driver. Snapshot responses describe the selected provider and return refs for follow-up actions. Health commands report the setup supported by the current host.

## Result envelope

Every normal command returns a v2 AgentEnvelope. The outer fields remain stable across interfaces:

```json
{
  "ok": true,
  "schema_version": "2",
  "command": "site.command",
  "meta": {},
  "data": {},
  "error": null
}
```

Failed calls place their stable code, message, suggestion, and available repair data under `error`. The process exit code mirrors the broad failure class.

## Repair

Adapter failures can expose `adapter_path` and `step`. The agent updates that owned source and runs `unicli repair`, which invokes the original target as the verifier. User adapters provide a local path for repairs that are still being tested.

## Protocol projections

The native CLI exposes the complete runtime. MCP offers compact, deferred, and expanded tool profiles. ACP and other generated surfaces project selected operations from the same catalog. `unicli mcp health` reports the exact MCP profile and tool counts on the installed version.

## Source map

| Area                       | Source                             |
| -------------------------- | ---------------------------------- |
| Catalog and registry       | `src/registry.ts`, `src/adapters/` |
| Engine and pipeline        | `src/engine/`                      |
| Command surface            | `src/commands/`                    |
| Browser runtime            | `src/browser/`                     |
| Desktop and visual control | `src/compute/`, `src/transport/`   |
| Shared contracts           | `src/types.ts`, `src/core/`        |
| Protocol servers           | `src/mcp/`, `src/commands/acp.ts`  |

## Related reference

- [How Uni-CLI works](/how-it-works)
- [Adapter format](/ADAPTER-FORMAT)
- [Pipeline steps](/reference/pipeline)
- [Exit codes](/reference/exit-codes)
