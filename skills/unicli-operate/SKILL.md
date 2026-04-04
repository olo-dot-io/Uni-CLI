---
name: unicli-operate
description: >
  Browser automation for AI agents via unicli. Use when you need to interact
  with a website through unicli's browser bridge — navigate, click, type, extract.
---

# unicli Browser Automation

## Prerequisites

1. Chrome/Chromium running with the unicli Browser Bridge extension
2. Logged into the target website

## Available Commands

```bash
unicli operate open <url>              # Open a page
unicli operate state                   # Get current page state
unicli operate click <selector>        # Click an element
unicli operate type <selector> <text>  # Type into an input
unicli operate screenshot [path]       # Take screenshot
unicli operate extract <selector>      # Extract text/data
unicli operate wait <selector>         # Wait for element
unicli operate eval <script>           # Run JavaScript
unicli operate scroll [direction]      # Scroll page
unicli operate back                    # Navigate back
unicli operate close                   # Close tab
```

## Workflow

1. **Open** the target page
2. **State** — check what's on the page
3. **Interact** — click, type, select as needed
4. **Extract** — get the data you need
5. **Close** when done

## Example: Search Xiaohongshu

```bash
unicli operate open "https://www.xiaohongshu.com/explore"
unicli operate type "#search-input" "travel tips"
unicli operate click ".search-button"
unicli operate wait ".note-item"
unicli operate extract ".note-item" -f json
```

## Tips for AI Agents

- Use `state` to understand the page before interacting
- Use `wait` before `extract` to ensure content is loaded
- Use `-f json` for structured output
- Check exit code 77 for login-required pages
