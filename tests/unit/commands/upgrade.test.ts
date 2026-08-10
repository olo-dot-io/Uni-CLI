import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectUpdatePackageManager,
  parseUpgradeArgs,
  runUpgradeCommand,
  updateInstallCommand,
} from "../../../src/commands/upgrade.js";
import { VERSION } from "../../../src/constants.js";
import { clearActiveUpdateNotice } from "../../../src/core/update-notice.js";
import { writeAutomaticUpdateState } from "../../../src/engine/update-auto.js";
import { readUpdatePreferences } from "../../../src/engine/update-preferences.js";

let root = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unicli-upgrade-command-"));
  env = {
    ...process.env,
    UNICLI_UPDATE_CHECK_CACHE_PATH: join(root, "update-check.json"),
    UNICLI_UPDATE_PREFERENCES_PATH: join(root, "preferences.json"),
  };
  clearActiveUpdateNotice();
});

afterEach(() => {
  clearActiveUpdateNotice();
  rmSync(root, { recursive: true, force: true });
});

function capture(): {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  out: () => string;
  err: () => string;
} {
  let out = "";
  let err = "";
  return {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    out: () => out,
    err: () => err,
  };
}

describe("upgrade command parsing and install plans", () => {
  it("keeps Y, N, and skip choices mutually exclusive", () => {
    expect(parseUpgradeArgs(["--yes", "-f", "json"])).toMatchObject({
      yes: true,
      format: "json",
    });
    expect(() => parseUpgradeArgs(["--yes", "--no"])).toThrow(
      "Choose only one",
    );
    expect(() => parseUpgradeArgs(["--check", "--yes"])).toThrow(
      "cannot be combined",
    );
    expect(parseUpgradeArgs(["--no-auto-update"])).toMatchObject({
      automaticUpdates: false,
    });
  });

  it("detects persistent package managers and rejects ephemeral runners", () => {
    expect(
      detectUpdatePackageManager(
        "/Users/a/.local/share/pnpm/global/5/node_modules/@zenalexa/unicli/dist/main.js",
      ),
    ).toBe("pnpm");
    expect(
      detectUpdatePackageManager(
        "/Users/a/.bun/install/global/node_modules/@zenalexa/unicli/dist/main.js",
      ),
    ).toBe("bun");
    expect(
      detectUpdatePackageManager(
        "/Users/a/.npm/_npx/123/node_modules/@zenalexa/unicli/dist/main.js",
      ),
    ).toBeUndefined();
    expect(
      detectUpdatePackageManager(
        "/usr/local/lib/node_modules/@zenalexa/unicli/dist/main.js",
      ),
    ).toBe("npm");
    expect(
      detectUpdatePackageManager("/workspace/Uni-CLI/dist/main.js"),
    ).toBeUndefined();
  });

  it("pins the exact registry version without invoking a shell", () => {
    expect(updateInstallCommand("npm", "2.3.4")).toMatchObject({
      args: ["install", "--global", "@zenalexa/unicli@2.3.4"],
      display: "npm install --global @zenalexa/unicli@2.3.4",
    });
  });
});

describe("upgrade command behavior", () => {
  it("persists automatic-update choice without querying the registry", async () => {
    const io = capture();
    const resolveLatest = vi.fn();
    const code = await runUpgradeCommand(["--no-auto-update", "-f", "json"], {
      env,
      stdout: io.stdout,
      stderr: io.stderr,
      resolveLatest,
    });

    expect(code).toBe(0);
    expect(resolveLatest).not.toHaveBeenCalled();
    expect(readUpdatePreferences(env).automaticUpdates).toBe(false);
    expect(JSON.parse(io.out()).data).toMatchObject({
      automatic_updates: "disabled",
      status: "preferences_updated",
    });
  });

  it("returns machine-readable update status without installing", async () => {
    const io = capture();
    const install = vi.fn();
    const code = await runUpgradeCommand(["--check", "-f", "json"], {
      env,
      stdout: io.stdout,
      stderr: io.stderr,
      resolveLatest: async () => ({ latest: "9.9.9", source: "registry" }),
      install,
      scriptPath: "/usr/local/lib/node_modules/@zenalexa/unicli/dist/main.js",
    });

    expect(code).toBe(0);
    expect(io.err()).toBe("");
    expect(JSON.parse(io.out()).data).toMatchObject({
      update_available: true,
      latest: "9.9.9",
      status: "update_available",
      confirmation_required: false,
    });
    expect(install).not.toHaveBeenCalled();
  });

  it("gives a non-TTY Agent explicit yes and no commands", async () => {
    const io = capture();
    const code = await runUpgradeCommand(["-f", "json"], {
      env,
      stdinIsTTY: false,
      stdout: io.stdout,
      stderr: io.stderr,
      resolveLatest: async () => ({ latest: "9.9.9", source: "cache" }),
      scriptPath: "/usr/local/lib/node_modules/@zenalexa/unicli/dist/main.js",
    });

    expect(code).toBe(0);
    expect(JSON.parse(io.out()).data).toMatchObject({
      status: "confirmation_required",
      confirmation_required: true,
      choices: {
        yes: "unicli upgrade --yes",
        no: "unicli upgrade --no",
        skip_version: "unicli upgrade --skip-version",
      },
    });
  });

  it("installs an exact release after unattended approval", async () => {
    const io = capture();
    const install = vi.fn().mockResolvedValue({ exitCode: 0, output: "ok" });
    const code = await runUpgradeCommand(["--yes", "-f", "json"], {
      env,
      stdout: io.stdout,
      stderr: io.stderr,
      resolveLatest: async () => ({ latest: "9.9.9", source: "registry" }),
      install,
      scriptPath: "/usr/local/lib/node_modules/@zenalexa/unicli/dist/main.js",
    });

    expect(code).toBe(0);
    expect(install).toHaveBeenCalledWith("npm", "9.9.9");
    expect(JSON.parse(io.out()).data).toMatchObject({
      status: "updated",
      installed: "9.9.9",
      next_command: "unicli --version",
    });
  });

  it("does not race an automatic install already holding the release", async () => {
    const io = capture();
    const install = vi.fn();
    writeAutomaticUpdateState(
      {
        version: "9.9.9",
        packageManager: "npm",
        status: "running",
        startedAt: 1000,
      },
      env,
    );
    const code = await runUpgradeCommand(["--yes", "-f", "json"], {
      env,
      now: () => 2000,
      stdout: io.stdout,
      stderr: io.stderr,
      resolveLatest: async () => ({ latest: "9.9.9", source: "cache" }),
      install,
      scriptPath: "/usr/local/lib/node_modules/@zenalexa/unicli/dist/main.js",
    });

    expect(code).toBe(0);
    expect(install).not.toHaveBeenCalled();
    expect(JSON.parse(io.out()).data).toMatchObject({
      status: "automatic_update_running",
      next_command: "unicli --version",
    });
  });

  it("maps an interactive N answer to a bounded reminder", async () => {
    const io = capture();
    const prompt = vi.fn().mockResolvedValue("n");
    const code = await runUpgradeCommand(["-f", "json"], {
      env,
      stdinIsTTY: true,
      stdout: io.stdout,
      stderr: io.stderr,
      prompt,
      now: () => 1_000,
      resolveLatest: async () => ({ latest: "9.9.9", source: "registry" }),
      scriptPath: "/usr/local/lib/node_modules/@zenalexa/unicli/dist/main.js",
    });

    expect(code).toBe(0);
    expect(prompt).toHaveBeenCalledWith(
      `Upgrade Uni-CLI ${VERSION} to 9.9.9 now? [Y/n] `,
    );
    expect(JSON.parse(io.out()).data.status).toBe("remind_later");
    expect(readUpdatePreferences(env)).toMatchObject({
      deferredVersion: "9.9.9",
      deferredUntil: 86_401_000,
    });
  });
});
