# Uni-CLI — Agent-Native Command Budget

> Honest measurement of the context budget behind `unicli SITE CMD`.
> Numbers in the "Results" section below are produced by `npm run bench`
> and are reproducible in CI fixture mode and on a dev machine in live mode.

## Why This File Exists

Agent-native infrastructure should publish real cost numbers. Uni-CLI measures
both the command invocation and the response body so public claims stay tied to
the current code, fixtures, and output contract.

The v0.217.0 fixture bench measures current v2 `AgentEnvelope` response bodies
at **357-415 tokens** for representative `--limit 5` list-style calls. Total
invocation-plus-response budgets land at **364-423 tokens** in the same suite.
`unicli list` is much larger because it intentionally emits the full
235-site / 1448-command catalog.

This file ships real numbers or says `TODO:` -- nothing in between.

## How We Measure

1. Build the CLI (`npm run build`) so `dist/main.js` is current.
2. Run each `(site, command)` pair at fixed inputs (default args, `--limit 5`
   unless noted). Capture stdout as JSON.
3. Tokenise the piped `stdout` via an `o200k_base` heuristic approximator
   (`bench/tokens.ts`). The heuristic matches real `tiktoken` counts within
   roughly 6-8% on English and compact JSON; rounding to tens of tokens is
   honest at this precision.
4. Record p50 and p95 across the configured number of iterations
   (`BENCH_RUNS`, default 50) of in-process tokenisation in fixture mode, or
   subprocess wall-clock in live mode.
5. Also capture the invocation-string token count so the agent-side command cost
   is visible.

The harness lives under `bench/` and is wired into `npm run bench`.

| Mode    | Command                               | Network | Use                                                         |
| ------- | ------------------------------------- | ------- | ----------------------------------------------------------- |
| live    | `npm run bench`                       | yes     | Dev-machine sanity check, refreshes fixtures.               |
| fixture | `BENCH_FIXTURES_ONLY=1 npm run bench` | no      | CI and reproducible reports. Reads `bench/fixtures/*.json`. |

Fixture files are committed under `bench/fixtures/` alongside the scripts.
Legacy fixture payloads are normalized into the current v2 `AgentEnvelope` shape
before token counting, so the benchmark tracks the current public output
contract even when source fixtures predate the envelope migration.

## Results

<!-- BENCH:begin -->

> Generated 2026-04-27T04:36:49.364Z on Node v22.22.2 / darwin-arm64.
> Mode: **fixture** (20 iterations per case).
> Reproduce with `npm run bench` (local live mode) or `BENCH_FIXTURES_ONLY=1 npm run bench` (CI-deterministic fixture mode).

### Cold start: `unicli list`

| metric          | value  |
| --------------- | ------ |
| wall p50        | 38 ms  |
| wall p95        | 44 ms  |
| response tokens | 73242  |
| response chars  | 263668 |
| sites listed    | 235    |
| commands listed | 1448   |

### Adapter call: p50/p95 response tokens

| category  | command                                  | invocation tokens | response p50 tokens | response p95 tokens | wall p50 ms | wall p95 ms | mode    |
| --------- | ---------------------------------------- | ----------------: | ------------------: | ------------------: | ----------: | ----------: | ------- |
| news      | `unicli hackernews top --limit 5`        |                 9 |                 404 |                 404 |       0.004 |       0.073 | fixture |
| social    | `unicli reddit hot --limit 5`            |                 8 |                 415 |                 415 |       0.005 |       0.011 | fixture |
| social-cn | `unicli 36kr hot --limit 5`              |                 7 |                 357 |                 357 |       0.003 |       0.005 | fixture |
| dev       | `unicli github-trending daily --limit 5` |                11 |                 400 |                 400 |       0.005 |       0.007 | fixture |

### Public call budget

| metric                             | value          |
| ---------------------------------- | -------------- |
| Smallest total call budget         | 364 tokens     |
| Largest total call budget          | 423 tokens     |
| Median total call budget           | 412 tokens     |
| Representative response token span | 357-415 tokens |

<!-- BENCH:end -->

## Public Budget

The public operating target is straightforward:

- common list-style calls should stay under **600 total tokens** at `--limit 5`;
- failure envelopes should stay compact enough for an agent to repair without
  loading unrelated documentation;
- full-catalog output should remain explicit, not automatic.

The current fixture suite clears that bar. If a future command class needs a
larger payload, it should expose pagination, `--limit`, or `--compact`.

## Reproducibility

The `bench/` directory is self-contained:

- `bench/tokens.ts` — token estimator (no native deps).
- `bench/cold-start.ts` — `unicli list` cold-start runner.
- `bench/adapter-call.ts` — per-command p50/p95 runner (live or fixture mode).
- `bench/report.ts` — orchestrator, writes `bench/results.json` and patches
  this file between `<!-- BENCH:begin -->` and `<!-- BENCH:end -->`.
- `bench/fixtures/` — captured JSON responses (rerun `npm run bench` in live
  mode to refresh; commit the diff if upstream shape changes).

`npm run bench` is **not** part of `npm run verify` because it prefers network.
CI runs it only in fixture mode, on an explicit workflow dispatch or a scheduled
maintenance check.

---

_Last reviewed: 2026-04-28._
