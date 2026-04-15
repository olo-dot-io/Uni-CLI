# `bench/` — Reproducible Token and Latency Harness

Run `npm run bench` from the repo root. The harness:

1. Re-measures `unicli list` cold-start (subprocess wall-clock p50/p95).
2. Runs four adapter calls (news, social, social-cn, dev categories)
   against live endpoints, with fallback to committed fixtures if live
   fails.
3. Compares total tokens per call against the 55,000-token GitHub MCP
   cold-start baseline and reports the reduction factor.
4. Writes `bench/results.json` and patches `docs/BENCHMARK.md` between
   the `<!-- BENCH:begin -->` and `<!-- BENCH:end -->` markers.

## Modes

| Mode    | Command                               | Network | Purpose                                         |
| ------- | ------------------------------------- | ------- | ----------------------------------------------- |
| live    | `npm run bench`                       | yes     | Dev-machine truth; refreshes fixtures.          |
| fixture | `BENCH_FIXTURES_ONLY=1 npm run bench` | no      | CI-deterministic. Uses `bench/fixtures/*.json`. |

## Iterations

Set `BENCH_RUNS` to control the sample size (default 50). Smaller values
are useful during iteration; 50 is the reported number in
`docs/BENCHMARK.md`.

## Fixtures

Fixtures are real JSON responses captured on 2026-04-15 from the listed
commands at `--limit 5 -f json`. Refresh via:

```bash
npm run build
node dist/main.js hackernews top -f json --limit 5 > bench/fixtures/hackernews-top.json
# ... etc
```

Commit fixture diffs when upstream schema changes. Do not "massage" them
to make numbers prettier — the point of this harness is honest reporting.

## Not part of `npm run verify`

Bench is network-flaky and slow; it is deliberately excluded from the
default verification chain. CI runs fixture mode on `workflow_dispatch`
or the nightly schedule, both of which are separate workflows from the
verify pipeline.

## Files

- `tokens.ts` — o200k_base heuristic tokeniser (no native deps).
- `cold-start.ts` — cold-start runner for `unicli list`.
- `adapter-call.ts` — per-command p50/p95 runner.
- `mcp-catalog.ts` — 55K MCP comparison.
- `report.ts` — orchestrator, writes `results.json` and patches `docs/BENCHMARK.md`.
- `fixtures/*.json` — committed response captures.
- `results.json` — last run's full report (gitignored if you want; the
  file is tiny and helpful in PR reviews, so we commit it).
