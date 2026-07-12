---
name: unicli-usage
description: >
  Command reference and usage guide for unicli — the universal CLI for AI agents.
  Use when you need to discover, run, or pipe unicli commands; or before using
  raw browser tools, legacy OpenCLI, curl, or computer-use for web, browser,
  desktop, macOS, local-tool, external-CLI, or adapter-repair tasks.
---

# unicli Usage Guide

## Quick Reference

```bash
unicli search "intent"                # Find the right command first
unicli list                           # List all available commands
unicli list --type web-api            # Filter by adapter type
unicli list --site bilibili           # Filter by site name

unicli <site> <command> [options]     # Run any command
unicli hackernews top --limit 5       # Example: HN top stories
unicli hackernews search "AI agents"  # Example: search HN

unicli doctor                         # System health check
unicli browser doctor --json          # Browser/profile/CDP reliability report
unicli browser doctor --repair        # Safe repair for local automation CDP
unicli browser start                  # Background-safe CDP startup
unicli browser --focus start          # Foreground only for explicit login
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

## Auth and Browser Reuse

```bash
unicli browser profiles --json
unicli auth import <site> --domain <domain>
unicli browser cookies <domain> --profile-id <id>
unicli repair <site> <command> # verifier after evidence-backed adapter edit
```

Browser operations are backend/background-first. Daemon commands default to
`windowFocused: false`, doctor/session probes must not create placeholder tabs,
and `--focus` is the explicit escape hatch for a foreground login flow.

Chrome 136+ rejects CDP on the browser's default user-data-dir. Uni-CLI should
therefore launch CDP against its own automation profile under `~/.unicli/` and
reuse login state by importing cookies from `unicli browser profiles --json`.
If `chrome_remote_debugging.policy.state=disabled`, the user/admin must remove
`RemoteDebuggingAllowed=false` or set it true in Chrome policy, then restart
Chrome; that policy does not bypass the default-profile restriction. If a
browser command fails, diagnose the automation profile and cookie import path
before asking the user to foreground Chrome.

Agent loop for delivery:

1. Run `unicli browser doctor --json`.
2. If `default_path.ready` is true, run the requested command.
3. If false, run `self_repair.safe_command` or the first failing
   `checks[*].next_step`.
4. Classify the remaining structured envelope. Restore auth, challenge,
   network, or rate-limit boundaries without editing the adapter. Only when
   current endpoint/DOM evidence proves selector/schema/endpoint drift, edit
   `adapter_path` and run `unicli repair <site> <command>` as the verifier.
