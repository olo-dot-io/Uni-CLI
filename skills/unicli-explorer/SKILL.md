---
name: unicli-explorer
description: >
  Guide for creating new unicli adapters. Use when building a new adapter for
  a website, desktop app, or service that unicli doesn't yet support.
---

# Creating unicli Adapters

## Decision Tree

```
Is it a public REST API?
  → Yes: YAML adapter, type: web-api, strategy: public
  → No: Does it need browser login?
    → Yes, simple fetch with cookies: YAML, strategy: cookie
    → Yes, request interception: YAML, strategy: intercept
    → Yes, DOM interaction: TypeScript, strategy: ui
    → No: Is it a local app?
      → CLI exists: YAML, type: desktop or bridge
      → HTTP API (localhost): YAML, type: service
      → No CLI or API: TypeScript adapter
```

## YAML Adapter Template

Create `src/adapters/<site>/<command>.yaml`:

```yaml
site: mysite
name: mycommand
description: What this command does
type: web-api
strategy: public

args:
  query:
    type: str
    required: true
    positional: true
    description: Search query
  limit:
    type: int
    default: 20

pipeline:
  - fetch:
      url: "https://api.example.com/search"
      params:
        q: "${{ args.query }}"
        limit: "${{ args.limit }}"
      retry: 2
      backoff: 500

  - select: data.results

  - map:
      rank: "${{ index + 1 }}"
      title: "${{ item.title }}"
      url: "${{ item.url }}"

  - limit: ${{ args.limit }}

columns: [rank, title, url]
```

## Pipeline Steps

| Step         | Purpose                      | Example                                                            |
| ------------ | ---------------------------- | ------------------------------------------------------------------ |
| `fetch`      | HTTP JSON request (GET/POST) | `fetch: { url: "...", method: POST, body: {...}, retry: 2 }`       |
| `fetch_text` | HTTP raw text (for RSS/HTML) | `fetch_text: { url: "..." }`                                       |
| `parse_rss`  | Parse RSS/XML items          | `parse_rss: {}`                                                    |
| `html_to_md` | Convert HTML to Markdown     | `html_to_md: {}`                                                   |
| `select`     | Navigate into response       | `select: data.items`                                               |
| `map`        | Transform each item          | `map: { title: "${{ item.title }}" }`                              |
| `filter`     | Keep matching items          | `filter: "item.score > 10"`                                        |
| `sort`       | Sort results                 | `sort: { by: score, order: desc }`                                 |
| `limit`      | Cap result count             | `limit: ${{ args.limit }}`                                         |
| `exec`       | Run subprocess               | `exec: { command: ffmpeg, args: [...], stdin: "...", env: {...} }` |

## Exec Step (Desktop/Bridge)

```yaml
pipeline:
  - exec:
      command: ffprobe
      args:
        [
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_format",
          "${{ args.file }}",
        ]
      parse: json
      stdin: "${{ args.input }}"
      env:
        MY_VAR: "${{ args.val }}"
      output_file: "${{ args.output }}"
      timeout: 30000
```

## Pipe Filters

Use in templates: `${{ item.tags | join(', ') | truncate(100) }}`

Available: `join`, `urlencode`, `slice`, `replace`, `lowercase`, `uppercase`, `trim`, `default`, `split`, `first`, `last`, `length`, `strip_html`, `truncate`

## Testing

```bash
npm run dev -- <site> <command> [args]
npm run test:adapter
npm run verify
```

## Checklist

- [ ] YAML file in `src/adapters/<site>/`
- [ ] `npm run verify` passes
- [ ] Smoke test returns expected data
