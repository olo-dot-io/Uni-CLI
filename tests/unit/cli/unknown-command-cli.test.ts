import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ExitCode } from "../../../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const mainPath = join(repoRoot, "src", "main.ts");
const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";

describe("unknown CLI command boundary", () => {
  it("emits a structured generic error without persisting the user token", () => {
    const root = mkdtempSync(join(tmpdir(), "unicli-unknown-command-"));
    const logRoot = join(root, "events");
    const secret = "TOPSECRET-CLI-COMMAND-54ae70";
    try {
      const result = spawnSync(
        npxBin,
        ["tsx", mainPath, "-f", "json", secret],
        {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 30_000,
          env: {
            ...process.env,
            HOME: root,
            UNICLI_LOG_ROOT: logRoot,
            UNICLI_NO_LOG: "",
            UNICLI_NO_LEDGER: "",
            UNICLI_SKIP_UPDATE_CHECK: "1",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
        },
      );

      expect(result.status).toBe(ExitCode.USAGE_ERROR);
      expect(result.stdout).toBe("");
      const envelope = JSON.parse(result.stderr) as {
        ok: boolean;
        command: string;
        error: { code: string; message: string };
      };
      expect(envelope).toMatchObject({
        ok: false,
        command: "core.unknown",
        error: { code: "invalid_input", message: "unknown CLI command" },
      });
      expect(result.stderr).not.toContain(secret);

      const eventFile = readdirSync(logRoot).find((name) =>
        name.endsWith(".jsonl"),
      );
      expect(eventFile).toBeDefined();
      const events = readFileSync(join(logRoot, eventFile!), "utf-8");
      expect(events).toContain('"command":"core.unknown"');
      expect(events).toContain('"error_type":"invalid_input"');
      expect(events).not.toContain(secret);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
