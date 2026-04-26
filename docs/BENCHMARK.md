# Uni-CLI — Per-Call Token Benchmark

> Honest measurement of the context cost of calling `unicli SITE CMD`.
> Numbers in the "Results" section below are produced by `npm run bench`
> and are reproducible in CI (fixture mode) and on a dev machine (live mode).

## Why This File Exists

Public docs previously cited a single low, round token-per-call figure.
That number conflated the length of the invocation string (roughly ten
tokens) with the size of the rendered response body, which depends on
`--limit`, output format, and the specific command. The v0.215.1 fixture
bench measures the current v2 AgentEnvelope response body at 357-415 tokens
for representative `--limit 5` list-style calls. `unicli list` is much larger
because it intentionally emits the full 223-site / 1304-command catalog.

This file replaces the retired claim. It ships real numbers or says `TODO:`
-- nothing in between.

## How We Measure

1. Build the CLI (`npm run build`) so `dist/main.js` is current.
2. Run each `(site, command)` pair at fixed inputs (default args, `--limit 5`
   unless noted). Capture stdout as JSON.
3. Tokenise the piped `stdout` via an `o200k_base` heuristic approximator
   (`bench/tokens.ts`). The heuristic matches real `tiktoken`
   counts within roughly 6-8% on English and compact JSON; rounding to
   10s of tokens is honest at this precision.
4. Record p50 and p95 across the configured number of iterations
   (`BENCH_RUNS`, default 50) of in-process tokenisation in fixture mode,
   or subprocess wall-clock in live mode.
5. Also capture the invocation-string token count (what the agent actually
   emits) for each call so the ratio `response_tokens / invocation_tokens`
   is visible.

The harness lives under `bench/` and is wired into `npm run bench`. It
has two modes:

| Mode    | Command                               | Network | Use                                                         |
| ------- | ------------------------------------- | ------- | ----------------------------------------------------------- |
| live    | `npm run bench`                       | yes     | Dev-machine sanity check, refreshes fixtures.               |
| fixture | `BENCH_FIXTURES_ONLY=1 npm run bench` | no      | CI and reproducible reports. Reads `bench/fixtures/*.json`. |

Fixture files are committed under `bench/fixtures/` alongside the scripts.
Legacy fixture payloads are normalized into the current v2 AgentEnvelope shape
before token counting, so the benchmark tracks the current public output
contract even when source fixtures predate the envelope migration.

## Results

<!-- BENCH:begin -->

> Generated 2026-04-26T10:22:10.589Z on Node v22.22.2 / darwin-arm64.
> Mode: **fixture** (50 iterations per case).
> Reproduce with `npm run bench` (local live mode) or `BENCH_FIXTURES_ONLY=1 npm run bench` (CI-deterministic fixture mode).

### Cold start: `unicli list`

| metric          | value  |
| --------------- | ------ |
| wall p50        | 726 ms |
| wall p95        | 761 ms |
| response tokens | 66272  |
| response chars  | 238579 |
| sites listed    | 223    |
| commands listed | 1304   |

### Adapter call: p50/p95 response tokens

| category  | command                                  | invocation tokens | response p50 tokens | response p95 tokens | wall p50 ms | wall p95 ms | mode    |
| --------- | ---------------------------------------- | ----------------: | ------------------: | ------------------: | ----------: | ----------: | ------- |
| news      | `unicli hackernews top --limit 5`        |                 9 |                 404 |                 404 |       0.003 |       0.006 | fixture |
| social    | `unicli reddit hot --limit 5`            |                 8 |                 415 |                 415 |       0.004 |       0.017 | fixture |
| social-cn | `unicli 36kr hot --limit 5`              |                 7 |                 357 |                 357 |       0.003 |       0.003 | fixture |
| dev       | `unicli github-trending daily --limit 5` |                11 |                 400 |                 400 |       0.004 |       0.005 | fixture |

### MCP catalog comparison

Baseline: **55,000-token** GitHub MCP cold-start. Target reduction vs. baseline: **30x**.

| category  | total tokens | reduction factor vs. 55K |
| --------- | -----------: | -----------------------: |
| news      |          413 |               **133.2x** |
| social    |          423 |                 **130x** |
| social-cn |          364 |               **151.1x** |
| dev       |          411 |               **133.8x** |

Median reduction across the suite: **133.8x**. Best: **151.1x**.
Claim "beat GitHub MCP 55K cold-start by 30x on p50" holds: **YES**.

<!-- BENCH:end -->

## Target

**Beat the GitHub MCP server's 55,000-token cold-start load by at least 30x
on p50 response size for bread-and-butter commands.** That is the bar we
measure ourselves against -- not a hand-picked best-case number.

The `mcp-catalog` bench (`bench/mcp-catalog.ts`) reports a `claim_holds:
true/false` verdict alongside the median reduction factor. If the claim
does not hold, the Results section above says so explicitly and we do not
hide the number. The honest outcome at `--limit 5` for list-style commands
is that total tokens per call (invocation + response) sit in the 300-600
range, giving a raw reduction factor around 130-151x against the 55K
baseline in the current fixture suite. This comfortably clears 30x on p50.
For commands that produce
larger payloads (paginated feeds, long transcripts) we ship a `--compact`
flag that drops null fields and single-line-JSON-formats the output.

## External Reference Points

| Interface                  | Tokens per interaction  | Source                       |
| -------------------------- | ----------------------- | ---------------------------- |
| MCP (tool defs + one call) | 320-2,800               | Firecrawl, Scalekit (2025)   |
| Raw function calling       | 150-500                 | OnlyCLI benchmark (2025)     |
| GitHub MCP server boot     | 55,000                  | 93-tool catalog registration |
| Uni-CLI `SITE CMD`         | **see `Results` above** | `bench/` harness             |

## Reproducibility

The `bench/` directory is self-contained:

- `bench/tokens.ts` — token estimator (no native deps).
- `bench/cold-start.ts` — `unicli list` cold-start runner.
- `bench/adapter-call.ts` — per-command p50/p95 runner (live or fixture mode).
- `bench/mcp-catalog.ts` — 55K comparison vs committed fixtures.
- `bench/report.ts` — orchestrator, writes `bench/results.json` and patches
  this file between `<!-- BENCH:begin -->` and `<!-- BENCH:end -->`.
- `bench/fixtures/` — captured JSON responses (rerun `npm run bench` in
  live mode to refresh; commit the diff if upstream shape changes).

`npm run bench` is **not** part of `npm run verify` because it prefers
network. CI runs it only in fixture mode, on an explicit
`workflow_dispatch` or the nightly schedule.

---

_Last reviewed: 2026-04-26._
