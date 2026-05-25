---
name: unicli-browser
description: >
  Control browser automation sessions via unicli. The browser command now owns
  lifecycle, interaction, introspection, and daemon diagnostics.
version: 1.0.0
triggers:
  - "browser automation"
  - "control chrome"
  - "unicli browser"
  - "launch chrome"
allowed-tools: [Bash]
protocol: 2.0
---

## When to Use

Use `unicli browser` for both browser lifecycle and direct page interaction.
`unicli operate` still exists, but it is now a compatibility alias over the same implementation.

## Quick Start

```bash
unicli browser start          # Launch Chrome with CDP without a foreground startup window
unicli browser doctor --repair # Safe repair: start Uni-CLI automation CDP if needed
unicli browser --focus start  # Foreground only for explicit interactive login
unicli browser status         # Check CDP + daemon/session status
unicli browser doctor --json  # Machine-readable reliability report
unicli browser profiles --json # Discover local logged-in profiles
unicli browser open <url>     # Navigate to a page
unicli browser state          # DOM accessibility tree with [ref] numbers
unicli browser screenshot     # Visual capture to file
unicli browser find --css ... # Structured DOM query + ref allocation
unicli browser extract        # Chunked long-form text extraction
```

## Browser Lifecycle

```bash
unicli browser start          # Spawn Chrome + daemon in background-safe mode
unicli browser doctor --repair # Safe self-repair for local automation CDP
unicli browser --focus start  # Opt into a foreground startup window
unicli browser status         # Connection health check
unicli daemon status          # Daemon process info
unicli daemon stop            # Stop daemon
unicli daemon restart         # Restart daemon
```

The daemon auto-exits after idle timeout. Chrome/CDP uses Uni-CLI-owned
automation profiles under `~/.unicli/` rather than the browser's default
user-data-dir. Logged-in state is reused by importing cookies from the selected
local profile into the automation profile. Browser commands default to
`windowFocused: false`; use `--focus` only when a real interactive login step
must bring Chrome forward.

## Authentication

```bash
unicli auth setup <site>      # Show required cookies + file template
unicli auth import <site> --domain <domain> # Direct import from local browser DB
unicli browser profiles --json # Pick a logged-in Chrome/Arc/Brave/Edge profile
unicli browser cookies <domain> --profile-id <id> # Explicit cookie export
unicli auth check <site>      # Validate cookie file
unicli auth list              # List configured sites
```

Cookie files: `~/.unicli/cookies/<site>.json` with format `{ "KEY": "value" }`.

Chrome 136+ blocks remote debugging when Chrome is launched against its default
profile directory. Do not tell users to run CDP on
`~/Library/Application Support/Google/Chrome` or equivalent, and do not suggest
unstable feature-flag bypasses. `RemoteDebuggingAllowed=false` in
`chrome://policy` blocks local CDP entirely; removing that managed policy or
setting it true is a user/admin action. Even when the policy is true, it does
not make default-profile CDP supported again. Use the automation profile plus
cookie import path instead:

```bash
unicli browser profiles --json
unicli auth import twitter --domain x.com
unicli twitter trending -f json
```

## Strategies Requiring Browser

| Strategy    | How it works                                   |
| ----------- | ---------------------------------------------- |
| `cookie`    | Injects cookies from file into request headers |
| `header`    | Cookie + auto-extracted CSRF token             |
| `intercept` | Navigate page, capture XHR/fetch responses     |
| `ui`        | Interact with page DOM (click, type, scroll)   |

`public` strategy does NOT need a browser.

## Architecture

There are two browser paths:

1. `browser start` uses local Chrome + CDP with a Uni-CLI automation profile.
   `browser cookies` first tries direct local profile cookie import, then only
   reuses a recorded CDP port if that port is already live.
2. `browser open/state/click/...` use:
   CLI -> daemon-client -> HTTP/WS -> daemon -> Browser Bridge extension -> Chrome tabs

That means extension state, daemon port, workspace, focus/background mode, and tab binding are all part of the real runtime story.

Useful controls:

```bash
unicli browser --daemon-port 19826 sessions
unicli browser --workspace profile-a bind --match-domain example.com
unicli browser --isolated open https://example.com
unicli browser --background open https://example.com
```

`unicli browser doctor --json` and `unicli browser sessions` are read-only
probes: they inspect daemon/session state without allocating an `about:blank`
placeholder tab.

The doctor report is the routing source of truth for agents:

- `default_path`: whether a command can run now, and which runtime mode will
  carry it (`local-cdp-automation-profile`, `remote-cdp`, or daemon extension).
- `chrome_remote_debugging`: official Chrome 136+ default-directory truth and
  `RemoteDebuggingAllowed` policy state.
- `checks[*].next_step`: exact next command for each missing capability.
- `self_repair.safe_command`: safe automated repair. Today this is
  `unicli browser doctor --repair`, which starts only Uni-CLI's automation CDP
  profile and never launches CDP against the user's default Chrome profile.

## Diagnostics

```bash
unicli doctor                                    # Full system health check
UNICLI_DIAGNOSTIC=1 unicli <site> <cmd>          # Enhanced error context
```

## Troubleshooting

| Problem                 | Fix                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| "Browser not connected" | `unicli browser doctor --json`, then `unicli browser doctor --repair`                                |
| Exit 69 (unavailable)   | `unicli browser doctor --repair` then retry                                                          |
| Exit 77 (auth)          | `unicli auth import <site> --domain <domain>` or `unicli browser cookies <domain> --profile-id <id>` |
| CDP connection dropped  | `unicli daemon restart`                                                                              |
