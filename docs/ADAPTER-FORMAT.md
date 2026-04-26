# Adapter Format (v2)

> The canonical reference for writing Uni-CLI adapters. 90% of adapters
> are YAML; the TypeScript escape hatch covers the remaining 10% where
> pipeline primitives are insufficient.

## Principles

1. **YAML first.** If the command is expressible as a finite pipeline over
   typed steps, write YAML. The system validates, migrates, and self-repairs
   YAML in ways it cannot do for arbitrary TypeScript.
2. **Agent-editable.** Keep adapters under ~50 lines of YAML whenever
   possible. Agents read and patch these files during self-repair.
3. **Deterministic.** The pipeline must be reproducible given the same
   inputs and upstream state. No wall-clock randomness, no hidden
   subprocess state.
4. **Minimum capability.** Declare the smallest transport surface the
   command needs (`http.fetch`, not `cua.anything`). Dispatchers use this
   to route calls safely.

## Table of Contents

1. [YAML schema (default path)](#yaml-schema-default-path)
2. [TypeScript escape hatch](#typescript-escape-hatch)
3. [Schema-v2 required fields](#schema-v2-required-fields)
4. [Strategy → transport migration](#strategy-transport-migration)
5. [Full examples](#full-examples)
6. [Troubleshooting](#troubleshooting)

---

## YAML schema (default path)

A minimum viable YAML adapter:

```yaml
site: example
name: top
description: "List top items from example.com"
type: web-api
transport: http
strategy: public
capabilities: [fetch, map, limit]
minimum_capability: http.fetch
trust: public
confidentiality: public
quarantine: false

pipeline:
  - fetch:
      url: "https://example.com/api/top"
  - select: "data.items"
  - map:
      id: "${{ item.id }}"
      title: "${{ item.title }}"
  - limit: 20

columns: [id, title]
```

### All fields

| Field                | Required    | Type                                                                                                 | Notes                                                                                                      |
| -------------------- | ----------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `site`               | yes         | string                                                                                               | Adapter site/service key, kebab-case. Used as `unicli SITE CMD`.                                           |
| `name`               | yes         | string                                                                                               | Command name; unique per site.                                                                             |
| `description`        | recommended | string                                                                                               | One-line description for `unicli list` and for agents.                                                     |
| `type`               | optional    | `web-api` \| `browser` \| `bridge` \| `desktop` \| `service`                                         | Omit for implicit `web-api`. Historical; the `transport` field is the v2 source of truth.                  |
| `transport`          | yes (v2)    | `http` \| `cdp-browser` \| `subprocess` \| `desktop-ax` \| `desktop-uia` \| `desktop-atspi` \| `cua` | The runtime dispatcher key.                                                                                |
| `strategy`           | optional    | `public` \| `cookie` \| `header` \| `intercept` \| `ui`                                              | Kept for 1 release as alias; see migration table below.                                                    |
| `capabilities`       | yes (v2)    | `string[]`                                                                                           | List of pipeline step names this command may invoke (e.g. `[fetch, map, limit]`).                          |
| `minimum_capability` | yes (v2)    | string                                                                                               | Single dispatcher capability required (e.g. `http.fetch`, `cdp-browser.navigate`).                         |
| `trust`              | yes (v2)    | `public` \| `user` \| `system`                                                                       | Provenance trust level. Default for committed YAML: `public`.                                              |
| `confidentiality`    | yes (v2)    | `public` \| `internal` \| `private`                                                                  | Data sensitivity. Default: `public`. Auth-required adapters: `internal` or `private`.                      |
| `quarantine`         | yes (v2)    | boolean                                                                                              | If `true`, command is skipped by `unicli test` and marked `[quarantined]` in `unicli list` until repaired. |
| `args`               | optional    | list                                                                                                 | Named + positional command arguments.                                                                      |
| `pipeline`           | yes         | list of step objects                                                                                 | Ordered sequence of pipeline steps.                                                                        |
| `columns`            | recommended | `string[]`                                                                                           | Default column order for the `md` / `csv` formatters.                                                      |
| `rate_limit`         | optional    | object                                                                                               | Per-domain token bucket config; see `src/engine/steps/rate-limit.ts`.                                      |

### Args

```yaml
args:
  - { name: query, type: string, required: true, positional: true }
  - { name: limit, type: int, default: 20 }
  - { name: sort, type: string, default: "hot" }
```

Types: `string`, `int`, `float`, `bool`, `string[]`. Positional args populate
`${{ args.NAME }}` in pipeline templates. Named flags become
`--NAME VALUE` on the command line.

### Pipeline steps

Pipeline steps are documented in `docs/reference/pipeline.md`.
The most common ones:

| Step         | Transport                      | Purpose                                                |
| ------------ | ------------------------------ | ------------------------------------------------------ |
| `fetch`      | http                           | HTTP request with retry, cookie injection, JSON parse. |
| `fetch_text` | http                           | HTTP request returning raw text (RSS, HTML).           |
| `select`     | pure                           | JSONPath-style navigation into the response.           |
| `map`        | pure                           | Transform each item via template with `${{ item.x }}`. |
| `filter`     | pure                           | Keep items matching a predicate.                       |
| `sort`       | pure                           | Sort by field.                                         |
| `limit`      | pure                           | Cap result count.                                      |
| `navigate`   | cdp-browser                    | Navigate a Chrome page via CDP.                        |
| `intercept`  | cdp-browser                    | Capture matching XHR/fetch responses.                  |
| `exec`       | subprocess                     | Run a subprocess with stdin/env/timeout.               |
| `snapshot`   | cdp-browser + desktop-ax + cua | DOM/AX tree snapshot with `ref` numbers.               |
| `cua_click`  | cua                            | Coordinate-level click via CUA backend.                |

Each step has a typed schema; unknown fields are rejected at load time.

---

## TypeScript escape hatch

Use TS when:

- The command needs control flow that YAML pipelines cannot express
  (multi-phase retries with domain-specific backoff, cursor-based pagination
  with server-computed tokens, stateful protocols like OAuth dance).
- The adapter wraps a library that is easier to call than to shell out.
- You need a typed response shape exported for downstream consumers.

Do not use TS because "it's faster to write" — YAML is the shared
vocabulary the self-repair loop and `unicli migrate` understand.

```typescript
// src/adapters/example/complex.ts
import { cli, Strategy } from "../../registry.js";

cli({
  site: "example",
  name: "complex",
  description: "Paginated search with server-computed cursors",
  strategy: Strategy.COOKIE,
  args: [
    { name: "query", required: true, positional: true },
    { name: "max_pages", type: "int", default: 5 },
  ],
  func: async (page, kwargs) => {
    const results: unknown[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < kwargs.max_pages; i++) {
      const res = await fetch(`https://example.com/search`, {
        method: "POST",
        body: JSON.stringify({ q: kwargs.query, cursor }),
      });
      const json = await res.json();
      results.push(...json.hits);
      cursor = json.next_cursor;
      if (!cursor) break;
    }
    return results;
  },
});
```

### Required schema-v2 metadata for TS adapters

Because TS adapters cannot be statically analysed, the `cli({...})` call
must still carry the v2 metadata fields so they appear in manifests and
the CI lint:

```typescript
cli({
  site: "example",
  name: "complex",
  capabilities: ["fetch"],
  minimum_capability: "http.fetch",
  trust: "public",
  confidentiality: "public",
  quarantine: false,
  // ...
});
```

Omitting these is a build error under `npm run lint:adapters`.

---

## Schema-v2 required fields

Schema v2 requires five metadata fields for CI safety, capability routing,
and honest provenance:

| Field                | Why it exists                                                                                               | Default when absent                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `capabilities`       | Declares the step surface. Used by dispatchers and by `unicli lint` to ensure only declared steps are used. | Inferred from pipeline by `unicli migrate schema-v2`.                                                                   |
| `minimum_capability` | Smallest transport the dispatcher must support.                                                             | `http.fetch` for legacy YAML (safe baseline).                                                                           |
| `trust`              | Provenance — is this adapter first-party, community, or user-supplied?                                      | `public` for committed YAML.                                                                                            |
| `confidentiality`    | Data-sensitivity label. Drives dispatcher routing when `--confidentiality` flag is set.                     | `public` unless `strategy` is `cookie` \| `header` \| `intercept` \| `ui` (in which case the migrator sets `internal`). |
| `quarantine`         | Skip this command in CI until repaired. Set by `unicli repair` when the command has failed three times.     | `false`.                                                                                                                |

Migration is automated: `unicli migrate schema-v2` reads all committed
YAML, fills defaults deterministically, and writes back. The migration
tool is idempotent — re-running it on a migrated file is a no-op.

## Strategy → transport migration

The old `strategy` field mapped to a mix of transport and auth concerns.
In v2, the concerns split: `transport` routes the call, `strategy` stays
only as a short-lived alias for the auth hint.

| Old `strategy`    | New `transport`                                  | New auth hint (kept in `strategy` for 1 release) |
| ----------------- | ------------------------------------------------ | ------------------------------------------------ |
| `public`          | `http`                                           | `public`                                         |
| `cookie`          | `http`                                           | `cookie`                                         |
| `header`          | `http`                                           | `header`                                         |
| `intercept`       | `cdp-browser`                                    | `intercept`                                      |
| `ui`              | `cdp-browser`                                    | `ui`                                             |
| _(new)_ `desktop` | `desktop-ax` \| `desktop-uia` \| `desktop-atspi` | none                                             |
| _(new)_ `cua`     | `cua`                                            | none                                             |

The `unicli migrate` tool handles the split. For a hand-written adapter,
set both fields explicitly and do not rely on legacy alias inference.

---

## Full examples

### 1. YAML, simplest case (web-api, public)

```yaml
# src/adapters/hackernews/top.yaml
site: hackernews
name: top
description: "Hacker News front page — top stories right now"
type: web-api
transport: http
strategy: public
capabilities: [fetch, select, map, limit]
minimum_capability: http.fetch
trust: public
confidentiality: public
quarantine: false

args:
  - { name: limit, type: int, default: 30 }

pipeline:
  - fetch:
      url: "https://hacker-news.firebaseio.com/v0/topstories.json"
  - limit: "${{ args.limit }}"
  - parallel:
      max: 10
      map:
        - fetch:
            url: "https://hacker-news.firebaseio.com/v0/item/${{ item }}.json"
  - map:
      rank: "${{ index + 1 }}"
      title: "${{ item.title }}"
      score: "${{ item.score }}"
      author: "${{ item.by }}"
      comments: "${{ item.descendants }}"
      url: "${{ item.url }}"

columns: [rank, title, score, author, comments, url]
```

### 2. TypeScript escape hatch (OAuth dance)

```typescript
// src/adapters/notion/search.ts
import { cli } from "../../registry.js";

cli({
  site: "notion",
  name: "search",
  description: "Search Notion workspace (requires OAuth)",
  capabilities: ["fetch"],
  minimum_capability: "http.fetch",
  trust: "public",
  confidentiality: "private", // accesses user workspace
  quarantine: false,
  args: [{ name: "query", required: true, positional: true }],
  func: async (_page, { query }) => {
    const token = await ensureNotionOAuthToken();
    const res = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({ query, page_size: 20 }),
    });
    const json = (await res.json()) as { results: unknown[] };
    return json.results;
  },
});
```

### 3. YAML with intercept (browser capture)

```yaml
# src/adapters/twitter/timeline.yaml
site: twitter
name: timeline
description: "Home timeline via XHR intercept"
type: browser
transport: cdp-browser
strategy: intercept
capabilities: [navigate, intercept, select, map, limit]
minimum_capability: cdp-browser.intercept
trust: public
confidentiality: private # user's timeline
quarantine: false

args:
  - { name: limit, type: int, default: 20 }

pipeline:
  - navigate:
      url: "https://twitter.com/home"
  - intercept:
      pattern: "/graphql/.*/HomeTimeline"
      wait: 8000
  - select: "data.home.home_timeline_urt.instructions[0].entries"
  - filter: "${{ item.entryId startsWith 'tweet-' }}"
  - map:
      id: "${{ item.content.itemContent.tweet_results.result.rest_id }}"
      text: "${{ item.content.itemContent.tweet_results.result.legacy.full_text }}"
      author: "${{ item.content.itemContent.tweet_results.result.core.user_results.result.legacy.screen_name }}"
  - limit: "${{ args.limit }}"

columns: [id, author, text]
```

### 4. YAML, quarantined (example of the CI gate)

```yaml
# src/adapters/example/broken.yaml
site: example
name: broken
description: "Endpoint retired 2026-03-01; pending repair"
type: web-api
transport: http
strategy: public
capabilities: [fetch, map]
minimum_capability: http.fetch
trust: public
confidentiality: public
quarantine: true
quarantineReason: "HTTP 404 since upstream deprecated /v1/feed; needs /v2 port"

pipeline:
  - fetch:
      url: "https://example.com/api/v1/feed"
  - map:
      id: "${{ item.id }}"
      title: "${{ item.title }}"

columns: [id, title]
```

Quarantined commands show up in `unicli list` with a `[quarantined]` tag,
are skipped by `unicli test`, and emit an informative error envelope
when invoked directly. The `quarantineReason` is free-form text shown in
`unicli doctor`.

### 5. YAML, CUA pipeline (computer-use agent transport)

```yaml
# src/adapters/figma/click-through.yaml
site: figma
name: click-through
description: "Click a canvas element by natural-language description"
type: browser
transport: cua
strategy: ui
capabilities: [cua_snapshot, cua_click, cua_wait, cua_ask, assert]
minimum_capability: cua.snapshot
trust: public
confidentiality: internal
quarantine: false

args:
  - { name: target, type: string, required: true, positional: true }
  - { name: backend, type: string, default: "anthropic" }

pipeline:
  - cua_backend:
      name: "${{ args.backend }}"
  - cua_snapshot: {}
  - cua_ask:
      prompt: "Find the UI element matching: ${{ args.target }}"
      returns: { ref: string }
  - cua_click:
      ref: "${{ vars.ref }}"
  - cua_wait:
      for: "idle"
      timeout: 3000
  - assert:
      url_contains: "/edited"

columns: [ok, url]
```

CUA commands are expensive because screenshot and LLM inference cost scales
with backend complexity. Do not default to CUA when a
`cdp-browser` adapter is feasible; the dispatcher will warn if a CUA
command could have been expressed as intercept.

---

## Troubleshooting

| Symptom                                                   | Likely cause                                                                | Fix                                                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Unknown step: ...` at load time                          | Step name typo or step not registered                                       | Check `src/engine/steps/` for supported names.                                                            |
| `Adapter schema v2 violation: missing minimum_capability` | Pre-v2 YAML not migrated                                                    | Run `unicli migrate schema-v2 src/adapters/SITE/CMD.yaml`.                                                |
| `Forbidden: step X not in capabilities`                   | Pipeline uses a step not declared in `capabilities`                         | Add the step name to `capabilities`, or drop the step.                                                    |
| `Strategy 'legacy-xyz' unknown`                           | Typo or dropped strategy                                                    | Consult the Strategy migration table; `legacy-xyz` is probably replaced by a named transport.             |
| `HTTP 403 Forbidden` on cookie strategy                   | Cookie file stale                                                           | `unicli auth setup SITE` to re-authenticate; run `unicli repair SITE/CMD` for directed patch suggestions. |
| `Interception timed out after 8000ms`                     | Selector/URL pattern changed upstream                                       | Inspect page network panel, update the `pattern` in `intercept` step, re-run.                             |
| `cua_backend: anthropic not configured`                   | `ANTHROPIC_API_KEY` unset or CUA backend sidecar not running                | `unicli daemon status` to check; `export ANTHROPIC_API_KEY=...`.                                          |
| `quarantine: true` but command still tries to run         | You called the command directly; quarantine only affects CI + `unicli test` | Remove `quarantine` once repaired, or run `unicli repair SITE/CMD` to auto-patch + lift the flag.         |
| `trust: user` adapter refuses to run                      | CI safety gate rejects user-trust adapters when `UNICLI_TRUST_FLOOR=public` | Set `trust: public` and get the file reviewed, or run with `UNICLI_TRUST_FLOOR=user` locally.             |

For anything not on this list, `unicli doctor` prints the relevant
diagnostics. If that does not resolve the issue, open an issue with the
full stderr envelope — the `adapter_path` / `step` / `action` /
`suggestion` fields are what we need to help.

---

## See also

- `docs/reference/pipeline.md` — full step catalog with examples.
- `src/core/schema-v2.ts` — the authoritative Zod schema.
- `src/adapters/` — committed adapters to read as working examples.

_Document version: v2. Last updated 2026-04-25._
