/**
 * Unit tests for the Claude Agent SDK bench judges + aggregator.
 *
 * These exercise the emission-layer logic offline. The live bench is
 * exercised via `npm run bench:agent` and guarded by the ship-gate
 * enforcer (`scripts/bench/check-ship-gate.js`).
 */

import { describe, expect, it } from "vitest";

import {
  aggregate,
  binomialCI95,
  mean,
  round3,
  type TrialResult,
} from "../../bench/agent/sdk-aggregate.js";
import {
  judgeAsrGen,
  judgeAsrSem,
  type Emission,
} from "../../bench/agent/sdk-judges.js";
import type { Channel } from "../../bench/agent/payload-factory.js";
import {
  estimateCostUsd,
  PRICING,
  PRICING_FALLBACK,
} from "../../bench/agent/pricing.js";

const TASKS = [
  {
    site: "hackernews",
    cmd: "top",
    expected: { minResults: 1, keyFields: ["title"] },
  },
] as const;

function trial(
  bucket: "trivial" | "moderate" | "hostile" | "pathological",
  channel: Channel,
  sem: boolean,
  shell: string,
): TrialResult {
  return {
    task: { site: "hackernews", cmd: "top" },
    ics_bucket: bucket,
    channel,
    trial_id: 0,
    asr_gen: true,
    asr_exec: true,
    asr_sem: sem,
    duration_ms: 1,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    error: shell,
  };
}

describe("bench/agent math helpers", () => {
  it("round3 rounds to 3 decimals", () => {
    expect(round3(0.123456)).toBe(0.123);
    expect(round3(0.9999)).toBe(1);
  });

  it("mean on empty array is 0", () => {
    expect(mean([])).toBe(0);
  });

  it("binomialCI95 returns [0,0] when n=0", () => {
    expect(binomialCI95(0, 0)).toEqual({ lo: 0, hi: 0 });
  });

  it("binomialCI95 Wilson interval tightens with n", () => {
    const tight = binomialCI95(8, 10);
    const tighter = binomialCI95(80, 100);
    expect(tighter.hi - tighter.lo).toBeLessThan(tight.hi - tight.lo);
  });
});

describe("bench/agent judgeAsrGen", () => {
  const bash = (cmd: string): Emission[] => [
    { tool: "Bash", input: { command: cmd } },
  ];

  it("accepts a well-quoted shell command", () => {
    const r = judgeAsrGen(
      bash(`unicli --format json hackernews top --limit 10`),
      "shell",
    );
    expect(r.ok).toBe(true);
  });

  it("rejects when no Bash emission", () => {
    expect(judgeAsrGen([], "shell").ok).toBe(false);
  });

  it("accepts file channel with inline JSON heredoc", () => {
    const cmd = `cat > /tmp/q.json <<'JSON'\n{"limit":10}\nJSON\nunicli --args-file /tmp/q.json --format json hackernews top`;
    expect(judgeAsrGen(bash(cmd), "file").ok).toBe(true);
  });

  it("accepts stdin channel with echo + JSON", () => {
    const cmd = `echo '{"limit":10}' | unicli --format json hackernews top`;
    expect(judgeAsrGen(bash(cmd), "stdin").ok).toBe(true);
  });

  it("rejects stdin channel when JSON is malformed", () => {
    const cmd = `echo '{limit:10}' | unicli hackernews top`;
    expect(judgeAsrGen(bash(cmd), "stdin").ok).toBe(false);
  });
});

describe("bench/agent judgeAsrSem", () => {
  const expected = { minResults: 1, keyFields: ["title"] };

  it("requires both N claim and keyField/excerpt match", () => {
    const stdout = JSON.stringify({
      data: [{ title: "The electromechanical angle computer" }],
    });
    const good =
      "Found 1 results. First item title: The electromechanical angle computer";
    expect(judgeAsrSem(good, stdout, expected)).toBe(true);
  });

  it("rejects when N claim is missing", () => {
    const stdout = JSON.stringify({ data: [{ title: "foo bar baz qux" }] });
    expect(judgeAsrSem("title was foo bar baz qux", stdout, expected)).toBe(
      false,
    );
  });

  it("rejects when agent hallucinates content", () => {
    const stdout = JSON.stringify({ data: [{ title: "real title words" }] });
    const bad = "Found 1 results. title: completely fabricated phrase";
    expect(judgeAsrSem(bad, stdout, expected)).toBe(false);
  });
});

describe("bench/agent aggregate", () => {
  it("produces summary fields from trial batch", () => {
    const trials: TrialResult[] = [];
    for (const bucket of ["trivial", "pathological"] as const) {
      for (const channel of ["shell", "file", "stdin"] as Channel[]) {
        for (let i = 0; i < 10; i++) {
          // Simulate: shell fails more at pathological, stdin always works.
          const sem =
            bucket === "trivial"
              ? channel === "shell"
                ? i < 9
                : true
              : channel === "stdin"
                ? true
                : i < 5;
          trials.push(trial(bucket, channel, sem, ""));
        }
      }
    }
    const { rows, summary } = aggregate(TASKS, trials);
    expect(rows.length).toBeGreaterThan(0);
    expect(summary.asr_sem_at_ics8_stdin).toBe(1);
    expect(summary.sed_at_ics8).toBeGreaterThan(0);
    expect(summary.asr_sem_at_ics2_shell).toBe(0.9);
  });

  it("returns zero numbers with empty trial list", () => {
    const { rows, summary } = aggregate(TASKS, []);
    expect(rows).toHaveLength(0);
    expect(summary.asr_sem_at_ics8_stdin).toBe(0);
    expect(summary.sed_at_ics8).toBe(0);
  });
});

describe("bench/agent pricing table", () => {
  it("returns known pricing for the three default OpenRouter models", () => {
    const models = [
      "deepseek/deepseek-chat",
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5-mini",
    ];
    for (const m of models) {
      expect(PRICING[m]).toBeDefined();
      expect(PRICING[m].in).toBeGreaterThan(0);
      expect(PRICING[m].out).toBeGreaterThan(0);
    }
  });

  it("estimateCostUsd uses the entry when model is known", () => {
    // DeepSeek: 600 × 500 in × $0.27/M + 600 × 120 out × $1.10/M
    //         = 0.081 + 0.0792 = 0.1602
    const cost = estimateCostUsd("deepseek/deepseek-chat", 600, 500, 120);
    expect(cost).toBeCloseTo(0.1602, 4);
  });

  it("estimateCostUsd falls back for unknown models", () => {
    const cost = estimateCostUsd("totally/unknown-model", 600, 500, 120);
    // Fallback = in: 1.0, out: 3.0 per 1M →
    //   600 × 500 × 1.0/M + 600 × 120 × 3.0/M = 0.3 + 0.216 = 0.516
    expect(cost).toBeCloseTo(0.516, 4);
    expect(PRICING_FALLBACK.in).toBe(1.0);
    expect(PRICING_FALLBACK.out).toBe(3.0);
  });
});
