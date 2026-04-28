import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
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

describe("CLI permission policy dispatch", () => {
  it("rejects invalid permission profile names instead of failing open", () => {
    const result = spawnSync(
      npxBin,
      [
        "tsx",
        SRC_MAIN,
        "--permission-profile",
        "lokced",
        "word",
        "set-font",
        "Helvetica",
        "-f",
        "json",
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          UNICLI_NO_LEDGER: "1",
          UNICLI_APPROVE: "",
        },
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(ExitCode.USAGE_ERROR);
    const envelope = JSON.parse(result.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("invalid_input");
    expect(envelope.error.message).toContain("invalid permission profile");
  });

  it("marks blocked desktop command envelopes as desktop surface", () => {
    const result = spawnSync(
      npxBin,
      [
        "tsx",
        SRC_MAIN,
        "--permission-profile",
        "locked",
        "word",
        "set-font",
        "Helvetica",
        "-f",
        "json",
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          UNICLI_NO_LEDGER: "1",
          UNICLI_APPROVE: "",
        },
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(ExitCode.AUTH_REQUIRED);
    expect(result.stdout.trim()).toBe("");

    const envelope = JSON.parse(result.stderr) as {
      ok: boolean;
      meta: { surface?: string };
      error: { code: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.meta.surface).toBe("desktop");
    expect(envelope.error.code).toBe("permission_denied");
  });

  it("marks blocked generated Electron commands as desktop with TS adapter path", () => {
    const result = spawnSync(
      npxBin,
      [
        "tsx",
        SRC_MAIN,
        "--permission-profile",
        "locked",
        "wechat-work",
        "type-text",
        "hello",
        "-f",
        "json",
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          UNICLI_NO_LEDGER: "1",
          UNICLI_APPROVE: "",
        },
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(ExitCode.AUTH_REQUIRED);
    const envelope = JSON.parse(result.stderr) as {
      ok: boolean;
      meta: { surface?: string };
      error: { code: string; adapter_path?: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.meta.surface).toBe("desktop");
    expect(envelope.error).toMatchObject({
      code: "permission_denied",
      adapter_path: "src/adapters/electron-desktop/electron-desktop.ts",
    });
  });

  it("blocks AI chat ask prompts under locked profile", () => {
    const result = spawnSync(
      npxBin,
      [
        "tsx",
        SRC_MAIN,
        "--permission-profile",
        "locked",
        "chatgpt",
        "ask",
        "hello",
        "-f",
        "json",
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          UNICLI_NO_LEDGER: "1",
          UNICLI_APPROVE: "",
        },
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(ExitCode.AUTH_REQUIRED);
    const envelope = JSON.parse(result.stderr) as {
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe("permission_denied");
    expect(envelope.error.message).toContain("send_message");
  });

  it("shows persisted approval memory in dry-run plans", async () => {
    const home = mkdtempSync(join(tmpdir(), "unicli-cli-approval-"));
    try {
      const store = createApprovalStore({ homeDir: home });
      await rememberApproval(store, {
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

      const result = spawnSync(
        npxBin,
        [
          "tsx",
          SRC_MAIN,
          "--dry-run",
          "--permission-profile",
          "locked",
          "word",
          "set-font",
          "Helvetica",
          "-f",
          "json",
        ],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: home,
            UNICLI_APPROVALS_PATH: store.path,
            UNICLI_NO_LEDGER: "1",
            UNICLI_APPROVE: "",
          },
          timeout: 30_000,
        },
      );

      expect(result.status).toBe(ExitCode.SUCCESS);
      const plan = JSON.parse(result.stdout) as {
        operation_policy: {
          enforcement: string;
          approved: boolean;
          approval_memory: { persistence: string; decision: string };
        };
      };
      expect(plan.operation_policy).toMatchObject({
        enforcement: "allow",
        approved: true,
        approval_memory: {
          persistence: "persisted",
          decision: "approved_by_memory",
        },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
