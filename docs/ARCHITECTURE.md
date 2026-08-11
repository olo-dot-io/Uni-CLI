---
title: Architecture
description: The components that turn an agent intent into a validated Uni-CLI operation and structured result.
---

# Architecture

Uni-CLI is a local command runtime for operating real software. This page describes the runtime in v1.1.1. Its main abstraction is an operation with a name, arguments, target, effect, execution operator, and result contract.

## Runtime flow

```text
intent
  → compiled intent plan
  → feasible catalog candidates
  → ranked operations with evidence
  → operation contract
  → argument and permission checks
  → execution operator
  → AgentEnvelope
  → repair or next action
```

The same operation can be discovered from the CLI, MCP, ACP, generated agent assets, and the documentation catalog.

## Catalog

The catalog combines four sources.

1. packaged YAML and TypeScript adapters
2. fixed core commands
3. user adapters under `~/.unicli/adapters/`
4. plugins and host-discovered external CLIs

`unicli search` compiles the task and ranks the catalog. `unicli describe` returns the selected operation's contract. User adapters can replace packaged entries with the same site and command during local development.

## Intent compilation and ranking

Discovery compiles each request once before it reads posting lists. The plan keeps the remaining task text together with entity, cardinality, site, operation family, operator, browser-negation, and other hard requirements.

Exact site ids and maintained aliases resolve through hash indexes. Multi-word names resolve through bounded phrase matching. A precomputed symmetric-delete index proposes typo candidates, then bounded Damerau-Levenshtein distance accepts only one nearest provider. Ambiguous spellings add no site constraint.

The bilingual inverted index combines BM25 and TF-IDF. Entity, workflow, operation-family, and feasibility signals refine the lexical candidate set. Hard capability requirements remove incompatible commands before bounded top-k selection. Every result includes `ranking.lexical_score`, `ranking.semantic_score`, `ranking.prior`, and named `ranking.signals` so an agent can inspect the selection basis.

## Operation contract

An operation contract records the following fields.

- site, command, description, and argument schema
- target surface and compatible platforms
- execution operator and minimum capability
- operation family, effect, and idempotency
- authentication and interaction requirements
- adapter source and repair metadata

These fields are shared by discovery, dry-run, execution, permission checks, and protocol projections.

## Control kernel

The control kernel validates input and coordinates policy before an operator acquires its target. It handles the following work.

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

The Browser Runtime Broker owns providers, profile partitions, agent sessions, targets, and leases. Browser commands select one of these visibility modes.

- hidden managed browser
- background existing Chrome
- foreground existing Chrome
- configured remote provider

State reads produce refs tied to a snapshot and target. Later actions resolve those refs through the same session.

## Desktop and visual runtime

`compute` routes actions to available providers on macOS, Windows, Linux, Electron, or an attached visual driver. Snapshot responses describe the selected provider and return refs for follow-up actions. Health commands report the setup supported by the current host.

## Result envelope

Every normal command returns a v2 AgentEnvelope. The outer fields remain stable across interfaces.

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

## Harness evolution kernel

The evolution kernel turns selected run traces into a controlled adapter update. It owns five boundaries.

1. `runs distill` creates a private evidence packet without replay arguments or secret event fields.
2. `evolve adapter` copies the baseline and candidate into separate user-adapter overlays. A changed candidate must declare a hypothesis, expected fixes, and optional at-risk cases.
3. Proposal runs, validation runs, and held-out runs remain disjoint. Eval files may label cases with `train`, `validation`, or `held-out`.
4. Baseline and candidate cases execute through the public CLI in alternating order. Every attempt preserves its exact candidate, patch, and report. Rejected attempts remain available after a later candidate succeeds.
5. `evolve adapter --candidate ... --promote` installs the candidate only after strict validation improvement and a held-out result without regressions. The same transaction preserves an exact rollback artifact.

The upstream Agent proposes and edits the candidate. Uni-CLI owns execution evidence and the promotion decision. Promotion reuses the latest eligible attempt when its candidate hash is unchanged, so review does not trigger another evaluation. Attempt commits, promotion, and rollback are serialized across Agent processes. Version 1.2 limits editable evolution components to one YAML adapter per session. Mutating commands require an explicit evaluation opt-in.

## Protocol projections

The native CLI exposes the complete runtime. MCP offers compact, deferred, and expanded tool profiles. ACP and other generated surfaces project selected operations from the same catalog. `unicli mcp health` reports the exact MCP profile and tool counts on the installed version.

## Source map

| Area                       | Source                             |
| -------------------------- | ---------------------------------- |
| Catalog and registry       | `src/registry.ts`, `src/adapters/` |
| Intent compilation         | `src/discovery/intent-plan.ts`     |
| Catalog ranking            | `src/discovery/search.ts`          |
| Ranking semantics          | `src/discovery/intent-ranking.ts`  |
| Site identity resolution   | `src/discovery/site-resolver.ts`   |
| Capability feasibility     | `src/discovery/feasibility.ts`     |
| Engine and pipeline        | `src/engine/`                      |
| Harness evolution          | `src/engine/evolution/`            |
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
