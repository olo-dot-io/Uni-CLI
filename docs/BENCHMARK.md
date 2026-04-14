# Uni-CLI — Per-Call Token Benchmark

> Honest measurement of the context cost of calling `unicli <site> <cmd>`.
> Numbers are currently pending — see Phase 6.3 of `v0.212 "Shatalov"`.

## Why This File Exists

Public docs previously cited a single low, round token-per-call figure.
That number conflated the length of the invocation string (roughly 80
characters) with the size of the rendered response body, which depends on
`--limit`, output format, and the specific command. The 2026-04-15 round-2
audit measured actual responses at 1,100-2,100 tokens for common calls --
well over an order of magnitude above the retired claim.

This file is the replacement. It ships real numbers or says `TODO:` --
nothing in between.

## How We Measure

1. Run each `(site, command)` pair at fixed inputs (default args, `--limit 5`
   unless noted).
2. Tokenize the piped `stdout` (JSON) with the `tiktoken` `o200k_base`
   encoder (GPT-4o family).
3. Record p50 and p95 across 10 warm runs on a gigabit network from
   `us-east` with Chrome-stealth-mode disabled.
4. Also capture the invocation-string token count (what the agent actually
   emits) for each call so the ratio `response_tokens / call_tokens` is
   visible.

The harness lives under `bench/` and is wired into `npm run bench`.

## Results

> TODO: populate via `bench/`. Landing in Phase 6.3 of v0.212 Shatalov.

| Category  | Example command                | call tokens | response p50 | response p95 |
| --------- | ------------------------------ | ----------- | ------------ | ------------ |
| news      | `unicli hackernews top`        | TODO        | TODO         | TODO         |
| social    | `unicli reddit hot`            | TODO        | TODO         | TODO         |
| social-cn | `unicli 36kr hot`              | TODO        | TODO         | TODO         |
| dev       | `unicli github-trending daily` | TODO        | TODO         | TODO         |
| shopping  | `unicli amazon search "..."`   | TODO        | TODO         | TODO         |
| desktop   | `unicli ffmpeg compress ...`   | TODO        | TODO         | TODO         |
| macos     | `unicli macos screenshot`      | TODO        | TODO         | TODO         |

## Target

**Beat the GitHub MCP server's 55,000-token cold-start load by at least 30×
on p50 response size for bread-and-butter commands.** That is the bar we
measure ourselves against -- not a hand-picked best-case number.

For commands that legitimately produce large payloads (paginated feeds,
long transcripts), we ship a `--compact` flag that:

- drops null fields
- removes common prose columns that agents rarely consume
- prints single-line JSON

`--compact` ships in Phase 6.3 alongside this benchmark.

## External Reference Points

| Interface                  | Tokens per interaction  | Source                       |
| -------------------------- | ----------------------- | ---------------------------- |
| MCP (tool defs + one call) | 320-2,800               | Firecrawl, Scalekit (2025)   |
| Raw function calling       | 150-500                 | OnlyCLI benchmark (2025)     |
| GitHub MCP server boot     | 55,000                  | 93-tool catalog registration |
| Uni-CLI `<site> <cmd>`     | **see `Results` above** | `bench/` harness (Phase 6.3) |

---

_Last reviewed: 2026-04-15 -- no measured data yet, placeholder only._
