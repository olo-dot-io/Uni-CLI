# SKILL.md Export

`unicli skills export` emits one SKILL.md-compatible file per adapter command.
Use it when an agent runtime can ingest local skill files more cheaply than it
can call discovery on every task.

## Commands

```bash
unicli skills export
unicli skills export --out /tmp/unicli-skills
unicli skills publish
unicli skills publish --to ~/.cursor/skills/uni-cli/
unicli skills catalog
unicli skills catalog --out /tmp/catalog.json
```

## Generated Skill Shape

````markdown
---
name: hackernews-top
description: Hacker News top stories
when_to_use: When you need the current top items from hackernews.
command: unicli hackernews top
source: unicli@0.215.1
---

## What it does

Hacker News top stories. Returns columns: `rank`, `title`, `score`, `author`,
`comments`.

## How to call it

```bash
unicli hackernews top --limit 20
```
````

Use `-f json` when the caller needs JSON. Errors use the normal v2 envelope and
include the failing adapter path, step, and suggestion.

## Catalog Shape

`unicli skills catalog` writes `docs/adapters-catalog.json` or a custom output
path:

```json
{
  "source": "unicli@0.215.1",
  "total_sites": 220,
  "total_commands": 1283,
  "adapters": [
    {
      "site": "hackernews",
      "type": "web-api",
      "auth": false,
      "commands": [
        {
          "name": "top",
          "command": "unicli hackernews top",
          "columns": ["rank", "title", "score", "author", "comments"]
        }
      ]
    }
  ]
}
```

Agents can ingest the catalog once and route directly without repeated
discovery calls.
