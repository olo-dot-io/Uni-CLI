# Contributing an Adapter

Adapters are the unit of capability in Uni-CLI. Each adapter teaches one
website or local tool one trick (search, hot list, profile, etc.). Most are
~20 lines of YAML. Adding one is the highest-leverage way to contribute.

## Layout

```
src/adapters/
└── <site>/
    ├── _site.json       # optional: site-level metadata
    ├── search.yaml      # one file per command
    ├── hot.yaml
    └── ...
```

Loader: `src/discovery/loader.ts:131` (`loadAdaptersFromDir`).

## YAML schema (preferred)

```yaml
site: hackernews # required, kebab-case
name: top # required, matches filename
description: "Top stories on HN" # shown in `unicli list`
type: web-api # web-api | desktop | browser | bridge | service
strategy: public # public | cookie | header | intercept | ui

args:
  limit:
    type: int
    default: 30
    description: "Number of stories"

pipeline: # ordered steps; see Pipeline reference below
  - fetch:
      url: https://hacker-news.firebaseio.com/v0/topstories.json
  - limit: ${{ args.limit }}
  - map:
      title: "${{ item }}"

columns: [title] # default table columns
```

The full set of fields lives in `src/types.ts:82` (`AdapterManifest`) and
`src/discovery/loader.ts:88` (`YamlAdapter`). Run `npm run dev -- schema
<site> <command>` to print the JSON Schema for your adapter's inputs.

## TypeScript adapter (when YAML cannot express it)

```typescript
// src/adapters/example/complex.ts
import { cli, Strategy } from "../../registry.js";
import { AdapterType } from "../../types.js";

cli({
  site: "example",
  name: "complex",
  type: AdapterType.BROWSER,
  strategy: Strategy.UI,
  args: [{ name: "query", required: true, positional: true }],
  func: async (page, kwargs) => {
    await page.goto(`https://example.com/search?q=${kwargs.query}`);
    return page.evaluate(`document.title`);
  },
});
```

Loader entry point: `src/discovery/loader.ts:306` (`loadTsAdapters`).

## The 35 pipeline steps

Switch table: `src/engine/yaml-runner.ts:148`. Categories:

- API: `fetch`, `fetch_text`, `parse_rss`, `html_to_md`
- Transform: `select`, `map`, `filter`, `sort`, `limit`
- Desktop: `exec`, `write_temp`
- Browser: `navigate`, `evaluate`, `click`, `type`, `wait`,
  `intercept`, `press`, `scroll`, `snapshot`, `tap`, `extract`
- Media: `download`, `websocket`
- Control: `set`, `if`, `append`, `each`, `parallel`, `rate_limit`,
  `assert`, `retry`

Templates: `${{ args.foo }}`, `${{ item.bar }}`, `${{ vars.baz }}`,
`${{ temp.script_py }}`. Resolved by `src/engine/templates.ts`.

## Workflow

1. **Init**: `npm run dev -- init <site> <command>` scaffolds the YAML.
2. **Iterate**: `npm run dev -- <site> <command> --verbose` shows each
   pipeline step's input and output.
3. **Test**: add `tests/adapter/<site>.test.ts`. Pattern: see
   `tests/adapter/shared.ts` for fixtures.
4. **Verify**: `npm run verify` (format + typecheck + lint + tests + build).
5. **Commit**: `feat(adapter): add <site>/<command>`.

## Self-repair contract

When your adapter breaks (selector changed, API moved), users run
`unicli repair <site> <command>` (`src/commands/repair.ts`). Your YAML must
be readable enough that an agent can fix it without context — keep the
pipeline shallow, use named templates, document non-obvious selectors
inline.

## Testing locally

```bash
npm run dev -- list --site <site>      # confirm registration
npm run dev -- <site> <command> --json # smoke-test, JSON only
npm run test:adapter -- <site>          # run the adapter test
```

## Self-check before opening a PR

- [ ] `npm run verify` passes locally.
- [ ] `unicli list --site <site>` shows your command.
- [ ] `unicli <site> <command> --json` returns parseable JSON.
- [ ] Output schema is documented (either inline `output:` field or via
      `unicli schema <site> <command>`).
- [ ] At least one happy-path test in `tests/adapter/<site>.test.ts`.
- [ ] Changeset added (`npm run changeset`) — see
      `contributing/release.md`.
