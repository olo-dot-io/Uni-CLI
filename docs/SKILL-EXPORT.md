# SKILL.md Export

> One Anthropic-spec SKILL.md per adapter command, generated from the same metadata the CLI already loads.

## What it does

`unicli skills export` walks every adapter loaded by Uni-CLI (built-in, user, plugin) and emits one `.md` file per command into an output directory. Each file has YAML frontmatter that complies with Anthropic's [SKILL.md spec](https://docs.anthropic.com/en/docs/build-with-claude/agent-skills) and a 2-paragraph body documenting how to call it.

## Why

The SKILL.md spec is the de-facto interop layer between agent harnesses (Claude Code, Codex, Cursor, Cline, Windsurf, …). Tools that expose SKILL.md files plug into all of them. Without an exporter, every Uni-CLI adapter would need a hand-written counterpart in `~/.claude/skills/` — about 700 files at v0.208. The exporter makes that one command.

## Commands

```bash
# Generate skill files into ./skills/
unicli skills export

# Custom output directory
unicli skills export --out /tmp/unicli-skills

# Publish into a Claude skills directory (default ~/.claude/skills/uni-cli/)
unicli skills publish

# Publish to a custom location
unicli skills publish --to ~/.cursor/skills/uni-cli/

# Build the machine-readable single source of truth at docs/adapters-catalog.json
unicli skills catalog

# Custom catalog path
unicli skills catalog --out /tmp/catalog.json
```

## Output shape

For each adapter command, one file at `<out>/<site>/<command>.md`:

````markdown
---
name: hackernews-top
description: Hacker News top stories
when_to_use: When you need the current top items from hackernews.
command: unicli hackernews top
source: unicli@0.208.0
---

## What it does

Hacker News top stories. Returns columns: `rank`, `title`, `score`, `author`, `comments`.

## How to call it

```bash
unicli hackernews top [--limit 20]
```
````

Add `--format json` for piped output (auto-detected when stdout is not a TTY) and `--limit N` to cap result count. All Uni-CLI commands return structured JSON errors on stderr with the failing pipeline step and a repair suggestion.

````

## The catalog

`docs/adapters-catalog.json` is the canonical machine-readable view of every adapter command. Build it with:

```bash
unicli skills catalog
````

It contains:

```json
{
  "source": "unicli@0.208.0",
  "generated": "2026-04-08T00:00:00.000Z",
  "total_sites": 134,
  "total_commands": 711,
  "adapters": [
    {
      "site": "hackernews",
      "type": "web-api",
      "auth": false,
      "commands": [
        {
          "name": "top",
          "description": "Hacker News top stories",
          "when_to_use": "When you need the current top items from hackernews.",
          "command": "unicli hackernews top",
          "columns": ["rank", "title", "score", "author", "comments"],
          "args": [
            {
              "name": "limit",
              "type": "int",
              "required": false,
              "positional": false
            }
          ]
        }
      ]
    }
  ]
}
```

Agents can ingest the catalog once and route directly without making per-call discovery requests.
