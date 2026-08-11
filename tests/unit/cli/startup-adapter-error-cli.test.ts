import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const mainPath = join(repoRoot, "src", "main.ts");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("startup adapter error boundary", () => {
  it("emits a typed envelope instead of a Node stack for malformed user YAML", () => {
    const home = mkdtempSync(join(tmpdir(), "unicli-bad-adapter-"));
    homes.push(home);
    const adapterDir = join(home, ".unicli", "adapters", "bad");
    mkdirSync(adapterDir, { recursive: true });
    const adapterPath = join(adapterDir, "oops.yaml");
    writeFileSync(adapterPath, "site: [broken", "utf8");

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", mainPath, "list", "-f", "json"],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("at ");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "core.startup",
      error: {
        code: "adapter_schema_invalid",
        adapter_path: adapterPath,
        step: 0,
        exit_code: 78,
        retryable: false,
      },
    });
  });

  it("awaits async command failures and preserves their structured envelope", () => {
    const home = mkdtempSync(join(tmpdir(), "unicli-async-command-"));
    homes.push(home);
    const runRoot = join(home, "runs");
    const traceDir = join(runRoot, "bad");
    mkdirSync(traceDir, { recursive: true });
    writeFileSync(join(traceDir, "trace.jsonl"), "{bad\n", "utf8");

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        mainPath,
        "-f",
        "json",
        "runs",
        "distill",
        "bad",
        "--root",
        runRoot,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("RunStoreError");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      command: "runs.distill",
      error: {
        code: "invalid_input",
        message: "malformed run trace JSONL at line 1",
        retryable: false,
      },
    });
  });
});
