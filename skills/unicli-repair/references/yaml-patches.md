# YAML Patch Recipes

Concrete fixes per failure type, indexed by what the envelope tells you.
Each recipe shows BEFORE → AFTER on a real YAML adapter idiom. Apply the
edit, save to `~/.unicli/adapters/<site>/<command>.yaml`, run
`unicli test <site>`.

When a recipe says "see SKILL.md destroy-and-rebuild section": the shape
itself is wrong; do not patch.

---

## `selector_miss`

The CSS selector or DOM ref disappeared. Refresh the snapshot, then
rewrite the selector against current DOM.

### Step 1 — get a current snapshot

```bash
unicli browser start
unicli operate open "<site URL>"
unicli operate snapshot > /tmp/snapshot.txt
```

### Recipe — selector text rename (`.feed-item` → `[data-testid="feed-card"]`)

BEFORE:

```yaml
pipeline:
  - navigate: "https://example.com/feed"
  - click: ".feed-item:first-child" # broken
  - wait: { selector: ".feed-detail" }
```

AFTER:

```yaml
pipeline:
  - navigate: "https://example.com/feed"
  - click: '[data-testid="feed-card"]:first-of-type'
  - wait: { selector: '[data-testid="feed-detail"]' }
```

Prefer attribute selectors over class names — class names get hashed by
modern build tools, attributes are more stable.

### Recipe — element moved into shadow DOM

If the snapshot shows `<#shadow-root>` between the page and the target,
the selector path needs to cross the boundary. Switch the step to
`evaluate` with `document.querySelector('host').shadowRoot.querySelector(...)`,
or use a deeper accessibility ref from `operate snapshot`.

---

## `auth_expired`

YAML almost never needs editing here. The cookie file expired or the
strategy needs upgrading.

### Step 1 — refresh credentials

```bash
unicli auth setup <site>      # opens browser, captures cookies
unicli <site> <cmd>           # retry
```

### Recipe — strategy upgrade `public` → `cookie`

If the site started gating data behind login (very common after anti-bot
hardening):

BEFORE:

```yaml
strategy: public
pipeline:
  - fetch: { url: "https://example.com/api/feed" }
```

AFTER:

```yaml
strategy: cookie # injects ~/.unicli/cookies/<site>.json
pipeline:
  - fetch: { url: "https://example.com/api/feed" }
```

### Recipe — strategy upgrade `cookie` → `header`

When cookies alone fail with 403 and the site uses a CSRF / Bearer token:

BEFORE:

```yaml
strategy: cookie
```

AFTER:

```yaml
strategy: header # cookie + auto-extracted CSRF token
```

The engine extracts CSRF tokens from intercepted XHR headers
automatically. No manual token wiring.

---

## `api_versioned`

The URL or response shape changed. Diff the live response against what
the YAML expects, update `fetch.url` / `select` / `map`.

### Step 1 — capture the current response

```bash
curl -sS "<the URL from error.adapter>" | jq . > /tmp/live.json
yq '.pipeline' src/adapters/<site>/<cmd>.yaml > /tmp/expected.yaml
```

### Recipe — `select` path moved (`data.list` → `data.items`)

BEFORE:

```yaml
pipeline:
  - fetch: { url: "https://api.example.com/v1/hot" }
  - select: data.list # path no longer exists
  - map: { title: "${{ item.title }}" }
```

AFTER:

```yaml
pipeline:
  - fetch: { url: "https://api.example.com/v1/hot" }
  - select: data.items
  - map: { title: "${{ item.title }}" }
```

### Recipe — endpoint version bump (`/v1/` → `/v2/`)

BEFORE:

```yaml
pipeline:
  - fetch: { url: "https://api.example.com/v1/feed" }
```

AFTER:

```yaml
pipeline:
  - fetch: { url: "https://api.example.com/v2/feed" }
  - select: data # often nested differently in new version
```

### Recipe — field renamed in response

Live JSON: `{ "items": [{ "headline": "...", "author_name": "..." }] }`.
YAML still maps `title` and `author`.

BEFORE:

```yaml
- map:
    title: "${{ item.title }}" # gone — now headline
    author: "${{ item.author }}" # gone — now author_name
```

AFTER:

```yaml
- map:
    title: "${{ item.headline }}"
    author: "${{ item.author_name }}"
```

### Recipe — schema split into nested object

Live: `{ "items": [{ "meta": { "title": ... }, "stats": { "likes": ... } }] }`.

BEFORE:

```yaml
- map:
    title: "${{ item.title }}"
    likes: "${{ item.likes }}"
```

AFTER:

```yaml
- map:
    title: "${{ item.meta.title }}"
    likes: "${{ item.stats.likes }}"
```

---

## `rate_limited`

The site throttled the request. Add backoff at the step level — never add
a silent fallback.

### Recipe — per-step retry with backoff

BEFORE:

```yaml
pipeline:
  - fetch: { url: "https://api.example.com/feed" }
```

AFTER:

```yaml
pipeline:
  - fetch:
      url: "https://api.example.com/feed"
    retry:
      max_attempts: 3
      backoff_ms: 2000 # 2s, 4s, 8s exponential
```

### Recipe — pipeline-level rate limit when looping

When the failing call sits inside `each:` / `parallel:`:

BEFORE:

```yaml
pipeline:
  - parallel:
      foreach: ${{ items }}
      do:
        - fetch: { url: "https://api.example.com/item/${{ item.id }}" }
```

AFTER:

```yaml
pipeline:
  - parallel:
      foreach: ${{ items }}
      max_concurrency: 3 # cap parallel requests
      rate_limit_per_sec: 5 # global pace
      do:
        - fetch: { url: "https://api.example.com/item/${{ item.id }}" }
```

### Recipe — switch from public to intercept when the API is fingerprinted

Some hosts gate the public API by TLS / header fingerprint. The headless
fetch fails 429 even on the first call. Promote to `intercept`:

BEFORE:

```yaml
strategy: public
pipeline:
  - fetch: { url: "https://api.example.com/feed" }
```

AFTER:

```yaml
strategy: intercept
pipeline:
  - navigate: "https://example.com/feed"
  - intercept:
      url_pattern: "/api/feed"
      capture: response
```

`intercept` runs the request through real Chrome with the user's
session — anti-bot heuristics see a normal browser.

---

## `unknown`

The classifier could not match. Re-run with the trace flag and read the
full pipeline log.

```bash
UNICLI_TRACE=1 unicli <site> <cmd> 2>/tmp/trace.log
less /tmp/trace.log
```

The trace shows every step's input/output, which transport ran, and the
exact moment the pipeline diverged. After reading the trace, the failure
will fall into one of the four classified types — re-apply the matching
recipe.

If the trace shows the failure spans multiple sites or originates from
the engine itself (e.g. `step-registry` cannot resolve a step kind), the
problem is not in the adapter. File an engine issue; do not patch the
YAML to work around an engine bug.

---

## What you must not write into a YAML

These patterns silently turn loud failures into wrong answers. Project
rule 02 forbids them.

| Pattern                                             | Why it fails                                 |
| --------------------------------------------------- | -------------------------------------------- |
| `${{ data.items \|\| [] }}`                         | Hides schema change behind an empty list     |
| `if: { fail_silent: true }`                         | Removes the only signal the next agent needs |
| `try_alternatives: [...]` then drop on all fail     | Stacks fallback branches into rot            |
| `default: null` on a fetch step                     | Same — turn a 404 into a phantom success     |
| Variant suffix `<cmd>_v2.yaml` next to `<cmd>.yaml` | rule 02 destroy-and-rebuild trigger          |

When you find one of these in an existing adapter, the adapter is past
patching. See SKILL.md "destroy and rebuild" — delete the YAML and write
a fresh one against the current API.
