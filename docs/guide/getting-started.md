# Getting Started

Uni-CLI turns any website, desktop app, or cloud service into a CLI command. Install it, run a command, and get structured output — ready for AI agents or human eyes.

## Installation

```bash
npm install -g unicli
```

Requires Node.js 20 or later.

Verify the installation:

```bash
unicli --version
# 0.204.0
```

## Your First Command

Fetch the top stories from Hacker News:

```bash
unicli hackernews top
```

This outputs a formatted table in your terminal:

```
 # │ Title                                    │ Score │ Comments │ URL
───┼──────────────────────────────────────────┼───────┼──────────┼────────────────────
 1 │ Show HN: I built a CLI for AI agents     │  342  │    127   │ https://example.com
 2 │ SQLite is all you need                    │  289  │     94   │ https://example.com
```

## JSON Output

When piped, Uni-CLI automatically switches to JSON — no flags needed:

```bash
unicli hackernews top | jq '.[0]'
```

```json
{
  "title": "Show HN: I built a CLI for AI agents",
  "score": 342,
  "comments": 127,
  "url": "https://example.com"
}
```

You can also force JSON with the `--json` flag:

```bash
unicli hackernews top --json
```

## Discovering Commands

List all available commands:

```bash
unicli list
```

List commands for a specific site:

```bash
unicli list hackernews
```

Search across all adapters:

```bash
unicli list --search "trending"
```

## Authentication

Some sites require cookies from your browser. Uni-CLI can extract them directly from Chrome via CDP (Chrome DevTools Protocol).

### Step 1: Start the browser daemon

```bash
unicli browser start
```

This connects to your running Chrome instance (or launches one) with remote debugging enabled.

### Step 2: Set up auth for a site

```bash
unicli auth setup bilibili
```

This opens the login page in Chrome. Sign in normally, then Uni-CLI extracts and stores the session cookies.

### Step 3: Verify authentication

```bash
unicli auth check bilibili
```

### Step 4: Use authenticated commands

```bash
unicli bilibili feed
unicli bilibili favorites
```

Cookies are stored in `~/.unicli/cookies/<site>.json` and automatically injected into requests.

## Browser Automation

For sites that require full browser interaction (not just cookies), Uni-CLI drives Chrome directly via CDP.

Start the browser daemon:

```bash
unicli browser start
```

Check status:

```bash
unicli browser status
```

Browser-type adapters automatically connect to the daemon:

```bash
unicli chatgpt ask "What is the meaning of life?"
unicli notion search "meeting notes"
```

## Direct Browser Control

The `operate` command gives you low-level browser control — useful for automation scripts:

```bash
unicli operate goto "https://example.com"
unicli operate snapshot
unicli operate click --ref 42
unicli operate type --ref 7 --text "hello"
unicli operate screenshot --path ./page.png
```

## Output Formats

Every command supports multiple output formats:

```bash
unicli hackernews top              # table (default in terminal)
unicli hackernews top --json       # JSON
unicli hackernews top --yaml       # YAML
unicli hackernews top --csv        # CSV
unicli hackernews top --md         # Markdown table
```

## Exit Codes

Uni-CLI uses `sysexits.h`-compatible exit codes so agents can programmatically handle failures:

| Code | Meaning             | Agent Action             |
| ---- | ------------------- | ------------------------ |
| 0    | Success             | Use the data             |
| 1    | Generic error       | Read stderr JSON         |
| 2    | Usage error         | Fix the command syntax   |
| 66   | Empty result        | Try different parameters |
| 69   | Service unavailable | Retry later              |
| 75   | Temporary failure   | Retry with backoff       |
| 77   | Auth required       | Run `unicli auth setup`  |
| 78   | Config error        | Check adapter YAML       |

## Next Steps

- [Adapters](/guide/adapters) — Learn about the 5 adapter types and write your own
- [Self-Repair](/guide/self-repair) — How agents fix broken adapters automatically
- [Pipeline Steps](/reference/pipeline) — All 30 pipeline steps with YAML examples
- [Exit Codes](/reference/exit-codes) — Complete exit code reference
