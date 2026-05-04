import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

function rootScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

describe("compute live smoke harness", () => {
  it("is exposed as a root package script", () => {
    expect(rootScripts()["compute:smoke"]).toBe(
      "tsx scripts/compute-live-smoke.ts",
    );
  });

  it("generates platform-specific smoke plans with explicit mutating steps", async () => {
    const mod = (await import("../../scripts/compute-live-smoke.js").catch(
      () => undefined,
    )) as
      | undefined
      | {
          computeLiveSmokePlan: (platform: string) => {
            platform: string;
            app: string;
            commands: Array<{
              id: string;
              argv: string[];
              mutatesHost: boolean;
              refFromPreviousFind?: boolean;
            }>;
          };
          runComputeLiveSmokePlan: (
            plan: ReturnType<
              typeof import("../../scripts/compute-live-smoke.js").computeLiveSmokePlan
            >,
            opts: {
              includeMutating: boolean;
              json: boolean;
              execute: (argv: string[]) => Promise<{
                stdout: string;
                stderr: string;
                exitCode: number;
              }>;
            },
          ) => Promise<Array<Record<string, unknown>>>;
        };

    expect(mod).toBeDefined();
    if (!mod) return;

    const win = mod.computeLiveSmokePlan("win32");
    expect(win.app).toBe("Calculator");
    expect(win.commands.map((command) => command.id)).toEqual([
      "doctor",
      "apps",
      "launch",
      "snapshot",
      "find-button",
      "wait-button",
      "assert-button",
      "click-button",
      "type-button",
      "scroll-button",
      "screenshot",
    ]);
    expect(
      win.commands.find((command) => command.id === "click-button")
        ?.mutatesHost,
    ).toBe(true);
    expect(
      win.commands.find((command) => command.id === "type-button")?.mutatesHost,
    ).toBe(true);
    expect(
      win.commands.find((command) => command.id === "scroll-button")
        ?.mutatesHost,
    ).toBe(true);
    expect(
      win.commands.find((command) => command.id === "wait-button")?.mutatesHost,
    ).toBe(false);
    expect(
      win.commands.find((command) => command.id === "assert-button")
        ?.refFromPreviousFind,
    ).toBe(true);

    const linux = mod.computeLiveSmokePlan("linux");
    expect(
      linux.commands.find((command) => command.id === "launch")?.argv,
    ).toContain("gnome-calculator");
  });

  it("records failed steps and continues collecting evidence", async () => {
    const mod = await import("../../scripts/compute-live-smoke.js");
    const plan = mod.computeLiveSmokePlan("darwin");
    const calls: string[][] = [];

    const results = await mod.runComputeLiveSmokePlan(plan, {
      includeMutating: false,
      json: true,
      execute: async (argv) => {
        calls.push(argv);
        if (argv.includes("apps")) {
          return { stdout: "", stderr: "apps failed", exitCode: 69 };
        }
        if (argv.includes("find")) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: { alias: "@e7" },
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: JSON.stringify({ ok: true, data: {} }),
          stderr: "",
          exitCode: 0,
        };
      },
    });

    expect(results.find((result) => result.id === "apps")).toMatchObject({
      ok: false,
      exit_code: 69,
      stderr: "apps failed",
    });
    expect(results.find((result) => result.id === "snapshot")).toMatchObject({
      ok: true,
    });
    expect(
      results.find((result) => result.id === "click-button"),
    ).toMatchObject({
      skipped: true,
      reason: "mutating step",
    });
    expect(calls.length).toBeGreaterThan(3);
  });

  it("builds and writes a structured evidence report", async () => {
    const mod = await import("../../scripts/compute-live-smoke.js");
    const plan = mod.computeLiveSmokePlan("linux");
    const results = [
      { id: "doctor", ok: true, exit_code: 0 },
      { id: "apps", ok: false, exit_code: 69, stderr: "missing display" },
      { id: "launch", skipped: true, reason: "mutating step" },
    ];

    const report = mod.buildComputeSmokeReport(plan, results, {
      startedAt: "2026-05-03T00:00:00.000Z",
      finishedAt: "2026-05-03T00:00:01.000Z",
    });

    expect(report).toMatchObject({
      schema_version: 1,
      ok: false,
      platform: "linux",
      summary: {
        total: 3,
        passed: 1,
        failed: 1,
        skipped: 1,
      },
    });

    const dir = mkdtempSync(join(tmpdir(), "unicli-smoke-report-"));
    try {
      const output = join(dir, "nested", "report.json");
      await mod.writeComputeSmokeReport(output, report);
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        schema_version: 1,
        ok: false,
        platform: "linux",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
