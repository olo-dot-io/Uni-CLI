<!-- Generated from docs/reference/maintenance.md. Do not edit this copy directly. -->

# Maintenance Tools

- Canonical: https://olo-dot-io.github.io/Uni-CLI/reference/maintenance
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/reference/maintenance.md
- Section: Reference
- Parent: Reference (/reference/)

This page groups the small maintenance surfaces that used to be split across
separate docs pages. Use it when verifying agent context quality, adapter
regressions, or generated skill exports.

## Context Lint

`npm run lint:context` runs `scripts/lint-context.sh` against agent-facing
context such as `AGENTS.md`, local skills, workflows, and docs. It catches
stale paths, missing verification instructions, and weak operational context
before an agent relies on it.

Resolution order:

1. `agent-lint` on `PATH`.
2. A vendored local build, when present.
3. Soft skip with a warning. The script does not fetch from the network.

Commands:

```bash
npm run lint:context
UNICLI_LINT_THRESHOLD=80 npm run lint:context
UNICLI_LINT_DISABLE=1 npm run verify
```

Threshold checks require `jq`. Without it, the script prints the raw output and
exits 0.

## Eval Harness

`unicli eval` runs YAML-defined regression suites against adapters and reports
`SCORE=N/M`. User-local evals live under `~/.unicli/evals/`.

Commands:

```bash
unicli eval list
unicli eval run smoke/hackernews
unicli eval run --all smoke/
unicli eval ci --since 7d
unicli eval run smoke/hackernews --json
```

Eval file shape:

```yaml
name: hackernews-smoke
adapter: hackernews
description: Hacker News public-API smoke test
cases:
  - command: top
    args:
      limit: 5
    judges:
      - { type: arrayMinLength, min: 5 }
      - { type: nonEmpty }
```

Judges:

| Type             | Fields                        | Passes when                                |
| ---------------- | ----------------------------- | ------------------------------------------ |
| `exitCode`       | `equals: 0`                   | The CLI exit code matches.                 |
| `nonEmpty`       | none                          | Raw output is non-whitespace.              |
| `matchesPattern` | `pattern: "regex"`            | Raw output matches the regex.              |
| `contains`       | `field?: "json.path", value:` | The resolved value contains the substring. |
| `arrayMinLength` | `path?: "json.path", min:`    | The resolved value is an array of `min`+.  |

Field paths use dotted syntax with array subscripts:

```text
data.items[0].title
results[3].author
```

## Skill Export

`unicli skills export` emits one `SKILL.md`-compatible file per adapter
command. Use it when an agent runtime can ingest local skills more cheaply than
it can call discovery for every task.

Commands:

```bash
unicli skills export
unicli skills export --out /tmp/unicli-skills
unicli skills publish
unicli skills publish --to ~/.cursor/skills/uni-cli/
unicli skills catalog
unicli skills catalog --out /tmp/catalog.json
```

Generated skill shape:

````markdown
---
name: hackernews-top
description: Hacker News top stories
when_to_use: When you need the current top items from hackernews.
command: unicli hackernews top
source: unicli
---

## What it does

Hacker News top stories.

## How to call it

```bash
unicli hackernews top --limit 20
```
````

Use `-f json` when the caller needs JSON. Errors use the normal v2 envelope and
include the failing adapter path, step, and suggestion.

`unicli skills catalog` writes `docs/adapters-catalog.json` or a custom output
path. Agents can ingest the catalog once and route directly without repeated
discovery calls.
