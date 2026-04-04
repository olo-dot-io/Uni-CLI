# Uni-CLI

<!-- IF YOU ARE AN AI AGENT: Read this file. It tells you everything you need.
     Install: npm install -g unicli
     Run: unicli <site> <command> [args]
     Output is JSON when piped. Errors are structured JSON to stderr.
     You can fix broken adapters yourself — read the Self-Repair section. -->

> 57 sites, 289 commands. One CLI. `npm install -g unicli`

## For AI Agents

You are looking at a universal CLI that lets you control websites, desktop apps, and local tools. Every command returns structured JSON when piped. If a command breaks, you can read the 20-line YAML adapter, fix it, and verify — no human needed.

```bash
unicli list                        # All commands (JSON when piped)
unicli <site> <command> [options]  # Run any command
unicli repair <site> <command>     # Diagnose a broken adapter
unicli test [site]                 # Verify adapters work
```

## Install

```bash
npm install -g unicli
```

## What You Can Do

### Web (40 sites)

**Chinese**: bilibili (13), weibo (9), zhihu (7), douban (9), xueqiu (10),
linux-do (10), jike (10), zsxq (5), tieba (4), weread (7), v2ex (11)

**International**: twitter (25), youtube (5), reddit (16), hackernews (8),
bluesky (9), medium (3), substack (3), producthunt (4), lobsters (4), devto (3),
stackoverflow (4)

**Finance**: bloomberg (10), sinafinance (4), xueqiu (10)

**Reference**: google (4), wikipedia (4), arxiv (2), dictionary (3),
bbc, 36kr (4), paperreview (3), spotify, ctrip, xiaoyuzhou (3), steam, imdb (6),
github-trending, hf, web

### Desktop (14 apps)

ffmpeg (11 cmds), imagemagick (6), blender (4), gimp (3), freecad (2),
inkscape (3), pandoc, libreoffice (2), mermaid, musescore (2), drawio,
ollama, comfyui (4), docker (5)

### Bridge (3 CLIs)

gh (5 cmds), yt-dlp (4), jq (2)

## Authentication

Some sites require cookies. The engine reads cookies from `~/.unicli/cookies/<site>.json`:

```bash
unicli auth setup <site>    # Show required cookies + template
unicli auth check <site>    # Validate cookie file
unicli auth list            # List configured sites
```

Cookie file format: `{ "SESSDATA": "value", "bili_jct": "value" }`

Sites requiring auth: bilibili, weibo, zhihu, twitter, xueqiu, zsxq, jike, weread, douban, linux-do, v2ex (some commands)

## Output Protocol

- **Piped** → auto-JSON, zero flags needed
- **TTY** → human-readable table
- **Errors** → structured JSON to stderr with `adapter` path, `step`, `suggestion`
- **Exit codes**: 0=ok, 66=empty, 69=unavailable, 77=auth, 78=config

## Self-Repair Protocol

When a command fails, you can fix it:

```
1. Read error JSON → get adapter path
2. Read the YAML file (20 lines, no imports)
3. Edit the YAML (URL changed? selector moved? auth needed?)
4. Save to ~/.unicli/adapters/<site>/<command>.yaml
5. Verify: unicli repair <site> <command>
```

Fixes persist in `~/.unicli/adapters/` and survive `npm update`.

## Creating New Adapters

Drop a YAML file into `src/adapters/<site>/<command>.yaml`:

```yaml
site: example
name: search
description: Search example.com
type: web-api
strategy: public

pipeline:
  - fetch:
      url: "https://api.example.com/search"
      params:
        q: "${{ args.query }}"
  - select: data.results
  - map:
      title: "${{ item.title }}"
      url: "${{ item.url }}"
  - limit: ${{ args.limit }}

args:
  query:
    type: str
    required: true
    positional: true
  limit:
    type: int
    default: 20

columns: [title, url]
```

That's it. No TypeScript, no build step, no imports. The engine handles everything.

## Browser Automation

For sites that require a real browser (intercept/UI strategy):

```bash
unicli browser start          # Launch Chrome with CDP
unicli browser status         # Check connection
```

Requires Chrome. The engine connects via raw CDP WebSocket — zero extensions needed.

## Pipeline Steps (17)

| Step         | What it does                                     |
| ------------ | ------------------------------------------------ |
| `fetch`      | HTTP JSON (GET/POST, retry, backoff, cookies)    |
| `fetch_text` | HTTP raw text (RSS, HTML)                        |
| `parse_rss`  | Extract RSS + Atom feed items                    |
| `html_to_md` | Convert HTML to Markdown                         |
| `select`     | Navigate into JSON (`data.items`)                |
| `map`        | Transform each item via `${{ }}` templates       |
| `filter`     | Keep matching items                              |
| `sort`       | Sort by field                                    |
| `limit`      | Cap results                                      |
| `exec`       | Run subprocess (stdin, env, file output)         |
| `write_temp` | Create temp script file (for desktop adapters)   |
| `navigate`   | Navigate Chrome to URL via CDP                   |
| `evaluate`   | Execute JavaScript in page context               |
| `click`      | Click element by CSS selector                    |
| `type`       | Type text into input element                     |
| `wait`       | Wait for time (ms) or CSS selector to appear     |
| `intercept`  | Capture page network requests matching a pattern |

## Strategies

`public` → `cookie` → `header` → `intercept` → `ui`

The engine auto-probes the first three on first run. `intercept` and `ui` require explicit configuration per adapter.

## Version

0.203.0 — Vostok · Leonov
