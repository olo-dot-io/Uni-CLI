---
name: unicli-operate
description: >
  Direct browser automation with unicli operate subcommands. Navigate, inspect,
  interact, and extract data from any website step by step via Chrome CDP.
version: 1.0.0
triggers:
  - "operate browser"
  - "click element"
  - "fill form"
  - "extract page data"
  - "unicli operate"
allowed-tools: [Bash]
protocol: 2.0
---

## When to Use

Step-by-step browser interaction: navigate, click, fill forms, extract data, screenshot.
For browser lifecycle (start/stop/auth), see `unicli-browser`.

## Core Workflow

1. `open` -> navigate to URL
2. `state` -> inspect DOM, get `[ref]` numbers for interactive elements
3. interact -> `click`, `type`, `select`, `keys` using ref numbers
4. verify -> `state` again or `get value <ref>` to confirm
5. extract -> `eval` for structured data

**Always `state` before interacting. Never guess ref numbers.**

## All Operate Subcommands

```bash
# Navigation
unicli operate open <url>             # Navigate to URL
unicli operate back                   # Go back in history
unicli operate scroll [direction]     # down, up, bottom, top
unicli operate close                  # Close automation window

# Inspection
unicli operate state                  # DOM tree with [ref] indices
unicli operate screenshot [path]      # Save visual capture

# Get data
unicli operate get title|url          # Page title or URL
unicli operate get text <ref>         # Element text by ref
unicli operate get value <ref>        # Input value (verify after type)
unicli operate get html [selector]    # Page or scoped HTML
unicli operate get attributes <ref>   # Element attributes

# Interaction
unicli operate click <ref>            # Click element
unicli operate type <ref> <text>      # Type into element
unicli operate select <ref> <option>  # Select dropdown
unicli operate keys <key>             # Press key (Enter, Escape, Control+a)
unicli operate upload <ref> <path>    # Upload file
unicli operate hover <ref>            # Hover over element

# Wait
unicli operate wait time <ms>         # Fixed delay
unicli operate wait selector <sel>    # Until element appears
unicli operate wait text <str>        # Until text appears

# Advanced
unicli operate eval <js>              # Execute JS in page
unicli operate network [pattern]      # Captured network requests
unicli operate observe <query>        # Natural language observation
```

## Patterns

```bash
# Browse + extract
unicli operate open "https://news.ycombinator.com" && unicli operate state
unicli operate eval "JSON.stringify([...document.querySelectorAll('.titleline a')].slice(0,5).map(a=>({title:a.textContent,url:a.href})))"

# Fill form (chain to reduce round trips)
unicli operate type 3 "user@example.com" && unicli operate type 5 "pass" && unicli operate click 7

# API discovery
unicli operate open "https://example.com/feed" && unicli operate wait time 3000
unicli operate network                # See captured JSON APIs
```

## Rules

1. Always `state` first -- never guess refs
2. `eval` is read-only -- never `eval "el.click()"`, use `click <ref>`
3. Verify inputs with `get value <ref>` after `type`
4. Re-inspect after navigation -- run `state` after `open` or link clicks
5. Prefer API over DOM -- if `network` reveals JSON APIs, use YAML adapters

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Browser not connected | `unicli browser start` |
| Element not found | `scroll down` then `state` |
| Stale refs after click | `state` to refresh |
| eval returns undefined | Wrap: `"(function(){ return ...; })()"` |
