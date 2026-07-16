import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authorizeComputeOperation,
  computeOperationEffect,
} from "../../src/compute/permission.js";
import { getComputeCommandContract } from "../../src/compute/contracts.js";

const originalRulesPath = process.env.UNICLI_PERMISSION_RULES_PATH;
const originalProfile = process.env.UNICLI_PERMISSION_PROFILE;
const originalApprove = process.env.UNICLI_APPROVE;

afterEach(() => {
  restoreEnvironment("UNICLI_PERMISSION_RULES_PATH", originalRulesPath);
  restoreEnvironment("UNICLI_PERMISSION_PROFILE", originalProfile);
  restoreEnvironment("UNICLI_APPROVE", originalApprove);
});

describe("direct computer-use permission boundary", () => {
  it("requires a matching allow rule under YAML default deny", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-compute-policy-"));
    try {
      const path = join(tmp, "policy.yaml");
      writeFileSync(
        path,
        [
          'schema_version: "2"',
          "default: deny",
          "rules:",
          "  - id: allow-owned-element-clicks",
          "    decision: allow",
          "    match:",
          "      site: compute",
          "      command: click",
          "      effect: local_app",
          "      arguments:",
          "        ref:",
          '          pattern: "^@e[0-9]+$"',
          "          max_length: 12",
          "",
        ].join("\n"),
        "utf-8",
      );
      process.env.UNICLI_PERMISSION_RULES_PATH = path;

      const allowed = await authorizeComputeOperation("click", { ref: "@e7" });
      const denied = await authorizeComputeOperation("click", {
        ref: "desktop-ax:foreign",
      });

      expect(allowed.ok).toBe(true);
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(denied.result.error).toMatchObject({
          minimum_capability: "permission.denied",
          exit_code: 77,
          reason: expect.stringContaining("policy-default-deny"),
        });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("classifies observation separately from durable screenshot writes", () => {
    const screenshot = getComputeCommandContract("screenshot");
    const capture = getComputeCommandContract("capture");
    if (!screenshot || !capture) throw new Error("compute contracts missing");

    expect(computeOperationEffect(screenshot, {})).toBe("read");
    expect(computeOperationEffect(screenshot, { path: "/tmp/shot.png" })).toBe(
      "local_file",
    );
    expect(computeOperationEffect(capture, {})).toBe("read");
    expect(computeOperationEffect(capture, { copyReference: true })).toBe(
      "local_file",
    );
  });

  it("returns a structured config failure before execution for a missing explicit policy", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-compute-policy-missing-"));
    try {
      process.env.UNICLI_PERMISSION_RULES_PATH = join(tmp, "missing.yaml");
      const result = await authorizeComputeOperation("apps", {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.result.error).toMatchObject({
          minimum_capability: "permission.config",
          exit_code: 2,
          reason: expect.stringContaining("does not exist"),
        });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("enforces locked-profile approval for mutating computer actions", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-compute-profile-"));
    try {
      const path = join(tmp, "policy.json");
      writeFileSync(
        path,
        JSON.stringify({ schema_version: "1", rules: [] }),
        "utf-8",
      );
      process.env.UNICLI_PERMISSION_RULES_PATH = path;
      process.env.UNICLI_PERMISSION_PROFILE = "locked";
      delete process.env.UNICLI_APPROVE;

      const denied = await authorizeComputeOperation("click", { ref: "@e1" });
      const approved = await authorizeComputeOperation(
        "click",
        { ref: "@e1" },
        { approved: true },
      );

      expect(denied.ok).toBe(false);
      expect(approved.ok).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
