# Pipeline Steps

Uni-CLI adapters execute a sequence of pipeline steps. Each step performs one action — fetch data, transform it, interact with a browser, or control execution flow. There are 30 steps grouped into 7 categories.

## Overview

| Category  | Steps                                                              | Count |
| --------- | ------------------------------------------------------------------ | ----- |
| API       | fetch, fetch_text, parse_rss, html_to_md                          | 4     |
| Transform | select, map, filter, sort, limit                                   | 5     |
| Desktop   | exec, write_temp                                                   | 2     |
| Browser   | navigate, evaluate, click, type, wait, intercept, press, scroll, snapshot, tap | 10 |
| Media     | download                                                           | 1     |
| Service   | websocket                                                          | 1     |
| Control   | set, if, append, each, parallel, rate_limit                        | 6     |

---

## API Steps

### fetch

HTTP request that returns parsed JSON. Supports GET, POST, PUT, DELETE, PATCH with automatic cookie injection, retry, and backoff.

```yaml
- fetch:
    url: "https://api.example.com/v1/posts"
    method: GET                     # default
    params:
      page: 1
      limit: 20
    headers:
      Accept: "application/json"
    retry: 3                        # max retries
    backoff: exponential            # linear | exponential
```

POST with a JSON body:

```yaml
- fetch:
    url: "https://api.example.com/v1/search"
    method: POST
    body:
      query: "${{ args.query }}"
      filters:
        type: "article"
```

Template expressions (`${{ ... }}`) are evaluated at runtime. They can reference `args`, `item`, `data`, and `steps`.

### fetch_text

HTTP request that returns raw text instead of parsed JSON. Useful for HTML pages, RSS feeds, plain text APIs.

```yaml
- fetch_text:
    url: "https://example.com/feed.xml"
```

The response body is stored as a string in `ctx.data`.

### parse_rss

Parses RSS or Atom XML feed into an array of items. Typically follows a `fetch_text` step.

```yaml
- fetch_text:
    url: "https://example.com/feed.xml"
- parse_rss:
    fields: [title, link, pubDate, description]
```

Each item gets normalized fields: `title`, `link`, `pubDate`, `description`, `content`.

### html_to_md

Converts HTML content in `ctx.data` to Markdown using Turndown. Useful after `fetch_text` on web pages.

```yaml
- fetch_text:
    url: "https://example.com/article/123"
- html_to_md:
```

No configuration needed. The entire `ctx.data` string is converted.

---

## Transform Steps

### select

Navigate into a JSON path. Replaces `ctx.data` with the value at the given path.

```yaml
- select: "data.items"
```

Supports dot notation for nested objects:

```yaml
- select: "response.data.articles[0].content"
```

### map

Transform each item in an array. The result is a new array with only the mapped fields.

```yaml
- map:
    title: "${{ item.title }}"
    author: "${{ item.user.name }}"
    score: "${{ item.votes }}"
    url: "https://example.com/post/${{ item.id }}"
```

Template expressions inside `map` have access to `item` (current element), `index`, `data` (full array), and `args`.

### filter

Keep items that match a condition. The expression is evaluated for each item.

```yaml
- filter: "item.score > 100"
```

Supports standard comparison operators:

```yaml
- filter: "item.type == 'article' && item.published == true"
```

### sort

Sort an array by a field. Ascending by default.

```yaml
- sort:
    by: "score"
    order: desc          # asc | desc
```

### limit

Cap the number of results. Accepts a number directly or as a config object.

```yaml
- limit: 20
```

Or with offset:

```yaml
- limit:
    count: 20
    offset: 10
```

---

## Desktop Steps

### exec

Run a subprocess command. Captures stdout and optionally parses it as JSON.

```yaml
- exec:
    cmd: "ffprobe"
    args: ["-v", "quiet", "-print_format", "json", "-show_format", "${{ args.file }}"]
    json: true             # parse stdout as JSON
```

With environment variables:

```yaml
- exec:
    cmd: "blender"
    args: ["--background", "--python", "${{ steps.write_temp.path }}"]
    env:
      BLENDER_USER_SCRIPTS: "/path/to/scripts"
```

With stdin:

```yaml
- exec:
    cmd: "jq"
    args: [".data.items"]
    stdin: "${{ data }}"
```

With file output (read result from a file instead of stdout):

```yaml
- exec:
    cmd: "imagemagick"
    args: ["convert", "${{ args.input }}", "-resize", "800x", "/tmp/out.png"]
    file_output: "/tmp/out.png"
```

### write_temp

Create a temporary file with the given content. Returns the file path in `steps.write_temp.path`.

```yaml
- write_temp:
    ext: ".py"
    content: |
      import bpy
      bpy.ops.render.render(write_still=True)
      print("done")
- exec:
    cmd: "blender"
    args: ["--background", "--python", "${{ steps.write_temp.path }}"]
```

Useful for tools that accept script files (Blender Python, GIMP Script-Fu, Inkscape actions).

---

## Browser Steps

All browser steps require a running Chrome instance (via `unicli browser start` or the daemon).

### navigate

Navigate Chrome to a URL. Waits for the page to load.

```yaml
- navigate:
    url: "https://example.com/page"
    waitUntil: networkidle    # load | domcontentloaded | networkidle
    settleMs: 2000            # additional wait after load event
```

Short form:

```yaml
- navigate: "https://example.com/page"
```

### evaluate

Execute JavaScript in the page context. Returns the evaluation result.

```yaml
- evaluate: "document.title"
```

Multi-line scripts:

```yaml
- evaluate:
    expression: |
      const items = document.querySelectorAll('.post');
      return Array.from(items).map(el => ({
        title: el.querySelector('h2').textContent,
        url: el.querySelector('a').href
      }));
```

### click

Click an element by CSS selector.

```yaml
- click: "#submit-button"
```

With options:

```yaml
- click:
    selector: ".menu-item:nth-child(3)"
```

### type

Type text into an input element.

```yaml
- type:
    selector: "#search-input"
    text: "${{ args.query }}"
    submit: true              # press Enter after typing
```

### wait

Wait for a condition before continuing. Accepts a time (milliseconds) or a CSS selector.

```yaml
# Wait 3 seconds
- wait: 3000

# Wait for an element to appear
- wait: "#results-container"

# Wait with timeout
- wait:
    selector: ".loaded"
    timeout: 10000
```

### intercept

Capture network requests made by the page. Uni-CLI intercepts both `fetch()` and `XMLHttpRequest` calls using a stealthy dual interceptor that avoids detection.

```yaml
- intercept:
    pattern: "**/api/v1/feed"
    trigger: "scroll:down"       # action that triggers the request
    timeout: 10000               # max wait for matching request
    select: "data.items"         # extract from response JSON
```

Trigger types:

| Trigger                   | Action                              |
| ------------------------- | ----------------------------------- |
| `navigate:<url>`          | Navigate to URL and capture         |
| `scroll:down`             | Scroll down to trigger lazy loading |
| `click:<selector>`        | Click element to trigger request    |
| `wait:<ms>`               | Wait passively for the request      |

### press

Press a keyboard key with optional modifiers.

```yaml
- press: "Enter"
```

With modifiers:

```yaml
- press:
    key: "a"
    modifiers: ["Meta"]          # Cmd+A on macOS
```

### scroll

Scroll the page in a direction, to a specific element, or auto-scroll to load all content.

```yaml
# Scroll direction
- scroll: "down"                 # down | up | bottom | top

# Auto-scroll (load all lazy content)
- scroll:
    auto: true
    maxScrolls: 20
    delay: 500
```

### snapshot

Generate a DOM accessibility tree snapshot. Returns a text representation of the page structure with interactive element references.

```yaml
- snapshot:
    interactive: true            # include ref numbers for interactive elements
    compact: true                # minimal output
```

The snapshot output includes `[ref=N]` markers on interactive elements. These refs can be used with the `operate` command for precise interaction.

### tap

Vue Store Action Bridge. Triggers a Pinia or Vuex store action and captures the resulting network request.

```yaml
- tap:
    store: "useMainStore"        # Pinia store name
    action: "fetchPosts"         # action to call
    args: [{ page: 1 }]         # action arguments
    capture: "**/api/posts"      # network pattern to capture
    select: "data.list"          # extract from response
```

This is useful for Vue-based SPAs where the data loading is triggered by store actions rather than direct API calls.

---

## Media Steps

### download

Download files via HTTP or yt-dlp. Supports batch downloads, skip-existing, and progress tracking.

```yaml
- download:
    url: "${{ item.video_url }}"
    dir: "~/Downloads/videos"
    filename: "${{ item.title }}"
    skip_existing: true
```

Batch download from an array:

```yaml
- download:
    field: "url"                 # field containing the URL in each item
    dir: "~/Downloads/images"
    type: image
```

yt-dlp integration (auto-detected for video platforms):

```yaml
- download:
    url: "${{ item.url }}"
    dir: "~/Downloads"
    type: video                  # uses yt-dlp when available
```

Each item in the result gets a `_download` field with status, path, size, and duration.

---

## Service Steps

### websocket

Connect to a WebSocket server, send a message, and wait for a matching response. Supports OBS WebSocket authentication.

```yaml
- websocket:
    url: "ws://localhost:4455"
    auth: obs                    # OBS WebSocket auth handshake
    send:
      op: 6
      d:
        requestType: "GetSceneList"
        requestId: "1"
    receive:
      match: { "d.requestId": "1" }
      timeout: 5000
```

Without auth:

```yaml
- websocket:
    url: "ws://localhost:8080/events"
    send: { type: "subscribe", channel: "updates" }
    receive:
      match: { type: "data" }
```

---

## Control Steps

### set

Set a variable in the pipeline context. Useful for computed values or constants.

```yaml
- set:
    base_url: "https://api.example.com"
    page_size: 20
```

Variables are accessible via `${{ vars.base_url }}` in subsequent steps.

### if

Conditional branching. Execute different pipeline branches based on a condition.

```yaml
- if: "args.format == 'video'"
  then:
    - fetch:
        url: "https://api.example.com/videos"
    - select: "data.videos"
  else:
    - fetch:
        url: "https://api.example.com/articles"
    - select: "data.articles"
```

### append

Append the current `ctx.data` to an accumulator. Useful in loops for collecting results.

```yaml
- append: "results"
```

The accumulated data is available at `${{ vars.results }}`.

### each

Iterate over an array, executing a sub-pipeline for each item. Supports parallel execution.

```yaml
- each:
    parallel: 5                  # max concurrent
    pipeline:
      - fetch:
          url: "https://api.example.com/item/${{ item.id }}"
      - select: "data"
```

Sequential (default):

```yaml
- each:
    pipeline:
      - fetch:
          url: "https://api.example.com/item/${{ item }}"
```

### parallel

Execute multiple pipeline branches concurrently and merge results.

```yaml
- parallel:
    - pipeline:
        - fetch: { url: "https://api.example.com/hot" }
        - select: "data.items"
    - pipeline:
        - fetch: { url: "https://api.example.com/new" }
        - select: "data.items"
  merge: concat                  # concat | zip | object
```

### rate_limit

Pause execution to respect rate limits. Blocks until a token is available.

```yaml
- rate_limit:
    domain: "api.example.com"
    rpm: 30                      # requests per minute (default: 60)
```

Place this step before `fetch` calls to rate-limited APIs. The rate limiter is shared across all adapters for the same domain.

---

## Template Expressions

All step configurations support template expressions with the syntax `${{ expression }}`.

### Available Variables

| Variable   | Description                                  | Available In         |
| ---------- | -------------------------------------------- | -------------------- |
| `args`     | Command-line arguments                       | All steps            |
| `data`     | Current pipeline data                        | All steps            |
| `item`     | Current item (in `map`, `filter`, `each`)    | Iteration steps      |
| `index`    | Current iteration index                      | `map`, `each`        |
| `steps`    | Results from named steps                     | After the named step |
| `vars`     | Variables set with `set`                     | After `set`          |
| `env`      | Environment variables                        | All steps            |

### Filters

Template expressions support pipe filters:

```yaml
- map:
    title: "${{ item.title | truncate:50 }}"
    date: "${{ item.created_at | date:'YYYY-MM-DD' }}"
    slug: "${{ item.title | slugify }}"
```
