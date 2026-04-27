import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
});
