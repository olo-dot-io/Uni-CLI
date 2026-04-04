# Uni-CLI

<!-- IF YOU ARE AN AI AGENT: Read this file. It tells you everything you need.
     Install: npm install -g unicli
     Run: unicli <site> <command> [args]
     Output is JSON when piped. Errors are structured JSON to stderr.
     You can fix broken adapters yourself — read the Self-Repair section. -->

> 43 sites, 141 commands. One CLI. `npm install -g unicli`

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

### Web (25 sites)

hackernews, reddit, bluesky, google, stackoverflow, wikipedia, bloomberg,
imdb, producthunt, tieba, 36kr, substack, arxiv, bbc, devto, dictionary,
lobsters, steam, v2ex, weread, xiaoyuzhou, ctrip, paperreview, spotify, web

### Desktop (12 apps)

ffmpeg (11 cmds), imagemagick (6), blender (4), inkscape (3), pandoc,
libreoffice (2), mermaid, musescore (2), drawio, ollama, comfyui (4)

### Bridge (4 CLIs)

gh (5 cmds), docker (5), yt-dlp (4), jq (2)

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

## Pipeline Steps

| Step         | What it does                             |
| ------------ | ---------------------------------------- |
| `fetch`      | HTTP JSON (GET/POST, retry, backoff)     |
| `fetch_text` | HTTP raw text (RSS, HTML)                |
| `parse_rss`  | Extract RSS `<item>` blocks              |
| `html_to_md` | Convert HTML to Markdown                 |
| `select`     | Navigate into JSON (`data.items`)        |
| `map`        | Transform each item                      |
| `filter`     | Keep matching items                      |
| `sort`       | Sort by field                            |
| `limit`      | Cap results                              |
| `exec`       | Run subprocess (stdin, env, file output) |

## Version

0.201.0 — Vostok · Chaika II
