---
name: unicli-oneshot
description: >
  Quick single-command adapter generation for unicli. Use when you need to
  create a one-off command for a specific URL and goal — 4 steps done.
---

# unicli One-Shot Adapter

Generate a single unicli command from a URL + goal in 4 steps.

## Process

### Step 1: Open the Page

```bash
unicli operate open "<URL>"
unicli operate state
```

### Step 2: Discover the API

Open browser DevTools Network tab. Look for XHR/Fetch requests that return JSON data matching your goal.

Key signals:
- `/api/` or `/v1/` in URL → REST endpoint
- JSON response with array of items → listable data
- Query parameters → filterable

### Step 3: Write the YAML

Create `src/adapters/<site>/<command>.yaml`:

```yaml
site: <site-name>
name: <command>
description: <what it does>
type: web-api
strategy: public  # or cookie if auth needed
pipeline:
  - fetch:
      url: <discovered-api-url>
      params: <query-params>
  - select: <path.to.data>
  - map:
      title: ${{ item.title }}
      # ... map fields
columns: [title, ...]
```

### Step 4: Test

```bash
npm run dev -- <site> <command>
npm run dev -- <site> <command> -f json
```

Done. One YAML file, one command, zero code.
