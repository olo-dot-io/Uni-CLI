# Uni-CLI Architecture — Agent-Always-First

> CLI (Bash) is all agents need.

## What Uni-CLI Is

Uni-CLI is the entry point for AI agents to touch, sense, understand, modify, and control:

- **Any internet application** — via Chrome (cookies, intercept, operate)
- **Any local software** — via subprocess (blender, ffmpeg, libreoffice)
- **Any cloud service** — via REST API (ollama, comfyui, zoom)
- **Any existing CLI** — via bridge passthrough (gh, docker, vercel)

We are not a scraper. We are not a product. We are **agent infrastructure** — the stable execution layer that makes individual operations reliable enough to compose into long-chain workflows.

## Why CLI, Not MCP

| Factor       | CLI (Bash)                      | MCP                                              |
| ------------ | ------------------------------- | ------------------------------------------------ |
| Context cost | Measured in docs/BENCHMARK.md   | 550-1,400 tokens/tool definition                 |
| Startup      | Zero (process per call)         | Server must be running                           |
| Composition  | Unix pipes (`\|`, `xargs`)      | No native composition                            |
| Discovery    | `unicli list` + `unicli search` | All tools registered upfront (72% context eaten) |
| Universality | Every agent has Bash            | MCP support varies                               |
| Self-repair  | Agent edits YAML, re-runs       | Agent can't edit MCP server code                 |

MCP is optional for IDE integration. CLI through Bash is the primary execution path.

## The Self-Repair Loop

This is why Uni-CLI exists. Not the adapter count. Not the CLI UX. **The ability for agents to fix their own tools.**

```
Agent calls: unicli SITE COMMAND
  │
  ├─ Success → structured envelope to stdout → done
  │
  └─ Failure → structured error JSON to stderr:
       {
         "error": "HTTP 403 Forbidden",
         "adapter": "src/adapters/twitter/search.yaml",
         "step": 0,
         "action": "fetch",
         "url": "https://...",
         "suggestion": "API requires cookie auth."
       }
       │
       Agent reads adapter file (20 lines YAML, fits any context)
       │
       Agent edits YAML (fix URL, selector, params, strategy)
       │
       Agent saves to ~/.unicli/adapters/SITE/COMMAND.yaml
       │
       Agent retries: unicli SITE COMMAND
       │
       Agent verifies: unicli test SITE
       │
       Fixed. Local override persists across npm updates.
```

### Why Self-Healing Requires All Five

| Requirement                         | Traditional CLIs               | Uni-CLI                               |
| ----------------------------------- | ------------------------------ | ------------------------------------- |
| Structured errors with adapter path | ❌ Human-readable strings      | ✅ JSON with path + step + suggestion |
| Agent can find adapter file         | ❌ Buried in node_modules      | ✅ Path in error output               |
| Agent can read adapter              | ❌ 100+ line code with imports | ✅ 20-line YAML, zero imports         |
| Agent fix survives update           | ❌ Package update overwrites   | ✅ ~/.unicli/adapters/ overlay        |
| Agent can verify fix                | ❌ No test command             | ✅ unicli repair + unicli test        |

All five must be true for the self-healing loop to close.

## Five Adapter Types

```
┌─────────────────────────────────────────────────────────────────┐
│                         Uni-CLI                                  │
│                                                                  │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌─────────────────┐  │
│  │  web-api  │ │  desktop  │ │  browser  │ │     bridge      │  │
│  │           │ │           │ │           │ │                 │  │
│  │ HTTP/JSON │ │ subprocess│ │ Chrome    │ │ passthrough to  │  │
│  │ fetch     │ │ exec      │ │ extension │ │ existing CLIs   │  │
│  └───────────┘ └───────────┘ └───────────┘ └─────────────────┘  │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  service: local REST APIs (ollama, comfyui, adguardhome)    │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

| Type    | Runtime              | Auth                     | Example                       |
| ------- | -------------------- | ------------------------ | ----------------------------- |
| web-api | HTTP fetch           | public / cookie / header | hackernews, twitter, bilibili |
| desktop | child_process        | none                     | blender, ffmpeg, gimp         |
| browser | Chrome Extension CDP | cookie / intercept / ui  | xiaohongshu, taobao           |
| bridge  | passthrough exec     | varies                   | gh, docker, vercel            |
| service | HTTP to localhost    | none / apikey            | ollama, comfyui               |

## Pipeline Engine

YAML adapters declare a pipeline of steps:

```yaml
pipeline:
  - fetch: { url: "..." } # HTTP GET/POST → JSON
  - fetch_text: { url: "..." } # HTTP → raw text (XML/RSS/HTML)
  - parse_rss: ~ # Extract item blocks from XML
  - select: "data.items" # Navigate into nested object
  - map: { title: "${{ ... }}" } # Transform each item
  - filter: "item.score > 10" # Keep matching items
  - sort: { by: score, order: desc }
  - limit: ${{ args.limit }} # Cap results
  - exec: { command: "ffmpeg", args: [...] } # Run subprocess
```

Template syntax: `${{ expression }}` with JS evaluation.
Pipe filters: `${{ item.tags | join(', ') }}`, `${{ args.q | urlencode }}`

## Adapter Overlay System

```
Discovery order (later overrides earlier):
  1. src/adapters/SITE/           ← built-in (ships with npm)
  2. ~/.unicli/adapters/SITE/     ← user/agent fixes (persistent)
  3. .unicli/adapters/SITE/       ← project-local (future)
```

When an agent fixes an adapter, the fix goes to `~/.unicli/adapters/`. This means:

- Fix survives `npm update unicli`
- Fix is local to the user (not a PR)
- Multiple fixes can coexist
- `unicli test` validates the fix

## Multi-Surface Presence

```
                    YAML Adapters
                   (source of truth)
                         │
           ┌─────────────┼─────────────┐
           │             │             │
      CLI Binary    MCP Server     Skills
     (execution)   (IDE optional)  (teaching)
           │             │             │
      Bash tool     settings.json  Skill tool
     in any agent   in Claude/     in Claude
                    Cursor          Code
```

All three surfaces are generated from the same YAML adapters. No duplication.

## Agent Output Protocol

### Success (stdout)

```bash
unicli hackernews top -f json  # explicit
unicli hackernews top | jq     # auto-JSON when piped
```

### Failure (stderr)

```json
{
  "error": "HTTP 403 Forbidden",
  "adapter": "src/adapters/hackernews/top.yaml",
  "step": 0,
  "action": "fetch",
  "errorType": "http_error",
  "url": "https://hacker-news.firebaseio.com/v0/topstories.json",
  "statusCode": 403,
  "suggestion": "The API is blocking requests. The endpoint may require authentication (cookie strategy) or the User-Agent may need updating."
}
```

### Exit Codes (sysexits.h)

```
0  = success
1  = generic error
2  = usage error (bad args)
66 = empty result (query matched nothing)
69 = service unavailable
75 = temporary failure (retry later)
77 = authentication required
78 = configuration error
```

## Future: Operate → Compile

The ultimate vision (v0.4+):

```
1. Agent needs to do something on a new site
2. No adapter exists → agent uses browser automation (operate)
3. System records HTTP requests during operate
4. Agent writes YAML adapter from observed API pattern
5. Next time → YAML runs directly (100x faster, deterministic)
```

This is JIT compilation for agent behaviors. First run interpreted (slow), subsequent runs compiled (fast).
