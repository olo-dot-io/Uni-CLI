---
title: Plugin authoring
description: Package adapters, pipeline steps, and runtime extensions for Uni-CLI.
---

# Plugin authoring

A plugin groups adapters and optional JavaScript extensions outside the main repository. Installed plugins live under `~/.unicli/plugins/` and join the runtime catalog at startup.

## Create a plugin

```bash
unicli plugin create astronomy
cd unicli-plugin-astronomy
```

The scaffold contains:

```text
unicli-plugin-astronomy/
├── unicli-plugin.json
├── README.md
├── adapters/
└── steps/
```

## Manifest

```json
{
  "name": "astronomy",
  "version": "1.0.0",
  "unicli": ">=0.206.0",
  "description": "Astronomy operations for Uni-CLI",
  "adapters": "adapters/",
  "steps": "steps/",
  "main": "dist/index.js"
}
```

`adapters`, `steps`, and `main` are paths inside the plugin directory. Include the entries your package uses.

## Add adapters

Plugin YAML uses the same schema as packaged adapters:

```yaml
site: observatory
name: objects
description: Search the observatory object catalog
type: web-api
strategy: public
operation_effect: read
execution_operator: structured-api
operation_family: search

args:
  query:
    type: str
    required: true
    positional: true

pipeline:
  - fetch:
      url: https://example.org/api/objects
      params:
        q: ${{ args.query }}
  - select: data

capabilities: ["http.fetch"]
minimum_capability: http.fetch
trust: user
confidentiality: public
quarantine: false
schema_version: v2
```

See [Adapter format](/ADAPTER-FORMAT) for all fields.

## Add a pipeline step

Import the public step registry from `@zenalexa/unicli/engine/registry` and register the step from the plugin entry point.

```typescript
import { registerStep } from "@zenalexa/unicli/engine/registry";

registerStep("astronomy_normalize", (ctx, config) => {
  return { ...ctx, data: normalizeCatalog(ctx.data, config) };
});
```

List loaded custom steps:

```bash
unicli plugin steps
```

## Public package imports

Uni-CLI publishes versioned subpaths for registry, errors, types, output, engine, transports, browser helpers, protocol schemas, and downloads. Examples:

```typescript
import { cli } from "@zenalexa/unicli/registry";
import { err, ok } from "@zenalexa/unicli/errors";
import type { AdapterCommand } from "@zenalexa/unicli/types";
import { registerStep } from "@zenalexa/unicli/engine/registry";
import { getTransportBus } from "@zenalexa/unicli/transport";
```

Use package exports rather than `dist/` paths so the import tracks the supported public surface.

## Broker-owned browser invocation pattern

Browser-aware plugins share Uni-CLI's machine-level Browser Runtime Broker. The broker owns browser processes, ports, runtime reuse, login partitions, and target serialization. A plugin supplies the Agent identity and provider policy for each call.

```typescript
import {
  BrowserBridge,
  createBrowserInvocationContext,
  createBrowserInvocationScope,
  runBrowserInvocation,
} from "@zenalexa/unicli/browser/runtime";

const context = createBrowserInvocationContext({
  transport: "plugin",
  agentSessionId: hostThreadId,
  turnId: hostTurnId,
  profilePartitionId: "team-login",
});

const scope = createBrowserInvocationScope({
  context,
  provider: "managed",
  visibility: "hidden",
  profilePartitionId: "team-login",
});

const snapshot = await runBrowserInvocation(scope, async () => {
  const page = await new BrowserBridge().connect();
  await page.goto("https://example.com");
  return page.snapshot({ interactive: true });
});
```

Use `managed` with `hidden` for the managed provider, `chrome` with `background` or `foreground` for an existing Chrome session, and `remote` with `hidden` for a configured remote provider. `probeBrowserRuntimeBroker()` reads current broker state. `ensureBrowserRuntimeBroker()` starts the windowless control plane; the selected browser provider starts when the first page command needs it.

## Install and manage

```bash
unicli plugin install ./unicli-plugin-astronomy
unicli plugin install github:owner/repository
unicli plugin list
unicli plugin update astronomy
unicli plugin uninstall astronomy
```

After installation, verify the new catalog entries:

```bash
unicli search "search observatory objects"
unicli describe observatory objects
```

## Package checklist

- Set a semantic version and Uni-CLI compatibility range.
- Give every adapter a user-facing description and current schema-v2 metadata.
- Keep credentials in Uni-CLI auth storage or the host environment.
- Test custom steps and adapter behavior through the public imports.
- Document installation, commands, authentication, and one working example.
