---
title: Create an adapter
description: Add a site or tool to Uni-CLI with a YAML adapter and test it locally.
---

# Create an adapter

An adapter turns a useful action into a searchable Uni-CLI operation. YAML is the default format: it keeps metadata, arguments, and pipeline steps together in one file.

## Create the file

```bash
unicli init example search
```

The generated file lives under `src/adapters/example/search.yaml`. Use `-o` to choose another directory or `-t` to select `web-api`, `browser`, `desktop`, `bridge`, or `service`.

## Describe the operation

A small public HTTP adapter can look like this:

```yaml
site: hackernews
name: top
description: Hacker News top stories
type: web-api
strategy: public
target_surface: web
execution_operator: structured-api
operation_family: list
operation_effect: read
args:
  - name: limit
    type: int
    default: 20
pipeline:
  - fetch:
      url: https://news.ycombinator.com/
  - select:
      selector: .athing
      fields:
        title: .titleline > a
        url: .titleline > a@href
  - limit: ${{ args.limit }}
capabilities: ["http.fetch"]
minimum_capability: http.fetch
trust: public
confidentiality: public
quarantine: false
schema_version: v2
```

Keep the description close to the user's intent. The contract fields help search, permission policy, and agent clients select the operation before execution.

## Choose a type

| Type      | Use it for                                                |
| --------- | --------------------------------------------------------- |
| `web-api` | HTTP APIs, feeds, and structured web responses            |
| `browser` | Signed-in pages, DOM actions, and browser network capture |
| `desktop` | Installed applications and local executables              |
| `bridge`  | Existing CLIs such as `gh` or `docker`                    |
| `service` | Local or remote HTTP and WebSocket services               |

The type identifies the integration family. `execution_operator` records the interface that performs the concrete command.

## Define arguments

```yaml
args:
  - name: query
    type: str
    required: true
    positional: true
    description: Search terms
  - name: limit
    type: int
    default: 10
    minimum: 1
    maximum: 100
```

Arguments support JSON Schema constraints and Uni-CLI kinds for paths, IDs, selectors, and URLs. See [Adapter format](/ADAPTER-FORMAT) for every field.

## Build the pipeline

Pipeline steps receive the current context and can reference arguments with template expressions.

```yaml
pipeline:
  - fetch:
      url: https://example.com/search?q=${{ args.query }}
  - select:
      selector: article
      fields:
        title: h2
        url: a@href
  - limit: ${{ args.limit }}
```

See [Pipeline steps](/reference/pipeline) for the registered actions and transport-native actions.

## Run it locally

```bash
unicli dev src/adapters/example/search.yaml
unicli describe example search
unicli example search "test" --limit 3 -f json
unicli test example
```

When the behavior is durable, add the smallest adjacent test or fixture that exercises the owned path.

## Use TypeScript when the flow is custom

TypeScript adapters are useful for SDKs, streaming protocols, stateful services, and control flow that maps poorly to a YAML pipeline. They register the same operation metadata and return the same envelope shape.

The [Adapter format](/ADAPTER-FORMAT#typescript-escape-hatch) page contains the TypeScript contract.
