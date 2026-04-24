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
unicli browser start          # Launch Chrome with CDP
unicli browser status         # Check CDP + daemon/session status
unicli browser open <url>     # Navigate to a page
unicli browser state          # DOM accessibility tree with [ref] numbers
unicli browser screenshot     # Visual capture to file
unicli browser find --css ... # Structured DOM query + ref allocation
unicli browser extract        # Chunked long-form text extraction
```

## Browser Lifecycle

```bash
unicli browser start          # Spawn Chrome + daemon (port 19825)
unicli browser status         # Connection health check
unicli daemon status          # Daemon process info
unicli daemon stop            # Stop daemon
unicli daemon restart         # Restart daemon
```

The daemon auto-exits after idle timeout. Chrome reuses your existing login sessions.

## Authentication

```bash
unicli auth setup <site>      # Show required cookies + file template
unicli auth check <site>      # Validate cookie file
unicli auth list              # List configured sites
```

Cookie files: `~/.unicli/cookies/<site>.json` with format `{ "KEY": "value" }`.

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

1. `browser start` / `browser cookies` use local Chrome + CDP directly.
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

## Diagnostics

```bash
unicli doctor                                    # Full system health check
UNICLI_DIAGNOSTIC=1 unicli <site> <cmd>          # Enhanced error context
```

## Troubleshooting

| Problem                 | Fix                                   |
| ----------------------- | ------------------------------------- |
| "Browser not connected" | `unicli browser start`                |
| Exit 69 (unavailable)   | `unicli browser start` then retry     |
| Exit 77 (auth)          | `unicli auth setup <site>` then retry |
| CDP connection dropped  | `unicli daemon restart`               |
