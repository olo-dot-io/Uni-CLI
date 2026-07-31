# Uni-CLI Roadmap

> Current: v1.0.0 — Artemis · Glover. Static adapter catalog: <!-- STATS:site_count -->326<!-- /STATS --> sites, <!-- STATS:command_count -->1829<!-- /STATS --> registered commands. Runtime also adds fixed core and host-discovered commands. <!-- STATS:pipeline_step_count -->113<!-- /STATS --> built-in actions (<!-- STATS:pipeline_registered_step_count -->58<!-- /STATS --> registered + <!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --> transport-native).

This file tracks engineering direction for the open Agent-Computer Interface
runtime for real software. Historical release notes live in `CHANGELOG.md`;
they do not belong in the roadmap.

## Shipped

| Area                     | Status                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Operation catalog        | Web, browser, desktop, macOS, bridge, local-tool, and protocol operations are discoverable through `list`, `search`, and `do`. |
| v2 output envelope       | Normal command surfaces return structured success and error envelopes.                                                         |
| Operation policy         | `open`, `confirm`, and `locked` profiles expose effect/risk/capability/resource scope, plus private remembered approvals.      |
| Run recording            | `--record` and `UNICLI_RECORD_RUN=1` write append-only run traces that agents can list, show, probe, replay, and compare.      |
| Browser evidence         | Browser operator actions can emit pre/post evidence, movement dimensions, stale-ref details, and watchdog results.             |
| Local computer control   | `compute` exposes app discovery, snapshots, refs, clicks, typing, keys, scrolling, app launch, screenshots, and assertions.    |
| Runtime exposure         | Native CLI, JSON stream, MCP, ACP, HTTP API, OpenAI-compatible, and bridge routes are modeled explicitly.                      |
| Self-repair and delivery | Errors carry adapter path, step, retryability, suggestion, alternatives; delivery commands assess objectives and trajectories. |
| Docs site                | VitePress landing page, guide/reference split, local search, and GitHub Pages deployment workflow are available.               |

## Next Priorities

1. **Agent-Computer Interface root model**
   - Keep public docs, architecture tree, command descriptions, and agent
     surfaces aligned around discover, select, govern, act, observe, and repair
     across real software.
   - Treat browser automation, computer-use sandboxes, MCP, WebMCP, local
     execution, and per-app harnesses as substrates below Uni-CLI, not as
     competing product identities.
   - Make `architecture tree` and `architecture audit` the executable check that
     catches regressions back into catalog/lifecycle-first framing.
   - Use `capability_matrix` and `workflow_readiness` from `architecture audit`
     to separate cataloged coverage from behavior that still needs live
     evidence.

2. **Operation-contract parity**
   - Project adapter commands and core Commander commands into the same
     operation-contract shape.
   - Keep argument schemas identical across `search`, `describe`, `--dry-run`,
     direct CLI, MCP, ACP, generated agent configs, and docs.
   - Add regression tests when a generated command family gets new arguments or
     a core command becomes externally callable.

3. **Control-kernel hardening**
   - Keep run traces append-only, local, and private by default.
   - Let agents probe replayability before repeating a command, then compare the replay trace against the original.
   - Extend evidence coverage across transport classes without making opaque
     browser screenshots the only proof.
   - For mutating operations, distinguish dispatch, settlement, observed
     delta, and objective outcome instead of treating a successful call as
     completed work.
   - Keep result envelopes, permission evaluations, and browser action evidence
     queryable enough for reviews and repair tasks.

4. **Operation policy coverage**
   - Keep adapters open by default.
   - Expand effect/risk/capability-scope inference where commands still lack
     enough metadata.
   - Use `--yes --remember-approval` when a team wants repeat approval for the
     same command capability scope without storing raw args.

5. **Substrate bus**
   - Make HTTP, CDP, accessibility, subprocess, service, and Visual dispatch share
     one invocation kernel and one evidence model.
   - Close adapter/core projection gaps so ACP/MCP/HTTP wrappers can converge on
     operation contracts rather than separate behavior definitions.
   - Surface unavailable transports as structured errors with install/setup
     suggestions.
   - Ingest ARD and MCP Registry metadata as discovery inputs, and WebMCP as a
     page-native substrate, only when their versioned contracts pass local
     conformance and executability checks.

6. **Desktop and Visual stack**
   - Build repeatable control paths for WeChat, WeCom, DingTalk, Lark, Mail,
     Notes, Word, PowerPoint, Excel, and common Electron apps.
   - Prefer app APIs, CDP, and accessibility before Visual.
   - For partial accessibility shells, add screenshot planning, background
     action primitives, and post-action verification before marking commands
     live.

7. **Delivery loop alignment**
   - Support parallel/background agent workflows with isolated worktrees, compact
     command discovery, and reviewable evidence.
   - Keep Uni-CLI command execution independent from any single agent loop or
     editor protocol.
   - Feed adapter failures back into repair tasks that can be run by coding
     agents.

8. **Continuous trend intake**
   - Periodically review capability discovery, agent protocols, computer-use,
     hybrid-interface benchmarks, and desktop automation through a private
     research process.
   - Convert durable insights into architecture or roadmap updates, not prompt
     lore.
   - Keep exhaustive research logs internal, while public architecture claims
     cite their first-party specifications or primary research at the point of
     use.
   - Keep code decisions grounded in local tests, diffs, and runtime evidence.

9. **Adapter authoring loop**
   - Keep browser `analyze`, `init`, `verify`, fixtures, field maps, and site memory as first-class authoring artifacts.
   - Store reusable site notes under `~/.unicli/sites/SITE/`.
   - Make repair output directly reusable by coding agents without extra prose.

10. **Browser network detail**

- Preserve request/response detail, cache hits, filters, and timing in browser capture commands.
- Make captured network evidence usable as adapter fixtures.

11. **Backend honesty**
    - Keep ACP as compatibility.
    - Prefer native CLI, JSON stream, and MCP when a backend exposes them.
    - Do not mark Visual as live unless a configured backend performs real actions.

12. **Docs as product surface**
    - README stays install-first and capability-first.
    - Public docs should explain the Agent-Computer Interface loop, operation
      contracts, software boundaries, evidence, repair paths, and integrations.
    - Keep the public entry path short, current, and directly useful.

13. **Workflow evidence closure**
    - Start from hybrid workflows that cross retrieval, files, browser tabs,
      installed apps, productivity state, and local or protocol tools.
    - Promote a workflow from cataloged to claimed only after command execution,
      post-state evidence, and auth/policy posture have been recorded.
    - Do not add commands for coverage optics; new commands need a runner,
      fixture, live smoke, or platform doctor evidence.

## Non-Goals

- No winner-take-all backend policy.
- No hidden success when an adapter failed.
- No theory-first README and no catalog-first identity.
- No new protocol shim unless it reduces latency, preserves session semantics, or unlocks a real client.
- No positioning as only a browser library, MCP wrapper, computer-use sandbox,
  natural-language shell, scraper, per-site wrapper collection, agent model,
  orchestrator, or distributed hosting platform.

## Verify

For public positioning and docs changes:

```bash
npm run docs:build
npm run docs:check-public
```

For release readiness:

```bash
npm run build
npm run release:check
npm run verify
```
