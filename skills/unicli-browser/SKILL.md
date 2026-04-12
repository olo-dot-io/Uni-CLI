---
name: unicli-browser
description: >
  Control Chrome browser for web automation via unicli. Navigate, click, type,
  screenshot, and extract data using the daemon browser bridge.
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

Launch and manage Chrome for unicli's browser-dependent adapters (cookie, header,
intercept, ui strategies), or when using `unicli operate` for direct page interaction.

## Quick Start

```bash
unicli browser start          # Launch Chrome with CDP
unicli browser status         # Check daemon connection
unicli operate open <url>     # Navigate to a page
unicli operate state          # DOM accessibility tree with [ref] numbers
unicli operate screenshot     # Visual capture to file
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

CLI -> daemon-client -> HTTP/WS -> daemon (port 19825) -> CDP WebSocket -> Chrome.
Raw CDP via `ws` package. No Puppeteer, no Playwright, no extensions.

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
