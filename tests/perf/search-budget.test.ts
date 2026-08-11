import { beforeAll, describe, expect, it } from "vitest";

import { loadAllAdapters, loadTsAdapters } from "../../src/discovery/loader.js";
import {
  buildIndexFromDocuments,
  invalidateCache,
  runtimeSearchDocuments,
  search,
} from "../../src/discovery/search.js";
import { compileIntentPlan } from "../../src/discovery/intent-plan.js";

const WARM_QUERY_P95_MS = 5;
const INDEX_BUILD_P95_MS = 25;
const INTENT_PLAN_P95_MS = 1;
const PERF_SAMPLE_COUNT = 40;

const QUERIES = [
  "search",
  "read",
  "latest",
  "search tweets about AI",
  "论文搜索",
  "查找并验证论文开放获取 PDF",
  "AI infrastructure PagedAttention accelerator operator",
  "capture desktop app accessibility snapshot screenshot for computer-use handoff",
  "browser network requests",
  "github issues",
  "股票行情",
  "play a song on spotify",
] as const;

beforeAll(async () => {
  process.env.UNICLI_DYNAMIC_MACOS = "0";
  loadAllAdapters({ strict: true });
  await loadTsAdapters({ strict: true });
  invalidateCache();
});

describe("discovery search performance budget", () => {
  it("keeps warm bilingual operator discovery inside its p95 budget", () => {
    for (const query of QUERIES) search(query, 5);

    const samples: number[] = [];
    for (let trial = 0; trial < PERF_SAMPLE_COUNT; trial++) {
      const started = performance.now();
      for (let round = 0; round < 10; round++) {
        for (const query of QUERIES) search(query, 5);
      }
      samples.push((performance.now() - started) / (QUERIES.length * 10));
    }

    expect(percentile(samples, 0.95)).toBeLessThan(WARM_QUERY_P95_MS);
  });

  it("keeps immutable inverted-index construction inside its p95 budget", () => {
    const documents = runtimeSearchDocuments();
    const samples: number[] = [];
    for (let trial = 0; trial < PERF_SAMPLE_COUNT; trial++) {
      const started = performance.now();
      const index = buildIndexFromDocuments(documents);
      samples.push(performance.now() - started);
      expect(index.N).toBe(documents.length);
    }

    expect(percentile(samples, 0.95)).toBeLessThan(INDEX_BUILD_P95_MS);
  });

  it("keeps compiled intent semantics inside its p95 budget", () => {
    for (const query of QUERIES) compileIntentPlan(query);

    const samples: number[] = [];
    for (let trial = 0; trial < PERF_SAMPLE_COUNT; trial++) {
      const started = performance.now();
      for (let round = 0; round < 20; round++) {
        for (const query of QUERIES) compileIntentPlan(query);
      }
      samples.push((performance.now() - started) / (QUERIES.length * 20));
    }

    expect(percentile(samples, 0.95)).toBeLessThan(INTENT_PLAN_P95_MS);
  });
});

function percentile(samples: readonly number[], ratio: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * ratio) - 1,
  );
  return sorted[index] ?? 0;
}
