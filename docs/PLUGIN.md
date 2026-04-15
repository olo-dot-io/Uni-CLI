# Plugin Author Guide

> First published in **v0.213 Gagarin**. This document is the stability
> contract for `@zenalexa/unicli` subpath imports and describes the
> supported ways to extend Uni-CLI from a third-party package.

Plugins let you register custom pipeline steps, transports, and adapters
without forking the project. The surface is a small, versioned set of
subpath imports — pick the ones you need, import them, and avoid the
internals.

---

## 1. Stability contract

Uni-CLI exposes 24 subpaths from `package.json` `exports`. Each subpath is
labelled **Stable**, **Beta**, or **Experimental**. The label governs how
quickly we may break the API.

| Subpath                                  | Source                                  | Status       |
| ---------------------------------------- | --------------------------------------- | ------------ |
| `@zenalexa/unicli`                       | `src/main.ts`                           | Stable       |
| `@zenalexa/unicli/registry`              | `src/registry.ts`                       | Stable       |
| `@zenalexa/unicli/errors`                | `src/errors.ts`                         | Stable       |
| `@zenalexa/unicli/types`                 | `src/types.ts`                          | Stable       |
| `@zenalexa/unicli/output`                | `src/output/formatter.ts`               | Stable       |
| `@zenalexa/unicli/engine`                | `src/engine/executor.ts`                | Stable       |
| `@zenalexa/unicli/engine/registry`       | `src/engine/step-registry.ts`           | Stable       |
| `@zenalexa/unicli/transport`             | `src/transport/bus.ts`                  | Stable       |
| `@zenalexa/unicli/transport/http`        | `src/transport/adapters/http.ts`        | Stable       |
| `@zenalexa/unicli/protocol/mcp`          | `src/mcp/schema.ts`                     | Stable       |
| `@zenalexa/unicli/protocol/acp`          | `src/protocol/acp.ts`                   | Stable       |
| `@zenalexa/unicli/pipeline`              | alias of `engine` (OpenCLI parity)      | Stable       |
| `@zenalexa/unicli/download`              | `src/engine/download.ts`                | Stable       |
| `@zenalexa/unicli/engine/steps`          | `src/engine/steps/index.ts`             | Beta         |
| `@zenalexa/unicli/transport/cua`         | `src/transport/adapters/cua.ts`         | Beta         |
| `@zenalexa/unicli/transport/desktop-ax`  | `src/transport/adapters/desktop-ax.ts`  | Beta         |
| `@zenalexa/unicli/transport/subprocess`  | `src/transport/adapters/subprocess.ts`  | Beta         |
| `@zenalexa/unicli/transport/cdp-browser` | `src/transport/adapters/cdp-browser.ts` | Beta         |
| `@zenalexa/unicli/protocol/skill`        | `src/protocol/skill.ts`                 | Beta         |
| `@zenalexa/unicli/registry-v2`           | `src/core/registry.ts`                  | Experimental |
| `@zenalexa/unicli/browser/cdp`           | `src/browser/cdp-client.ts`             | Experimental |
| `@zenalexa/unicli/browser/page`          | `src/browser/page.ts`                   | Experimental |
| `@zenalexa/unicli/browser/daemon`        | `src/browser/daemon-client.ts`          | Experimental |
| `@zenalexa/unicli/browser/utils`         | `src/browser/dom-helpers.ts`            | Experimental |

**Stable** — Breaking changes require a major bump and a deprecation
warning for at least one full release prior.

**Beta** — Shape of the module is likely right, but concrete types, field
names, and handler signatures can shift in any minor release. Safe to
depend on; pin to an exact minor to avoid surprise upgrades.

**Experimental** — Internals we export so the plugin ecosystem can
prototype. May break in any release (including patch). Use at your own
risk and prefer stable alternatives where they exist.

---

## 2. Versioning policy

Uni-CLI follows Semantic Versioning (`MAJOR.MINOR.PATCH`). Applied to
exports:

- **Stable subpath, breaking change** → requires a `MAJOR` bump, a
  deprecation warning emitted at least one `MINOR` prior, and a changelog
  entry under "Breaking changes".
- **Beta subpath, breaking change** → allowed in any `MINOR`. A changelog
  entry is still required.
- **Experimental subpath, breaking change** → allowed in any release,
  including `PATCH`. No changelog entry required (but encouraged).
- **Adding a new subpath** → `MINOR` bump, never `PATCH`.
- **Removing a subpath** → only during a `MAJOR` bump with a deprecation
  window.

The CI gate `scripts/check-exports-count.ts` enforces a floor of 20
subpaths so we never silently amputate the plugin surface.

---

## 3. Writing a plugin

The simplest plugin registers a custom pipeline step and ships as an ESM
side-effect import. Consumers add one import to their YAML runner host
(or to a wrapper script) and the step becomes callable.

```ts
// my-plugin/src/index.ts
import { registerStep } from "@zenalexa/unicli/engine/registry";

registerStep("reverse", async (ctx, _config) => {
  return {
    ...ctx,
    data: Array.isArray(ctx.data) ? [...ctx.data].reverse() : ctx.data,
  };
});
```

Then in any YAML adapter:

```yaml
site: example
name: demo
type: web-api
strategy: public
pipeline:
  - fetch: { url: "https://example.com/api/items" }
  - select: { path: "data" }
  - reverse: {}
columns: [title]
```

See `examples/plugin-example/` in the repository for a complete working
template including `package.json`, `tsconfig.json`, and a README.

---

## 4. Loading plugins

Uni-CLI does not auto-discover third-party plugins. You load them via
Node's preload flag:

```bash
node --import @zenalexa/my-plugin $(which unicli) example demo
```

Or for a script-only host, pure ESM side-effect import works:

```ts
import "@zenalexa/my-plugin";
import { runPipeline } from "@zenalexa/unicli/engine";

await runPipeline([{ fetch: { url: "https://example.com" } }, { reverse: {} }]);
```

A first-class `--plugin` CLI flag is tracked for a future minor release.
Until then, preload-import is the supported pattern and matches how
community OpenCLI plugins bootstrap today.

---

## 5. Allowed operations per subpath

One-line summary of what a plugin can legitimately do with each subpath.

- `registry` — register v1 adapters via `cli({...})`.
- `registry-v2` — register v2 adapters via the schema-typed API (experimental).
- `errors` — catch `PipelineError`, `NoTransportForStepError`; construct envelope errors.
- `types` — reuse `PipelineStep`, `AdapterType`, `Strategy`, `ExitCode` etc. in plugin types.
- `output` — format plugin-produced rows via the shared `formatter` (table/json/yaml/csv/md).
- `engine` — call `runPipeline` from external hosts; catch `PipelineError`.
- `engine/registry` — `registerStep`, `getStep`, `listSteps`; this is the primary extension point.
- `engine/steps` — reference built-in step handlers (beta — handler signatures may move).
- `transport` — register custom `TransportAdapter` instances on the shared bus.
- `transport/http` — compose on top of the HTTP transport (retries, cookies, CSRF).
- `transport/cdp-browser` — access CDP-backed browser transport for custom steps.
- `transport/subprocess` — spawn helper binaries under the subprocess transport.
- `transport/desktop-ax` — drive native UI via the macOS AX / Windows UIA bridge.
- `transport/cua` — access the Computer-Use Agent transport surface.
- `browser/cdp` — low-level raw CDP client (experimental — prefer `browser/page`).
- `browser/page` — high-level `BrowserPage` API (navigate, click, evaluate, snapshot).
- `browser/daemon` — talk to the standalone daemon HTTP+WS server.
- `browser/utils` — shared DOM helpers for snapshot normalisation and ref resolution.
- `protocol/mcp` — MCP schema builders (`buildInputSchema`, `buildToolName`, etc.).
- `protocol/acp` — embed an ACP server that reuses the Uni-CLI pipeline runner.
- `protocol/skill` — load and validate SKILL.md packs.
- `download` — enqueue downloads through the shared `download` step runtime.
- `pipeline` — alias of `engine`; prefer whichever name reads better in your codebase.

---

## 6. Forbidden

These are not supported. A plugin that relies on any of them will break
without notice:

- **Deep imports into non-exported paths.** `@zenalexa/unicli/dist/engine/runtime.js`
  or any path not listed in `package.json` `exports` is private.
- **Mutating exported values that are not prefixed with `_`.** Treat
  `getBus()`, `listSteps()`, etc. as read-only. If you need mutation,
  register your own adapter via the public API.
- **Monkeypatching exports.** Rewriting `PipelineError.prototype` or
  overwriting an existing step via a direct `Map.set` on an internal
  registry is unsupported — call `registerStep` instead, which performs
  the right validation.
- **Depending on internal types that leak through public modules.** If a
  type is only visible because TypeScript structurally surfaces it, treat
  it as private. Import only from named, documented type exports.
- **Side effects beyond registration.** A plugin must not open sockets,
  spawn processes, or write files at import time. Register handlers; let
  the host CLI invoke them.

If you need something in the Forbidden list, open an issue describing the
use case. Most requests resolve with a new stable export, not a private
hook.
