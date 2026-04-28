<!-- Generated from docs/ROADMAP.md. Do not edit this copy directly. -->

# Roadmap

- Canonical: https://olo-dot-io.github.io/Uni-CLI/ROADMAP
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/ROADMAP.md
- Section: Explanation
- Parent: Explanation (/ARCHITECTURE)

> Current: v0.217.0 — Apollo · Lovell. <!-- STATS:site_count -->235<!-- /STATS --> sites, <!-- STATS:command_count -->1448<!-- /STATS --> commands, <!-- STATS:pipeline_step_count -->59<!-- /STATS --> pipeline steps.

This file tracks current engineering direction. Historical release notes live in
`CHANGELOG.md`; they do not belong in the roadmap.

## Shipped

| Area                 | Status                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Adapter catalog      | Web, browser, desktop, macOS, bridge, and external CLI surfaces are discoverable through `unicli list` and `unicli search`. |
| v2 output envelope   | Normal command surfaces return structured success and error envelopes.                                                      |
| Operation policy     | `open`, `confirm`, and `locked` profiles expose effect, risk, approval, and capability scope.                               |
| Run recording        | `--record` and `UNICLI_RECORD_RUN=1` write append-only run traces that agents can list, show, probe, and replay.            |
| Browser evidence     | Browser operator actions can emit pre/post evidence, movement dimensions, stale-ref details, and watchdog results.          |
| MCP server           | Stdio, Streamable HTTP, SSE, and optional OAuth 2.1 PKCE entry points are available.                                        |
| ACP gateway          | Supported as an editor compatibility path, not the primary runtime abstraction.                                             |
| Self-repair loop     | Errors carry adapter path, step, retryability, suggestion, and alternatives.                                                |
| Agent backend matrix | Native CLI, JSON stream, MCP, ACP, HTTP API, OpenAI-compatible, and bridge routes are modeled explicitly.                   |
| Docs site            | VitePress landing page, guide/reference split, local search, and GitHub Pages deployment workflow are available.            |

## Next Priorities

1. **Run/event kernel hardening**
   - Keep run traces append-only, local, and private by default.
   - Let agents probe replayability before repeating a command.
   - Extend evidence coverage across transport classes without making opaque
     browser screenshots the only proof.
   - Keep result envelopes, permission evaluations, and browser action evidence
     queryable enough for reviews and repair tasks.

2. **Manifest/runtime parity**
   - Treat generated TypeScript registrations as first-class manifest inputs.
   - Keep argument schemas identical across `search`, `describe`, `--dry-run`,
     direct CLI, MCP, ACP, and generated agent configs.
   - Add regression tests when a generated command family gets new arguments.

3. **Operation policy coverage**
   - Keep adapters open by default.
   - Expand effect/risk/capability-scope inference where commands still lack
     enough metadata.
   - Keep `--yes` / `UNICLI_APPROVE=1` as the explicit approval path for
     stricter profiles.

4. **Transport bus**
   - Make HTTP, CDP, accessibility, subprocess, service, and CUA dispatch share
     one invocation kernel and one evidence model.
   - Keep ACP/MCP/HTTP as wrappers over the same catalog rather than separate
     behavior definitions.
   - Surface unavailable transports as structured errors with install/setup
     suggestions.

5. **Desktop and CUA stack**
   - Build repeatable control paths for WeChat, WeCom, DingTalk, Lark, Mail,
     Notes, Word, PowerPoint, Excel, and common Electron apps.
   - Prefer app APIs, CDP, and accessibility before CUA.
   - For partial accessibility shells, add screenshot planning, background
     action primitives, and post-action verification before marking commands
     live.

6. **Agent loop alignment**
   - Support parallel/background agent workflows with isolated worktrees, compact
     command discovery, and reviewable evidence.
   - Keep Uni-CLI command execution independent from any single agent loop or
     editor protocol.
   - Feed adapter failures back into repair tasks that can be run by coding
     agents.

7. **Continuous trend intake**
   - Periodically review agent-loop, computer-use, editor-agent, and desktop
     automation trends through a private research process.
   - Convert durable insights into architecture or roadmap updates, not prompt
     lore.
   - Keep source-specific attribution internal and keep public docs at the
     capability level.
   - Keep code decisions grounded in local tests, diffs, and runtime evidence.

8. **Industry positioning**
   - Stay below IDE/chat products as the command/control substrate.
   - Compete on breadth, latency, repairability, local execution, and structured
     evidence.
   - Avoid becoming a model wrapper, prompt memory product, or protocol-only
     bridge.

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
    - Do not mark CUA as live unless a configured backend performs real actions.

12. **Docs as product surface**
    - README stays install-first and capability-first.
    - Public docs should explain commands, contracts, repair paths, and integration
      routes.
    - Keep the public entry path short, current, and directly useful.

## Non-Goals

- No winner-take-all backend policy.
- No hidden success when an adapter failed.
- No theory-first README.
- No new protocol shim unless it reduces latency, preserves session semantics, or unlocks a real client.

## Verify

```bash
npm run build
npm run release:check
npm run verify
```
