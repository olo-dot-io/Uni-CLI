/**
 * Compare retrieval relevance scoring with the fixed 9634121c source.
 * Run with node --import tsx bench/retrieval-relevance.ts.
 * BENCH_RUNS controls resident repetitions and defaults to nine.
 * Writes bench/retrieval-relevance.results.json and the same JSON to stdout.
 */
import { performance } from "node:perf_hooks";
import * as current from "../src/engine/retrieval-relevance.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baselineRef = "9634121c";
const runs = Number(process.env.BENCH_RUNS ?? 9);
if (!Number.isSafeInteger(runs) || runs < 1)
  throw new Error("BENCH_RUNS must be a positive integer");
const temporary = mkdtempSync(join(tmpdir(), "unicli-relevance-baseline-"));
try {
  const baselineFile = join(temporary, "baseline.mts");
  writeFileSync(
    baselineFile,
    execFileSync(
      "git",
      ["show", `${baselineRef}:src/engine/retrieval-relevance.ts`],
      { cwd: root },
    ),
  );
  const baseline = (await import(
    pathToFileURL(baselineFile).href
  )) as typeof current;
  const queries = [
    "AI",
    "C++ NVL72 世界模型 bandwidth",
    'NVLink OR "Infinity Fabric"',
    "site:docs.nvidia.com training infrastructure",
    "quartz dataset download",
    "数据库 索引 资料",
    '"compiler flags" language',
    "v1.2 module/path c#",
    "foo.bar foo+bar",
    "low-latency 3d",
    "GPU GPU gpu",
    "全角ＡＩ测试",
    '"a phrase" OR graph theory',
    "AI topology",
    "arxiv code datasets",
    "json api reference",
    "",
    " OR ",
    "x y z",
    "paper_search",
  ];
  const atoms = [
    "ai",
    "training",
    "nvlink",
    "nvl72",
    "c++",
    "c#",
    "foo.bar",
    "foo+bar",
    "module/path",
    "compiler flags",
    "a phrase",
    "database",
    "数据库",
    "世界模型",
    "quartz",
    "dataset",
    "download",
    "v1.2",
    "fullwidth ＡＩ",
    "_",
    "-",
    ".",
    " ",
    "0",
    "a",
    "Z",
    "é",
  ];
  const records = Array.from({ length: 500 }, (_, i) => ({
    title:
      atoms[i % atoms.length] +
      atoms[(i * 13 + 5) % atoms.length] +
      atoms[(i * 3 + 1) % atoms.length],
    summary:
      atoms[(i * 7) % atoms.length] +
      " " +
      atoms[(i * 11 + 2) % atoms.length] +
      " low-latency topology language",
    tags: [atoms[(i * 17) % atoms.length], "json api reference"],
    url: `https://example.org/${atoms[i % atoms.length]}/paper_search?v=${i}`,
  }));
  const analyses = queries.map((query) =>
    current.splitRetrievalDisjunction(query).map(current.analyzeRetrievalQuery),
  );
  let comparisons = 0;
  let mismatches = 0;
  for (const variants of analyses)
    for (const record of records)
      for (const requireAllTerms of [true, false]) {
        const old = baseline.scoreRetrievalAlternatives(variants, record, {
          requireAllTerms,
        });
        const next = current.scoreRetrievalAlternatives(variants, record, {
          requireAllTerms,
        });
        comparisons++;
        if (JSON.stringify(old) !== JSON.stringify(next)) mismatches++;
      }
  let sink = 0;
  function batch(implementation: typeof current) {
    const start = performance.now();
    for (const variants of analyses)
      for (const record of records)
        sink += implementation.scoreRetrievalAlternatives(
          variants,
          record,
        ).score;
    return performance.now() - start;
  }
  batch(baseline);
  batch(current);
  const samples = { baseline: [] as number[], current: [] as number[] };
  for (let round = 0; round < runs; round++)
    for (const name of round % 2
      ? (["current", "baseline"] as const)
      : (["baseline", "current"] as const))
      samples[name].push(batch(name === "baseline" ? baseline : current));
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const before = median(samples.baseline),
    after = median(samples.current);
  const report = {
    baseline_ref: baselineRef,
    baseline_revision: execFileSync("git", ["rev-parse", baselineRef], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os_release: release(),
    cpu: cpus()[0]?.model,
    runs,
    comparisons,
    mismatches,
    records: records.length,
    queries: queries.length,
    boundary:
      "10,000 resident scoreRetrievalAlternatives calls including field normalization, matching, scoring, and alternative selection; query analyses prepared once. Timing excludes process startup, module loading, network, and file I/O.",
    method:
      "One warm-up batch per implementation, followed by alternating baseline/candidate order each round. Differential comparisons exercise requireAllTerms true and false.",
    median_ms: { baseline: before, current: after },
    ratio: before / after,
    samples,
    sink,
  };
  const output = JSON.stringify(report, null, 2) + "\n";
  writeFileSync(
    join(root, "bench", "retrieval-relevance.results.json"),
    output,
  );
  process.stdout.write(output);
  if (mismatches) process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
