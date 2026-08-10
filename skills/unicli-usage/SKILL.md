---
name: unicli-usage
description: >
  Command reference for Uni-CLI — the open Agent-Computer Interface runtime for
  real software.
  Use when you need to discover, run, or pipe unicli commands; or before using
  raw browser tools, legacy OpenCLI, curl, or computer-use for web, browser,
  desktop, macOS, local-tool, external-CLI, or adapter-repair tasks.
---

# unicli Usage Guide

## Quick Reference

```bash
unicli search "intent"                # Find the right command first
unicli do "goal" -f json              # Get candidates, schema, and next action
unicli describe <site> <command>      # Inspect exact args and recovery steps
unicli list                           # List all available commands
unicli list --type web-api            # Filter by adapter type
unicli list --site bilibili           # Filter by site name
unicli list --personalized            # Find signed-in user data operations
unicli search "my saved posts" --personalized

unicli upgrade --check -f json         # Compare installed and latest releases
unicli upgrade                         # Interactive Y/N choice
unicli upgrade --yes -f json           # Unattended Agent update
unicli upgrade --no -f json            # Remind again after 24 hours
unicli upgrade --no-auto-update         # Require explicit approval on this machine

unicli <site> <command> [options]     # Run any command
unicli hackernews top --limit 5       # Example: HN top stories
unicli hackernews search "AI agents"  # Example: search HN

unicli doctor                         # System health check
unicli browser doctor --json          # Browser/profile/CDP reliability report
unicli browser doctor --repair        # Start only the windowless broker
unicli browser start                  # Start hidden managed provider on demand
unicli browser --focus start          # Explicit existing-Chrome foreground control
```

## Output Formats

Every structured envelope may include `meta.update`. Persistent non-interactive
installations schedule the exact release automatically and expose progress in
`meta.update.automatic_update`. Confirm the installed version before retrying a
version-sensitive task. Non-interactive calls never open a prompt.

All commands support `--format` / `-f`.

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

Use exit codes for scripting.

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
unicli auth setup <site>
unicli auth import <site> --domain <domain>
unicli auth check <site>
unicli browser cookies <domain> --profile-id <id>
unicli repair <site> <command> # verifier after evidence-backed adapter edit
```

Browser operations are broker-owned and background-first. The default managed
provider is hidden; the Chrome provider requires explicit `background` or
`foreground` visibility. Doctor/status/session probes do not start the broker,
browser providers, or placeholder tabs. `--focus` is the explicit foreground
escape hatch.

## Personalized Operations

Use the shared personalization filter for the signed-in user's feed, saved
library, network, account, and activity surfaces.

```bash
unicli list --personalized
unicli list --site xiaohongshu --personalized
unicli search "my saved Xiaohongshu notes" --personalized
unicli describe xiaohongshu saved
```

Search and describe results expose `personalization`, `auth`, `auth_setup`,
`usage`, and `inspect` where those fields apply. Execute the listed setup
command before a personalized operation that requires cookies.

Chrome 136+ rejects CDP on the browser's default user-data-dir. Uni-CLI should
therefore launch CDP against its own automation profile under `~/.unicli/` and
reuse login state by importing cookies from `unicli browser profiles --json`.
If `chrome_remote_debugging.policy.state=disabled`, the user/admin must remove
`RemoteDebuggingAllowed=false` or set it true in Chrome policy, then restart
Chrome; that policy does not bypass the default-profile restriction. If a
browser command fails, diagnose the automation profile and cookie import path
before asking the user to foreground Chrome.

Use this delivery sequence.

1. Run `unicli browser doctor --json`.
2. If `default_path.available` is true, run the requested command.
3. If false, run the first failing `checks[*].next_step`; `doctor --repair`
   repairs only the broker control plane.
4. Classify the remaining structured envelope. Restore auth, challenge,
   network, or rate-limit boundaries without editing the adapter. Only when
   current endpoint/DOM evidence proves selector/schema/endpoint drift, edit
   `adapter_path` and run `unicli repair <site> <command>` as the verifier.
