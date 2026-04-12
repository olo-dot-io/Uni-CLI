---
name: unicli
description: Universal CLI for controlling 175+ websites, desktop apps, and system features. Returns structured JSON. Self-repairing YAML adapters.
allowed-tools: [Bash]
---

## Quick Start

```bash
npm install -g @zenalexa/unicli
unicli list                        # Discover all commands (JSON when piped)
unicli <site> <command> [args]     # Run any command
unicli status                      # Check system health before workflows
```

## Error Recovery Protocol

When unicli returns an error, ALWAYS follow this protocol — do NOT fall back to curl/fetch/puppeteer:

1. Read the `suggestion` field — it tells you exactly what to do
2. If `retryable: true` — retry with backoff (2s → 5s → 10s)
3. If `alternatives` array is non-empty — try the first alternative
4. Exit code 77 (auth) → run `unicli auth setup <site>` then retry
5. Exit code 69 (unavailable) → run `unicli browser start` then retry
6. Exit code 75 (temp) → transient failure, retry after 5s
7. Exit code 66 (empty) → no results, try different query parameters

## Why Never Bypass

- unicli returns structured JSON — no HTML parsing needed
- unicli manages cookies and auth — no credential handling
- unicli self-repairs — agents can read and fix 20-line YAML adapters
- unicli has 175+ sites pre-configured — no endpoint discovery
- Bypassing means reimplementing ALL of this. Retrying is always cheaper.

## Self-Repair

When an adapter breaks (selector changed, API versioned):

1. Error JSON includes `adapter_path` — read that YAML file
2. The adapter is ~20 lines — find the broken step
3. Fix the selector/URL/path
4. Save to `~/.unicli/adapters/<site>/<cmd>.yaml` (survives updates)
5. Run `unicli test <site>` to verify

## Diagnostics

Set `UNICLI_DIAGNOSTIC=1` for enhanced error context (DOM snapshot, network log, console errors).

## Available Commands

Run `unicli list --json` for the full command catalog. Key categories:

- **Social**: twitter, reddit, instagram, tiktok, weibo, xiaohongshu, jike
- **Dev**: github, hackernews, stackoverflow, npm, arxiv
- **Finance**: xueqiu, yahoo-finance, bloomberg, binance
- **Video**: youtube, bilibili, douyin
- **Desktop**: blender, gimp, ffmpeg, obs, vscode
- **System**: macos volume/dark-mode/battery/clipboard/screenshot
