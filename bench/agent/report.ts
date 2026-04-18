/**
 * ICS-ASR-SED bench report — computes ICS for a representative corpus of
 * invocations across the four buckets, emits a deterministic JSON report
 * so the quantitative hypothesis can be evaluated at each release.
 *
 * This is the "quick" local-only variant. It does not call any LLM; it
 * only proves that the invocation-complexity axis has been properly
 * measured. The "full" variant (driving Claude SDK to measure actual
 * ASR / SED) lives in bench/agent/sdk-runner.ts and is opt-in because
 * each run costs real API credits.
 *
 * Usage: `tsx bench/agent/report.ts`  → writes bench/agent/results.json
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { genAllBuckets, type Channel } from "./payload-factory.js";
import { icsBucket } from "./ics.js";

const TASKS = [
  { site: "hackernews", cmd: "top" },
  { site: "hackernews", cmd: "search" },
  { site: "github", cmd: "search" },
  { site: "arxiv", cmd: "search" },
  { site: "bilibili", cmd: "popular" },
];

interface TaskRow {
  site: string;
  cmd: string;
  bucket: string;
  ics_score: number;
  ics_breakdown: Record<string, number>;
  invocation_lengths: Record<Channel, number>;
  /**
   * Placeholder ASR. Populated by sdk-runner.ts when the full bench runs.
   * Local "quick" bench leaves these null — deliberately — so the report
   * does NOT falsely claim measured success rates.
   */
  asr_sem: Record<Channel, number | null>;
}

function main(): void {
  const rows: TaskRow[] = [];

  for (const t of TASKS) {
    for (const p of genAllBuckets(t.site, t.cmd)) {
      const { quote_nest_depth, ...rest } = p.ics;
      rows.push({
        site: t.site,
        cmd: t.cmd,
        bucket: icsBucket(p.ics.score),
        ics_score: p.ics.score,
        ics_breakdown: {
          quote_nest_depth,
          ...rest,
        },
        invocation_lengths: {
          shell: p.invocations.shell.length,
          file: p.invocations.file.length,
          stdin: p.invocations.stdin.length,
        },
        asr_sem: { shell: null, file: null, stdin: null },
      });
    }
  }

  const summary = {
    schema_version: "bench-v1",
    generated_at: new Date().toISOString(),
    tasks: TASKS.length,
    rows: rows.length,
    ics_histogram: {
      trivial: rows.filter((r) => r.bucket === "trivial").length,
      moderate: rows.filter((r) => r.bucket === "moderate").length,
      hostile: rows.filter((r) => r.bucket === "hostile").length,
      pathological: rows.filter((r) => r.bucket === "pathological").length,
    },
    rows,
  };

  const out = resolve(process.cwd(), "bench/agent/results.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
  console.log(`[bench:agent] wrote ${out}`);
  console.log(
    `[bench:agent] buckets: trivial=${summary.ics_histogram.trivial} moderate=${summary.ics_histogram.moderate} hostile=${summary.ics_histogram.hostile} pathological=${summary.ics_histogram.pathological}`,
  );
}

main();
