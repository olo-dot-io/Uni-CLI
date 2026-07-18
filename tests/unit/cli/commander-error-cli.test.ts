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

describe("Commander parser error boundary", () => {
  it.each([
    {
      name: "unknown option",
      argv: ["--TOPSECRET-CLI-OPTION-9336e1"],
      expectedMessage: "unknown CLI option",
      excludedText: "TOPSECRET-CLI-OPTION-9336e1",
    },
    {
      name: "missing option value",
      argv: ["compute", "snapshot", "--app"],
      expectedMessage: "CLI option value is required",
      excludedText: "--app <app>",
    },
  ])(
    "normalizes $name as a structured usage error and matching local event",
    ({ argv, expectedMessage, excludedText }) => {
      const root = mkdtempSync(join(tmpdir(), "unicli-commander-error-"));
      const logRoot = join(root, "events");
      try {
        const result = spawnSync(npxBin, ["tsx", mainPath, ...argv], {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 30_000,
          env: {
            ...process.env,
            HOME: root,
            UNICLI_LOG_ROOT: logRoot,
            UNICLI_NO_LOG: "",
            UNICLI_NO_LEDGER: "",
            UNICLI_OUTPUT: "json",
            UNICLI_SKIP_UPDATE_CHECK: "1",
            UNICLI_BUILD_REVISION: "a".repeat(40),
            npm_config_update_notifier: "false",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
        });

        expect(result.status).toBe(ExitCode.USAGE_ERROR);
        expect(result.stdout).toBe("");
        const envelope = JSON.parse(result.stderr) as {
          ok: boolean;
          command: string;
          error: {
            code: string;
            message: string;
            exit_code: number;
            retryable: boolean;
          };
        };
        expect(envelope).toMatchObject({
          ok: false,
          command: "core.unknown",
          error: {
            code: "invalid_input",
            message: expectedMessage,
            exit_code: ExitCode.USAGE_ERROR,
            retryable: false,
          },
        });
        expect(result.stderr).not.toContain(excludedText);

        const eventFile = readdirSync(logRoot).find((entry) =>
          entry.endsWith(".jsonl"),
        );
        expect(eventFile).toBeDefined();
        const events = readFileSync(join(logRoot, eventFile!), "utf-8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events.at(-1)).toMatchObject({
          event_name: "unicli.cli.invocation.completed",
          command: "core.unknown",
          outcome: "error",
          exit_code: ExitCode.USAGE_ERROR,
          error_type: "invalid_input",
          retryable: false,
        });
        expect(JSON.stringify(events)).not.toContain(excludedText);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
