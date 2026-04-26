# Uni-CLI Roadmap

> Current: v0.216.2 — Apollo · Aldrin. <!-- STATS:site_count -->235<!-- /STATS --> sites, <!-- STATS:command_count -->1448<!-- /STATS --> commands, <!-- STATS:pipeline_step_count -->59<!-- /STATS --> pipeline steps.

This file tracks current engineering direction. Historical release notes live in
`CHANGELOG.md`; they do not belong in the roadmap.

## Shipped

| Area                 | Status                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Adapter catalog      | Web, browser, desktop, macOS, bridge, and external CLI surfaces are discoverable through `unicli list` and `unicli search`. |
| v2 output envelope   | Normal command surfaces return structured success and error envelopes.                                                      |
| MCP server           | Stdio, Streamable HTTP, SSE, and optional OAuth 2.1 PKCE entry points are available.                                        |
| ACP gateway          | Supported as an editor compatibility path, not the primary runtime abstraction.                                             |
| Self-repair loop     | Errors carry adapter path, step, retryability, suggestion, and alternatives.                                                |
| Agent backend matrix | Native CLI, JSON stream, MCP, ACP, HTTP API, OpenAI-compatible, and bridge routes are modeled explicitly.                   |
| Docs site            | VitePress landing page, guide/reference split, local search, and GitHub Pages deployment workflow are available.            |

## Next Priorities

1. **Adapter authoring loop**
   - Keep browser `analyze`, `init`, `verify`, fixtures, field maps, and site memory as first-class authoring artifacts.
   - Store reusable site notes under `~/.unicli/sites/SITE/`.
   - Make repair output directly reusable by coding agents without extra prose.

2. **Browser network detail**
   - Preserve request/response detail, cache hits, filters, and timing in browser capture commands.
   - Make captured network evidence usable as adapter fixtures.

3. **Backend honesty**
   - Keep ACP as compatibility.
   - Prefer native CLI, JSON stream, and MCP when a backend exposes them.
   - Do not mark CUA as live unless a configured backend performs real actions.

4. **Docs as product surface**
   - README stays install-first and capability-first.
   - Public docs should explain commands, contracts, repair paths, and integration routes.
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
