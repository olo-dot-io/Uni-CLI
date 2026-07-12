import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRepairFailure } from "../../src/engine/repair/failure-classifier.js";
import {
  buildRepairPlan,
  parseTargetArgs,
} from "../../src/engine/repair/plan.js";
import { verifyRepairPlan } from "../../src/engine/repair/verifier.js";

let fixtureDir = "";
let fixtureScript = "";

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "unicli-repair-verifier-"));
  fixtureScript = join(fixtureDir, "oracle.mjs");
  writeFileSync(
    fixtureScript,
    `const mode = process.env.REPAIR_FIXTURE_MODE ?? "pass";
const command = \`${"${process.argv[2]}.${process.argv[3]}"}\`;
const base = { schema_version: "2", command, meta: { duration_ms: 1, surface: "web" } };
if (mode === "timeout") setTimeout(() => {}, 10_000);
else if (mode === "invalid") { console.error("not an envelope"); process.exitCode = 1; }
else if (mode === "fail") {
  console.error(JSON.stringify({ ...base, ok: false, data: null, error: { code: "network_error", message: "connect refused", retryable: true } }));
  process.exitCode = 75;
} else if (mode === "mismatch") {
  console.log(JSON.stringify({ ...base, ok: true, data: [], error: null }));
  process.exitCode = 75;
} else {
  console.log(JSON.stringify({ ...base, ok: true, data: [{ value: "ok" }], error: null }));
}
`,
  );
});

afterEach(() => {
  delete process.env.REPAIR_FIXTURE_MODE;
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function plan(timeoutMs = 5_000) {
  return buildRepairPlan({
    site: "fixture",
    command: "ping",
    adapterPath: "src/adapters/fixture/ping.yaml",
    timeoutMs,
  });
}

const launch = () => ({
  executable: process.execPath,
  prefixArgs: [fixtureScript],
});

describe("repair verification plan", () => {
  it("uses the original command as a JSON oracle with a three-attempt budget", () => {
    expect(
      buildRepairPlan({
        site: "fixture",
        command: "search",
        adapterPath: "src/adapters/fixture/search.yaml",
        targetArgs: ["papers", "--limit", "2"],
        argsFile: "/tmp/args.json",
      }),
    ).toMatchObject({
      mutates_source: false,
      oracle: {
        argv: [
          "unicli",
          "fixture",
          "search",
          "papers",
          "--limit",
          "2",
          "--args-file",
          "/tmp/args.json",
          "--format",
          "json",
        ],
        success: { envelope_ok: true, process_exit: 0 },
      },
      repair_budget: { max_attempts: 3 },
    });
  });

  it("rejects malformed or evidence-overriding target args", () => {
    expect(() => parseTargetArgs("not-json")).toThrow("JSON array");
    expect(() => parseTargetArgs('["--format","yaml"]')).toThrow(
      "cannot contain --format",
    );
    expect(() => parseTargetArgs('{"limit":2}')).toThrow("array of strings");
    expect(() =>
      buildRepairPlan({
        site: "fixture",
        command: "ping",
        adapterPath: " ",
      }),
    ).toThrow("missing an adapter source path");
  });
});

describe("repair subprocess truth", () => {
  it("accepts only an ok envelope paired with exit zero", () => {
    const result = verifyRepairPlan(plan(), launch());
    expect(result).toMatchObject({
      status: "passed",
      exitCode: 0,
      envelope: { ok: true, command: "fixture.ping" },
    });
    if (result.status === "passed") {
      expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("preserves a failed target envelope and its nonzero exit", () => {
    process.env.REPAIR_FIXTURE_MODE = "fail";
    expect(verifyRepairPlan(plan(), launch())).toMatchObject({
      status: "failed",
      exitCode: 75,
      envelope: {
        ok: false,
        error: { code: "network_error", message: "connect refused" },
      },
    });
  });

  it("rejects envelope and process-exit contradictions", () => {
    process.env.REPAIR_FIXTURE_MODE = "mismatch";
    expect(verifyRepairPlan(plan(), launch())).toMatchObject({
      status: "error",
      exitCode: 78,
      code: "truth_mismatch",
    });
  });

  it("surfaces malformed output instead of manufacturing a repair result", () => {
    process.env.REPAIR_FIXTURE_MODE = "invalid";
    expect(verifyRepairPlan(plan(), launch())).toMatchObject({
      status: "error",
      exitCode: 78,
      code: "invalid_envelope",
      outputPreview: "not an envelope",
    });
  });

  it("surfaces child launch failures", () => {
    expect(
      verifyRepairPlan(plan(), {
        executable: join(fixtureDir, "missing-executable"),
        prefixArgs: [],
      }),
    ).toMatchObject({
      status: "error",
      exitCode: 78,
      code: "launch_error",
    });
  });

  it("terminates a stalled oracle at the configured bound", () => {
    process.env.REPAIR_FIXTURE_MODE = "timeout";
    expect(verifyRepairPlan(plan(1_000), launch())).toMatchObject({
      status: "error",
      exitCode: 75,
      code: "timeout",
    });
  });
});

describe("repair failure classification", () => {
  const target = {
    site: "fixture",
    command: "ping",
    adapterPath: "src/adapters/fixture/ping.yaml",
    oracle: "unicli fixture ping --limit 2 --format json",
  };

  it("keeps auth, network, and rate-limit failures out of source repair", () => {
    for (const code of ["auth_required", "network_error", "rate_limited"]) {
      expect(
        classifyRepairFailure({ code, message: code }, target).sourceRepairable,
      ).toBe(false);
    }
    expect(
      classifyRepairFailure(
        { code: "network_error", message: "network_error" },
        target,
      ).nextCommands[0],
    ).toBe(target.oracle);
  });

  it("marks selector and response drift as source-repairable", () => {
    for (const code of ["selector_miss", "not_found", "empty_result"]) {
      const diagnosis = classifyRepairFailure({ code, message: code }, target);
      expect(diagnosis.sourceRepairable).toBe(true);
      expect(diagnosis.guidance).toContain(target.adapterPath);
    }
  });
});
