---
name: unicli-usage
description: >
  Command reference and usage guide for unicli — the universal CLI for AI agents.
  Use when you need to discover, run, or pipe unicli commands.
---

# unicli Usage Guide

## Quick Reference

```bash
unicli list                           # List all available commands
unicli list --type web-api            # Filter by adapter type
unicli list --site bilibili           # Filter by site name

unicli <site> <command> [options]     # Run any command
unicli hackernews top --limit 5       # Example: HN top stories
unicli hackernews search "AI agents"  # Example: search HN

unicli doctor                         # System health check
```

## Output Formats

All commands support `--format` / `-f`:

| Format    | Use Case                            |
| --------- | ----------------------------------- |
| `md`      | Default v2 AgentEnvelope for agents |
| `json`    | Machine parsing / jq                |
| `yaml`    | Config-friendly envelope            |
| `csv`     | Spreadsheet import                  |
| `compact` | Pipe-friendly row stream            |

```bash
unicli hackernews top -f json | jq '.data[0].title'
unicli hackernews top -f csv > stories.csv
```

## Adapter Types

| Type      | Description              | Example              |
| --------- | ------------------------ | -------------------- |
| `web-api` | REST API calls           | hackernews, bilibili |
| `desktop` | Local desktop software   | blender, gimp        |
| `browser` | Full browser automation  | xiaohongshu          |
| `bridge`  | Existing CLI passthrough | gh, docker           |
| `service` | HTTP services            | ollama, comfyui      |

## Exit Codes

Use exit codes for scripting:

```bash
unicli hackernews top || echo "exit $?"
[ $? -eq 77 ] && echo "Login required"
```

| Code | Meaning             |
| ---- | ------------------- |
| 0    | Success             |
| 66   | Empty result        |
| 69   | Service unavailable |
| 77   | Auth required       |
