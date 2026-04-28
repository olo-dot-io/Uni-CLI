import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  createApprovalStore,
  rememberApproval,
} from "../../../src/engine/approval-store.js";
import { evaluateOperationPolicy } from "../../../src/engine/operation-policy.js";
import { ExitCode } from "../../../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const SRC_MAIN = join(REPO_ROOT, "src", "main.ts");
const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
  return spawnSync(npxBin, ["tsx", SRC_MAIN, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      ...env,
      UNICLI_NO_LEDGER: "1",
      UNICLI_APPROVE: "",
    },
    timeout: 30_000,
  });
}

describe("CLI approval memory controls", () => {
  it("lists active approval memory entries without raw runtime args", async () => {
    const home = mkdtempSync(join(tmpdir(), "unicli-approvals-cli-"));
    try {
      const store = createApprovalStore({ homeDir: home });
      const approved = await rememberApproval(store, {
        policy: evaluateOperationPolicy({
          site: "slack",
          command: "send",
          args: [{ name: "text", required: true }],
          profile: "confirm",
          approved: true,
        }),
        now: () => new Date("2026-04-29T00:00:00.000Z"),
      });
      appendFileSync(
        store.path,
        `${JSON.stringify({
          ...approved,
          created_at: "2026-04-29T00:01:00.000Z",
          runtime_args: { text: "secret text" },
        })}\n`,
        "utf-8",
      );
      expect(readFileSync(store.path, "utf-8")).toContain("secret text");

      const result = runCli(["approvals", "list", "-f", "json"], {
        HOME: home,
        UNICLI_APPROVALS_PATH: store.path,
      });

      expect(result.status).toBe(ExitCode.SUCCESS);
      const envelope = JSON.parse(result.stdout) as {
        data: {
          store_path: string;
          approvals: Array<{
            key: string;
            command: { site: string; command: string; effect: string };
            profile: string;
            scope_summary: string[];
          }>;
        };
      };
      expect(envelope.data.store_path).toBe(store.path);
      expect(envelope.data.approvals).toEqual([
        expect.objectContaining({
          key: approved!.key,
          profile: "confirm",
          command: {
            site: "slack",
            command: "send",
            effect: "send_message",
          },
        }),
      ]);
      expect(JSON.stringify(envelope.data)).not.toContain("secret text");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("revokes an approval so later dry-run plans need approval again", async () => {
    const home = mkdtempSync(join(tmpdir(), "unicli-approvals-cli-"));
    try {
      const store = createApprovalStore({ homeDir: home });
      const approved = await rememberApproval(store, {
        policy: evaluateOperationPolicy({
          site: "word",
          command: "set-font",
          description: "Set font for selected text in Microsoft Word",
          adapterType: "desktop",
          targetSurface: "desktop",
          profile: "locked",
          approved: true,
        }),
        now: () => new Date("2026-04-29T00:00:00.000Z"),
      });

      const before = runCli(
        [
          "--dry-run",
          "--permission-profile",
          "locked",
          "word",
          "set-font",
          "Inter",
          "-f",
          "json",
        ],
        {
          HOME: home,
          UNICLI_APPROVALS_PATH: store.path,
        },
      );
      expect(JSON.parse(before.stdout).operation_policy.enforcement).toBe(
        "allow",
      );

      const revoke = runCli(
        ["approvals", "revoke", approved!.key, "-f", "json"],
        {
          HOME: home,
          UNICLI_APPROVALS_PATH: store.path,
        },
      );
      expect(revoke.status).toBe(ExitCode.SUCCESS);
      expect(JSON.parse(revoke.stdout).data).toMatchObject({
        key: approved!.key,
        revoked: true,
      });

      const after = runCli(
        [
          "--dry-run",
          "--permission-profile",
          "locked",
          "word",
          "set-font",
          "Inter",
          "-f",
          "json",
        ],
        {
          HOME: home,
          UNICLI_APPROVALS_PATH: store.path,
        },
      );
      expect(JSON.parse(after.stdout).operation_policy.enforcement).toBe(
        "needs_approval",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("clears all active approval memory entries", async () => {
    const home = mkdtempSync(join(tmpdir(), "unicli-approvals-cli-"));
    try {
      const store = createApprovalStore({ homeDir: home });
      await rememberApproval(store, {
        policy: evaluateOperationPolicy({
          site: "slack",
          command: "send",
          args: [{ name: "text", required: true }],
          profile: "confirm",
          approved: true,
        }),
      });
      await rememberApproval(store, {
        policy: evaluateOperationPolicy({
          site: "word",
          command: "set-font",
          adapterType: "desktop",
          targetSurface: "desktop",
          profile: "locked",
          approved: true,
        }),
      });

      const clear = runCli(["approvals", "clear", "-f", "json"], {
        HOME: home,
        UNICLI_APPROVALS_PATH: store.path,
      });
      expect(clear.status).toBe(ExitCode.SUCCESS);
      expect(JSON.parse(clear.stdout).data).toMatchObject({
        cleared: 2,
      });

      const list = runCli(["approvals", "list", "-f", "json"], {
        HOME: home,
        UNICLI_APPROVALS_PATH: store.path,
      });
      expect(JSON.parse(list.stdout).data.approvals).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
