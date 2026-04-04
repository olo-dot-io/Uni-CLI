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
    → Yes, DOM interaction: TypeScript, Strategy.UI
    → No: Is it a local app?
      → CLI exists: YAML, type: desktop
      → No CLI: YAML, type: service (if HTTP API)
      → Wrap existing CLI: YAML, type: bridge
```

## YAML Adapter Template

Create `src/adapters/<site>/<command>.yaml`:

```yaml
site: mysite
name: mycommand
description: What this command does
type: web-api # web-api | desktop | browser | bridge | service
strategy: public # public | cookie | header
browser: false

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
      url: https://api.example.com/search
      params:
        q: ${{ args.query }}
        limit: ${{ args.limit }}

  - select: data.results

  - map:
      rank: ${{ index + 1 }}
      title: ${{ item.title }}
      url: ${{ item.url }}

columns: [rank, title, url]
```

## Desktop Adapter Template

```yaml
site: blender
name: render
description: Render a Blender scene
type: desktop
binary: blender
detect: which blender

args:
  file:
    type: str
    required: true
    positional: true
  output:
    type: str
    default: ./output.png
  frame:
    type: int
    default: 1

execArgs:
  - --background
  - ${{ args.file }}
  - --render-output
  - ${{ args.output }}
  - --render-frame
  - ${{ args.frame }}
```

## Testing Your Adapter

```bash
npm run dev -- <site> <command> [args]    # Test locally
npm run test:adapter                       # Run adapter tests
```

## Checklist Before PR

- [ ] YAML/TS adapter file created in `src/adapters/<site>/`
- [ ] `registry.json` entry added
- [ ] Adapter test in `tests/adapter/`
- [ ] `npm run verify` passes
