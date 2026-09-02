<!-- Generated from docs/ADAPTER-FORMAT.md. Do not edit this copy directly. -->

# Adapter Format

- Canonical: https://olo-dot-io.github.io/Uni-CLI/ADAPTER-FORMAT
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/ADAPTER-FORMAT.md
- Section: Build
- Parent: Build (/guide/adapters)

A YAML adapter registers one command. The file combines discovery metadata, arguments, execution steps, output columns, and schema-v2 metadata.

## Minimal adapter

```yaml
site: hackernews
name: top
description: Hacker News top stories
domain: news.ycombinator.com
type: web-api
strategy: public
operation_effect: read

args:
  limit:
    type: int
    default: 20
    description: Number of stories

pipeline:
  - fetch:
      url: https://hacker-news.firebaseio.com/v0/topstories.json
  - limit: ${{ args.limit }}

columns: [id]

capabilities: ["http.fetch"]
minimum_capability: http.fetch
trust: public
confidentiality: public
quarantine: false
schema_version: v2
```

## Identity and connection

| Field               | Value                                                             |
| ------------------- | ----------------------------------------------------------------- |
| `site`              | Command namespace, such as `hackernews`                           |
| `name`              | Command name inside the site                                      |
| `description`       | One-line user intent used by search                               |
| `domain`            | Primary remote domain, when applicable                            |
| `type`              | `web-api`, `browser`, `desktop`, `bridge`, or `service`           |
| `strategy`          | `public`, `cookie`, `header`, `environment`, `intercept`, or `ui` |
| `browser`           | Marks commands that require a browser runtime                     |
| `browserSession`    | `auto`, `user`, or `cdp`                                          |
| `auth_cookies`      | Cookie names used by a site adapter                               |
| `binary` / `detect` | External CLI name and detection command for bridge adapters       |

## Operation metadata

These fields make search and policy decisions clearer.

| Field                | Values                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target_surface`     | `web`, `desktop`, `system`, `mobile`                                                                                                                                                           |
| `execution_operator` | `structured-api`, `browser-protocol`, `native-cli`, `browser-semantic`, `desktop-accessibility`, `visual-observation`, `visual-coordinate`, `local-runtime`                                    |
| `operation_family`   | `search`, `get`, `list`, `create`, `update`, `delete`, `invoke`, `capture`, `navigate`, `download`, `authenticate`, `unknown`                                                                  |
| `operation_effect`   | `read`, `download_file`, `send_message`, `publish_content`, `account_state`, `remote_transform`, `remote_resource`, `service_state`, `local_app`, `local_file`, `destructive`, `unknown_write` |
| `idempotency`        | `guaranteed`, `conditional`, `none`, `unknown`                                                                                                                                                 |
| `auth_requirement`   | `required`, `optional`, `none`                                                                                                                                                                 |

## Configuration availability

Commands backed by process credentials declare them separately from provider authentication. `strategy: environment` means the pipeline reads credentials from environment templates and never opens the browser cookie store.

```yaml
strategy: environment
auth_requirement: required
availability:
  environment: [SEARCH_API_KEY]
  discovery: configured
  setup_url: https://search.example.com/keys
```

Every variable in `availability.environment` is required. `discovery: configured` removes the command from list, search, completion, and expanded MCP surfaces until configuration is present. An explicit describe remains available and reports `missing_environment`. Direct invocation stops before network access when configuration is incomplete.

## Retrieval providers

Read-only discovery commands can join `unicli retrieval search` through portable retrieval metadata.

```yaml
retrieval:
  operation: discover
  result_kind: docs
  source_class: search-index
  selection: explicit
  arguments:
    query: query
    limit: limit
```

`selection: automatic` is the default. Automatic selectors and `all` use only configured, unauthenticated automatic sources. `selection: explicit` reserves paid or quota-bearing providers for an exact source ref or site selection.

## Arguments

YAML arguments are keyed by their command-line name.

```yaml
args:
  query:
    type: str
    required: true
    positional: true
    minLength: 1
    description: Search terms
  limit:
    type: int
    default: 10
    minimum: 1
    maximum: 100
  sort:
    type: str
    choices: [relevance, newest]
    default: relevance
```

Supported types are `str`, `str[]`, `int`, `float`, `nullable-float`, `str-or-int`, and `bool`.

String arguments can use `minLength`, `maxLength`, `pattern`, and standard formats such as `uri`, `uuid`, `date`, `date-time`, `email`, `hostname`, `ipv4`, `ipv6`, and `regex`. Uni-CLI kinds add validation for `path`, `adapter-ref`, `selector`, `shell-safe`, and `id`.

## Pipeline

`pipeline` is an ordered list of action objects.

```yaml
pipeline:
  - fetch:
      url: https://api.example.com/search
      params:
        q: ${{ args.query }}
  - select: data.items
  - map:
      title: ${{ item.title }}
      url: ${{ item.url }}
  - limit: ${{ args.limit }}
```

Templates can read `args`, the current `item` and `index`, environment values, and data stored by earlier steps. See [Pipeline steps](/reference/pipeline).

## Output

`columns` controls the default Markdown, table, and CSV field order. JSON keeps the complete result.

```yaml
columns: [title, url, score]
defaultFormat: md
```

`output` can provide a result schema and an agent hint for commands that need a more explicit contract.

## Required schema-v2 metadata

Committed YAML adapters carry six fields.

| Field                | Purpose                                       |
| -------------------- | --------------------------------------------- |
| `schema_version: v2` | Select the current adapter metadata schema    |
| `capabilities`       | List capabilities used by the command         |
| `minimum_capability` | Smallest interface required for execution     |
| `trust`              | `public`, `user`, or `system` provenance      |
| `confidentiality`    | `public`, `internal`, or `private` data class |
| `quarantine`         | Marks an adapter that is waiting for repair   |

Add current metadata to an existing adapter with this command.

```bash
unicli migrate schema-v2 path/to/adapter.yaml --write
```

## TypeScript adapters

Use TypeScript for SDK integration, streaming protocols, custom pagination, and stateful flows.

```typescript
import { cli, Strategy } from "../../registry.js";

cli({
  site: "example",
  name: "search",
  description: "Search Example",
  strategy: Strategy.PUBLIC,
  args: [{ name: "query", type: "str", required: true, positional: true }],
  capabilities: ["http.fetch"],
  minimum_capability: "http.fetch",
  trust: "public",
  confidentiality: "public",
  quarantine: false,
  operation_effect: "read",
  execution_operator: "structured-api",
  operation_family: "search",
  func: async (_page, { query }) => {
    const response = await fetch(
      `https://api.example.com/search?q=${encodeURIComponent(String(query))}`,
    );
    return response.json();
  },
});
```

TypeScript registrations use an argument array because they call the registry API directly.

## Validate

```bash
npm run lint:adapters
npm run lint:schema-v2
unicli describe <site> <command>
unicli test <site>
```

The loader implementation is in `src/core/yaml-adapter.ts` and the v2 metadata schema is in `src/core/schema-v2.ts`.
