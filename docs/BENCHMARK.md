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

> Generated 2026-10-10 on Node v26.11.1 / darwin-arm64.
> Mode **fixture** (50 iterations per case).
> Reproduce with `npm run bench` (local live mode) or `BENCH_FIXTURES_ONLY=1 npm run bench` (CI-deterministic fixture mode).

### Cold-process CLI startup

| command boundary      | wall p50 | wall p95 | evidence class                         |
| --------------------- | -------- | -------- | -------------------------------------- |
| `unicli --version`    | 29 ms    | 31 ms    | new subprocess, constant metadata path |
| `unicli --help`       | 28 ms    | 31 ms    | new subprocess, concise root help      |
| `unicli list -f json` | 231 ms   | 244 ms   | new subprocess, manifest fast path     |

### Full catalog response size

| metric                                | value  |
| ------------------------------------- | ------ |
| response tokens                       | 136947 |
| response chars                        | 493006 |
| distinct site labels in `list` output | 349    |
| command rows in `list` output         | 2011   |

### Adapter call p50 and p95 response tokens

| category  | command                                  | invocation tokens | response p50 tokens | response p95 tokens | wall p50 ms | wall p95 ms | mode    |
| --------- | ---------------------------------------- | ----------------- | ------------------- | ------------------- | ----------- | ----------- | ------- |
| news      | `unicli hackernews top --limit 5`        | 9                 | 404                 | 404                 | 0.003       | 0.006       | fixture |
| social    | `unicli reddit hot --limit 5`            | 8                 | 415                 | 415                 | 0.004       | 0.006       | fixture |
| social-cn | `unicli 36kr hot --limit 5`              | 7                 | 357                 | 357                 | 0.003       | 0.003       | fixture |
| dev       | `unicli github-trending daily --limit 5` | 11                | 400                 | 400                 | 0.004       | 0.004       | fixture |

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

## Local ranking against strong baselines

Measured on 2026-10-10 with Node 26.11.1 on an Apple M4 Pro. Every method receives the same 2,014 built-in and core command documents, including 2,011 discoverable documents. Host inventory and user overlays are disabled for all methods. The frozen comparison uses the complete `a3ccd598` source tree.

```bash
npm run build
BENCH_RUNS=5 BENCH_COLD_RUNS=9 npm run bench:search
```

The historical set contains 617 positive and 26 negative queries. A separate 32-query set covers academic providers, model lookup, topical boundaries, and explicit sources, with four additional no-match queries. The 32 cases were used to diagnose and repair ranking failures and remain a diagnostic set. Their post-fix score measures those cases; an unseen-test estimate requires a separate holdout.

| Method                     | Historical Top-1 | Top-3   | Top-5   | MRR@5  | Diagnostic Top-1 | Resident p50 ms | Resident p95 ms |
| -------------------------- | ---------------- | ------- | ------- | ------ | ---------------- | --------------- | --------------- |
| Frozen Uni-CLI `a3ccd598`  | 482/617          | 556/617 | 577/617 | 0.8444 | 20/32            | 0.057           | 0.228           |
| Current Uni-CLI            | 482/617          | 556/617 | 577/617 | 0.8444 | 26/32            | 0.052           | 0.191           |
| BM25                       | 443/617          | 533/617 | 560/617 | 0.7913 | 19/32            | 0.020           | 0.083           |
| TF-IDF cosine              | 454/617          | 544/617 | 566/617 | 0.8129 | 16/32            | 0.018           | 0.080           |
| MiniSearch 7.2.0 BM25+     | 429/617          | 512/617 | 553/617 | 0.7678 | 15/32            | 0.043           | 0.172           |
| MiniSearch BM25+ fuzzy 0.2 | 409/617          | 521/617 | 559/617 | 0.7581 | 13/32            | 0.153           | 0.456           |

Resident samples interleave all methods over 3,395 queries per method. The full routers include query analysis, intent routing, scoring, top-five selection, and result shaping. Lexical baselines use the same frozen bilingual tokenization and alias expansion. BM25 uses `k1=1.2, b=0.75`; MiniSearch uses its shipped BM25+ defaults with exact matching and the documented fuzzy preset. Parameters remain fixed throughout the comparison.

The current router preserves the historical results and resolves six source-versus-topic failures in the diagnostic set. Six diagnostic cases miss rank one, including one outside the top five. Raw misses and negative-query scores remain in `bench/search-baselines.results.json`. Score scales are method-specific. Pure lexical retrieval spends less time per query; the full router achieves higher Top-1 accuracy on these sets.

### Separate cold boundary

Nine fresh processes per full router include ESM import, index construction, and the first query. Baseline and current median process times are 83.823 ms and 82.790 ms. Median ready times are 50.160 ms and 48.659 ms. These samples exclude CLI argument parsing and host inventory. The cold CLI measurements above retain their own boundary. The report's single in-process build sample is descriptive; repeated cold samples provide the build comparison.

## Resident evidence-relevance scoring

`npm run bench:relevance` compares the evidence scorer with the fixed `9634121c` source. On Apple M4 Pro, darwin-arm64, and Node 26.11.1, nine alternating rounds measured batches of 10,000 `scoreRetrievalAlternatives` calls. The median batch took 31.5234 ms for the baseline and 18.4456 ms for the current scorer, a 1.709× ratio.

```bash
npm run bench:relevance
```

The fixed workload combines 20 queries with 500 constructed records, including multilingual text, punctuation, alternatives, empty input, and overlapping terms. Complete-result comparisons cover both values of `requireAllTerms`. All 20,000 comparisons matched. Each implementation receives one warm-up batch before the alternating measurements.

The measured call includes field normalization, term matching, scoring, and alternative selection. Query analyses are prepared once. Process startup, module loading, network requests, and file I/O are outside this timing boundary. These results establish the scorer's behavior and cost on the fixed workload; end-to-end source retrieval has separate network and acquisition costs. Raw samples and environment details are in `bench/retrieval-relevance.results.json`.

## Live representation and provider measurements

Measured on 2026-10-10 using `npm run bench:internet`. Byte counts refer to decoded UTF-8 bodies. Network compression, connection setup, origin caches, and remote load retain their own effects.

| Source and request                           | Baseline body bytes  | Native body bytes  | Reduction | Samples                               |
| -------------------------------------------- | -------------------- | ------------------ | --------- | ------------------------------------- |
| Cloudflare Markdown-for-agents documentation | 175,685 HTML         | 16,408 Markdown    | 90.66%    | Three per representation, interleaved |
| OpenRouter `gpt-5` model lookup, limit two   | 765,940 full catalog | 3,349 native query | 99.56%    | One per request path                  |

Cloudflare total HTTP-plus-conversion medians were 219.557 ms for HTML and 193.453 ms for native Markdown. The first HTML request-and-conversion sample took 6,768.108 ms. The raw report keeps that sample. Native Markdown carries source metadata and content formatting that differ from local HTML extraction.

OpenRouter returned 458 catalog records and two native-query records. Both paths selected the same two model IDs in this run. The recorded request times were 7,111.872 ms and 165.383 ms. One sample per path supports this payload observation. A general network speedup needs repeated, controlled measurements.

The [Internet access guide](/guide/internet-access) describes the implemented route, cache, and recovery contracts. These measurements cover local discovery and selected HTTP endpoints. Hosted Exa and Context7 retrieval quality remains unmeasured by this suite.

<!-- PRODUCT-SURFACE:begin -->

## Current product surface comparison

The comparison keeps each product inside its declared boundary. Catalog totals measure breadth. The Uni-CLI task suite measures whether a user can find and prepare an operation from the shipped command line.

| Product                                               | Source revision                                                                                                 | Declared surface                               | Current scale                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| Uni-CLI                                               | working tree on 2026-10-10                                                                                      | web, browser, desktop, system, and local tools | 338 sites and 1893 commands                                             |
| [OpenCLI](https://github.com/jackwener/opencli)       | [77af6bc](https://github.com/jackwener/opencli/blob/77af6bc433c1818a4abb1c8928e2a7fd0bbae376/cli-manifest.json) | website and browser adapter runtime            | 169 sites and 1215 commands                                             |
| [CLI-Anything](https://github.com/HKUDS/CLI-Anything) | [34f5195](https://github.com/HKUDS/CLI-Anything/blob/34f519533bc175d2fe287ab8316b0dd99bb9cc43/registry.json)    | stateful harnesses and capability matrices     | 79 harnesses, 24 public entries, 5 matrices, and 62 matrix capabilities |

The shared personal-content classifier omits generic identity commands such as `whoami`. The table reports current counts with the same classifier. Coverage comparisons are observations; the maintenance gate checks executable tasks and catalog consistency.

| Personal content surface | Uni-CLI | OpenCLI |
| ------------------------ | ------- | ------- |
| commands                 | 80      | 81      |
| sites                    | 38      | 47      |

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
- Personal content command parity below the comparison baseline
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
