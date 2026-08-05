---
title: Benchmarks
description: Reproducible startup, catalog-size, and response-budget measurements for Uni-CLI.
---

# Benchmarks

The benchmark suite measures costs an agent sees directly: cold CLI startup, full-catalog size, and representative operation response size.

## Run the suite

```bash
npm run bench
```

Use fixture mode for deterministic CI output:

```bash
BENCH_FIXTURES_ONLY=1 npm run bench
```

Each root CLI measurement starts a new process. Adapter fixture timing covers in-process parsing and formatting. Live mode adds the subprocess and network path used by the command.

## Latest generated results

<!-- BENCH:begin -->

> Generated 2026-07-12T12:08:20.122Z on Node v22.23.1 / darwin-arm64.
> Mode: **fixture** (50 iterations per case).
> Reproduce with `npm run bench` (local live mode) or `BENCH_FIXTURES_ONLY=1 npm run bench` (CI-deterministic fixture mode).

### Cold-process CLI startup

| command boundary      | wall p50 | wall p95 | evidence class                         |
| --------------------- | -------: | -------: | -------------------------------------- |
| `unicli --version`    |    22 ms |    24 ms | new subprocess, constant metadata path |
| `unicli --help`       |    20 ms |    23 ms | new subprocess, concise root help      |
| `unicli list -f json` |   114 ms |   122 ms | new subprocess, manifest fast path     |

### Full catalog response size

| metric                                | value  |
| ------------------------------------- | ------ |
| response tokens                       | 109102 |
| response chars                        | 392766 |
| distinct site labels in `list` output | 329    |
| command rows in `list` output         | 1845   |

### Adapter call: p50/p95 response tokens

| category  | command                                  | invocation tokens | response p50 tokens | response p95 tokens | wall p50 ms | wall p95 ms | mode    |
| --------- | ---------------------------------------- | ----------------: | ------------------: | ------------------: | ----------: | ----------: | ------- |
| news      | `unicli hackernews top --limit 5`        |                 9 |                 404 |                 404 |       0.003 |       0.005 | fixture |
| social    | `unicli reddit hot --limit 5`            |                 8 |                 415 |                 415 |       0.003 |       0.004 | fixture |
| social-cn | `unicli 36kr hot --limit 5`              |                 7 |                 357 |                 357 |       0.003 |       0.003 | fixture |
| dev       | `unicli github-trending daily --limit 5` |                11 |                 400 |                 400 |       0.004 |       0.004 | fixture |

### Public call budget

| metric                             | value          |
| ---------------------------------- | -------------- |
| Smallest total call budget         | 364 tokens     |
| Largest total call budget          | 423 tokens     |
| Median total call budget           | 412 tokens     |
| Representative response token span | 357-415 tokens |

<!-- BENCH:end -->

## Reading the results

- `unicli --help` and `unicli --version` measure the smallest process startup paths.
- `unicli list -f json` measures catalog loading and serialization.
- Adapter cases use `--limit 5`, which reflects a common agent retrieval call.
- Full catalog output is available on request; search and describe provide the smaller everyday path.

The public response target for common list operations is 600 total tokens or less at `--limit 5`. Commands with larger results should expose a limit, pagination, or compact output.

## Files

| File                    | Purpose                               |
| ----------------------- | ------------------------------------- |
| `bench/cold-start.ts`   | Root command process timing           |
| `bench/adapter-call.ts` | Representative operation measurements |
| `bench/tokens.ts`       | Token estimator                       |
| `bench/report.ts`       | Report generation                     |
| `bench/fixtures/`       | Deterministic response fixtures       |

The report command writes `bench/results.json` and updates the generated section on this page.
