import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  automaticUpdateLeasePath,
  readAutomaticUpdateState,
  scheduleAutomaticUpdate,
} from "../../src/engine/update-auto.js";
import { runAutomaticUpdateWorker } from "../../src/engine/update-auto-worker.js";

let root = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unicli-auto-update-"));
  env = {
    ...process.env,
    CI: "",
    NODE_ENV: "production",
    UNICLI_AUTO_UPDATE_STATE_PATH: join(root, "automatic-update.json"),
    UNICLI_AUTO_UPDATE_LEASE_PATH: join(root, "automatic-update.lock"),
    UNICLI_UPDATE_PREFERENCES_PATH: join(root, "preferences.json"),
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("automatic update scheduling", () => {
  it("defaults non-interactive persistent Agents to one detached update", () => {
    const workerPath = join(root, "worker.mjs");
    writeFileSync(workerPath, "process.exit(0);\n");
    const launch = vi.fn();
    const options = {
      interactive: false,
      scriptPath:
        "/usr/local/lib/node_modules/@zenalexa/unicli/dist/engine/update-check.js",
      workerPath,
      now: () => 1000,
      launch,
    };

    expect(scheduleAutomaticUpdate("9.9.9", env, options)).toEqual({
      enabled: true,
      status: "scheduled",
      package_manager: "npm",
      opt_out: "UNICLI_AUTO_UPDATE=0",
    });
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]?.[1]).toMatchObject({
      UNICLI_AUTO_UPDATE_LATEST: "9.9.9",
      UNICLI_AUTO_UPDATE_MANAGER: "npm",
    });
    expect(readAutomaticUpdateState(env)).toMatchObject({
      version: "9.9.9",
      status: "scheduled",
      startedAt: 1000,
    });
    expect(scheduleAutomaticUpdate("9.9.9", env, options).status).toBe(
      "running",
    );
    expect(launch).toHaveBeenCalledOnce();
    if (process.platform !== "win32") {
      expect(lstatSync(automaticUpdateLeasePath(env)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps interactive terminals on Y/N and honors explicit opt-out", () => {
    const common = {
      scriptPath:
        "/usr/local/lib/node_modules/@zenalexa/unicli/dist/engine/update-check.js",
    };
    expect(
      scheduleAutomaticUpdate("9.9.9", env, {
        ...common,
        interactive: true,
      }),
    ).toMatchObject({ enabled: false, status: "interactive_choice" });
    expect(
      scheduleAutomaticUpdate(
        "9.9.9",
        { ...env, UNICLI_AUTO_UPDATE: "0" },
        { ...common, interactive: false },
      ),
    ).toMatchObject({ enabled: false, status: "disabled" });
    expect(
      scheduleAutomaticUpdate("9.9.9", env, {
        interactive: false,
        scriptPath: "/workspace/Uni-CLI/dist/engine/update-check.js",
      }),
    ).toMatchObject({ enabled: false, status: "unsupported" });
  });
});

describe("automatic update worker", () => {
  it("records success and releases the exact lease", async () => {
    writeFileSync(automaticUpdateLeasePath(env), "lease-token\n");
    const install = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    const code = await runAutomaticUpdateWorker({
      env: {
        ...env,
        UNICLI_AUTO_UPDATE_LATEST: "9.9.9",
        UNICLI_AUTO_UPDATE_MANAGER: "npm",
        UNICLI_AUTO_UPDATE_LEASE_TOKEN: "lease-token",
      },
      now: vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(2000),
      install,
    });

    expect(code).toBe(0);
    expect(install).toHaveBeenCalledWith("npm", "9.9.9");
    expect(readAutomaticUpdateState(env)).toMatchObject({
      version: "9.9.9",
      status: "succeeded",
      completedAt: 2000,
    });
    expect(() => readFileSync(automaticUpdateLeasePath(env))).toThrow();
  });

  it("records bounded package-manager failures for a later retry", async () => {
    writeFileSync(automaticUpdateLeasePath(env), "lease-token\n");
    const code = await runAutomaticUpdateWorker({
      env: {
        ...env,
        UNICLI_AUTO_UPDATE_LATEST: "9.9.9",
        UNICLI_AUTO_UPDATE_MANAGER: "pnpm",
        UNICLI_AUTO_UPDATE_LEASE_TOKEN: "lease-token",
      },
      now: vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(2000),
      install: vi
        .fn()
        .mockResolvedValue({ exitCode: 7, output: "permission denied" }),
    });

    expect(code).toBe(7);
    expect(readAutomaticUpdateState(env)).toMatchObject({
      status: "failed",
      completedAt: 2000,
      error: "permission denied",
    });
  });
});
