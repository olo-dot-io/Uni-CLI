# Reproducible token and latency harness

Run `npm run bench` from the repository root. The harness performs these steps.

1. Re-measures root `--version`, root `--help`, and `unicli list` as separate
   cold subprocess boundaries (wall-clock p50/p95).
2. Runs four adapter calls (news, social, social-cn, dev categories)
   against live endpoints, with fallback to committed fixtures if live
   fails.
3. Reports invocation tokens, response tokens, and total call budgets.
4. Writes `bench/results.json` and patches `docs/BENCHMARK.md` between
   the `<!-- BENCH:begin -->` and `<!-- BENCH:end -->` markers.

Run `npm run bench:product-surface` to measure user-visible discovery,
actionability, personalized content coverage, generated catalog consistency,
and the pinned OpenCLI and CLI-Anything source snapshots. The command writes
`bench/product-surface-results.json` and refreshes the matching English and
Chinese documentation sections.

## Modes

| Mode    | Command                               | Network | Purpose                                         |
| ------- | ------------------------------------- | ------- | ----------------------------------------------- |
| live    | `npm run bench`                       | yes     | Dev-machine truth; refreshes fixtures.          |
| fixture | `BENCH_FIXTURES_ONLY=1 npm run bench` | no      | CI-deterministic. Uses `bench/fixtures/*.json`. |

Fixture adapter timings measure in-process parsing/tokenisation, not CLI
startup. Live adapter timings use real subprocess/network calls. Every startup
sample launches a new Node process; persistent MCP/Browser Runtime Broker warm latency
is not measured or inferred by this harness.

## Iterations

Set `BENCH_RUNS` to control the sample size (default 50). Smaller values
are useful during iteration; 50 is the reported number in
`docs/BENCHMARK.md`.

## Fixtures

Fixtures are real JSON responses captured on 2026-04-15 from the listed
commands at `--limit 5 -f json`. Refresh them with the following commands.

```bash
npm run build
node dist/main.js hackernews top -f json --limit 5 > bench/fixtures/hackernews-top.json
# ... etc
```

Commit fixture diffs when upstream schema changes. Keep the captured values
unchanged so the report stays honest.

## Verification boundary

The latency and adapter response suite can use live network calls, so it stays
outside the default verification command. `npm run verify` runs
`bench:product-surface:check`, which is network-free and does not rewrite
generated reports.

## Files

- `tokens.ts` provides the o200k_base heuristic tokeniser with no native dependencies.
- `cold-start.ts` runs cold processes for root metadata and `unicli list`.
- `adapter-call.ts` runs each p50 and p95 command sample.
- `report.ts` writes `results.json` and patches `docs/BENCHMARK.md`.
- `product-surface.ts` runs discovery tasks, catalog checks, and current source comparisons.
- `product-baselines.json` pins current-source revisions and catalog counts.
- `product-surface-results.json` stores the last generated product-surface report.
- `fixtures/*.json` contains committed response captures.
- `results.json` contains the last full report. It can remain committed because the
  file is tiny and helpful in PR reviews, so we commit it).
