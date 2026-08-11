---
title: Benchmarks
description: Reproducible startup, catalog-size, and response-budget measurements for Uni-CLI.
---

# Benchmarks

The benchmark suite measures cold CLI startup, full-catalog size, and representative operation response size as an agent sees them.

## Run the suite

```bash
npm run bench
```

Use fixture mode for deterministic CI output.

```bash
BENCH_FIXTURES_ONLY=1 npm run bench
```

Each root CLI measurement starts a new process. Adapter fixture timing covers in-process parsing and formatting. Live mode adds the subprocess and network path used by the command.

## Latest generated results

<!-- BENCH:begin -->

> Generated 2026-08-10 on Node v24.18.0 / darwin-arm64.
> Mode **fixture** (50 iterations per case).
> Reproduce with `npm run bench` (local live mode) or `BENCH_FIXTURES_ONLY=1 npm run bench` (CI-deterministic fixture mode).

### Cold-process CLI startup

| command boundary      | wall p50 | wall p95 | evidence class                         |
| --------------------- | -------- | -------- | -------------------------------------- |
| `unicli --version`    | 24 ms    | 26 ms    | new subprocess, constant metadata path |
| `unicli --help`       | 24 ms    | 25 ms    | new subprocess, concise root help      |
| `unicli list -f json` | 260 ms   | 282 ms   | new subprocess, manifest fast path     |

### Full catalog response size

| metric                                | value  |
| ------------------------------------- | ------ |
| response tokens                       | 135751 |
| response chars                        | 488703 |
| distinct site labels in `list` output | 347    |
| command rows in `list` output         | 1997   |

### Adapter call p50 and p95 response tokens

| category  | command                                  | invocation tokens | response p50 tokens | response p95 tokens | wall p50 ms | wall p95 ms | mode    |
| --------- | ---------------------------------------- | ----------------- | ------------------- | ------------------- | ----------- | ----------- | ------- |
| news      | `unicli hackernews top --limit 5`        | 9                 | 404                 | 404                 | 0.003       | 0.009       | fixture |
| social    | `unicli reddit hot --limit 5`            | 8                 | 415                 | 415                 | 0.005       | 0.007       | fixture |
| social-cn | `unicli 36kr hot --limit 5`              | 7                 | 357                 | 357                 | 0.003       | 0.004       | fixture |
| dev       | `unicli github-trending daily --limit 5` | 11                | 400                 | 400                 | 0.004       | 0.005       | fixture |

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

<!-- PRODUCT-SURFACE:begin -->

## Current product surface comparison

The comparison keeps each product inside its declared boundary. Catalog totals measure breadth. The Uni-CLI task suite measures whether a user can find and prepare an operation from the shipped command line.

| Product                                               | Source revision                                                                                                 | Declared surface                               | Current scale                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| Uni-CLI                                               | working tree on 2026-08-11                                                                                      | web, browser, desktop, system, and local tools | 337 sites and 1890 commands                                             |
| [OpenCLI](https://github.com/jackwener/opencli)       | [a86d647](https://github.com/jackwener/opencli/blob/a86d64705c526dc710f790e66cfcabf6ecf786b9/cli-manifest.json) | website and browser adapter runtime            | 176 sites and 1331 commands                                             |
| [CLI-Anything](https://github.com/HKUDS/CLI-Anything) | [39634a6](https://github.com/HKUDS/CLI-Anything/blob/39634a640cf20bc603b4faae4d31069c44821a9a/registry.json)    | stateful harnesses and capability matrices     | 79 harnesses, 22 public entries, 5 matrices, and 62 matrix capabilities |

The shared personal-content classifier omits generic identity commands such as `whoami`. Uni-CLI exposes more matching content commands. OpenCLI currently spans more matching sites.

| Personal content surface | Uni-CLI | OpenCLI |
| ------------------------ | ------- | ------- |
| commands                 | 80      | 78      |
| sites                    | 38      | 44      |

### Shipped discovery tasks

Uni-CLI completed 14/14 tasks at rank one. 14/14 top results included an invocation, inspection command, and required authentication setup. Personalized tasks completed 5/5.

| Task                    | Expected                | Top result              | Actionable |
| ----------------------- | ----------------------- | ----------------------- | ---------- |
| news-top                | `hackernews top`        | `hackernews top`        | yes        |
| developer-trending      | `github-trending daily` | `github-trending daily` | yes        |
| developer-code-search   | `gh search-code`        | `gh search-code`        | yes        |
| media-playback          | `spotify play-track`    | `spotify play-track`    | yes        |
| auth-setup              | `auth setup`            | `auth setup`            | yes        |
| cli-upgrade             | `upgrade install`       | `upgrade install`       | yes        |
| harness-evolution       | `evolve adapter`        | `evolve adapter`        | yes        |
| evolution-evidence      | `runs distill`          | `runs distill`          | yes        |
| agent-plugin-inspection | `plugin inspect`        | `plugin inspect`        | yes        |
| xiaohongshu-saved       | `xiaohongshu saved`     | `xiaohongshu saved`     | yes        |
| instagram-saved         | `instagram saved`       | `instagram saved`       | yes        |
| zhihu-recommendations   | `zhihu recommend`       | `zhihu recommend`       | yes        |
| twitter-notifications   | `twitter notifications` | `twitter notifications` | yes        |
| bilibili-history        | `bilibili history`      | `bilibili history`      | yes        |

### Maintenance gates

- Root discovery entry coverage 6/6
- Generated catalog synchronization pass
- OpenCLI pinned baseline integrity pass
- Personal content command parity pass
- Product surface gate pass

Reproduce this section with `npm run bench:product-surface`.

<!-- PRODUCT-SURFACE:end -->

## Files

| File                       | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `bench/cold-start.ts`      | Root command process timing                                |
| `bench/adapter-call.ts`    | Representative operation measurements                      |
| `bench/tokens.ts`          | Token estimator                                            |
| `bench/report.ts`          | Report generation                                          |
| `bench/product-surface.ts` | Discovery, personalization, and current product comparison |
| `bench/fixtures/`          | Deterministic response fixtures                            |

The report command writes `bench/results.json` and updates the generated section on this page.
