---
name: unicli-explorer
description: >
  Create new Uni-CLI adapters by exploring websites and APIs. Use when adding
  support for a new site, desktop app, or service that unicli doesn't cover yet.
version: 1.0.0
triggers:
  - "create adapter"
  - "new adapter"
  - "add site"
  - "explore site"
allowed-tools: [Bash, Read, Write]
protocol: 2.0
---

## When to Use

Adding a new website, API, or local app to Uni-CLI's adapter catalog (~20-line YAML files).

## Workflow

### 1. Discover the API

```bash
unicli browser start                     # Ensure Chrome is running
unicli operate open <target-url>         # Navigate to target page
unicli operate state                     # Inspect DOM structure
unicli operate network                   # List captured JSON API requests
unicli operate click <ref>               # Trigger lazy-loaded APIs
unicli operate network                   # Check for new requests
```

### 2. Choose Strategy

| Condition | Strategy | Browser? |
|-----------|----------|----------|
| `fetch(url)` returns data | `public` | No |
| Needs login cookies | `cookie` | Yes |
| Needs CSRF/Bearer token | `header` | Yes |
| Complex signed requests | `intercept` | Yes |
| No API, DOM only | `ui` | Yes |

### 3. Write YAML Adapter

Create `src/adapters/<site>/<command>.yaml`:

```yaml
site: mysite
name: mycommand
description: What this command does
type: web-api
strategy: public
args:
  query: { type: str, required: true, positional: true }
  limit: { type: int, default: 20 }
pipeline:
  - fetch: { url: "https://api.example.com/search", params: { q: "${{ args.query }}" } }
  - select: data.results
  - map: { title: "${{ item.title }}", url: "${{ item.url }}" }
  - limit: ${{ args.limit }}
columns: [title, url]
```

### 4. Test

```bash
npm run dev -- mysite mycommand "test" --limit 3
npm run verify
```

### 5. Self-Repair

When adapters break: read error JSON `adapter_path` -> fix the ~20-line YAML ->
save to `~/.unicli/adapters/<site>/<cmd>.yaml` -> `unicli test <site>`.

## Key Pipeline Steps

`fetch`, `fetch_text`, `parse_rss`, `html_to_md`, `select`, `map`, `filter`, `sort`,
`limit`, `exec`, `navigate`, `evaluate`, `intercept`, `click`, `type`, `wait`,
`press`, `scroll`, `snapshot`, `download`, `set`, `if`, `each`, `parallel`

## Pipe Filters

`${{ item.field | join(', ') | truncate(100) }}` -- available: `join`, `urlencode`,
`slice`, `replace`, `lowercase`, `uppercase`, `trim`, `default`, `split`, `first`,
`last`, `length`, `strip_html`, `truncate`
