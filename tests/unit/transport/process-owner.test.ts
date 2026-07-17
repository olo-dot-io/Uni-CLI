import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  processOwnerExists,
  resolveProcessOwnerBinary,
  spawnOwnedProcess,
  terminateProcessOwner,
  type ProcessOwnerIdentity,
} from "../../../src/transport/process-owner.js";

describe("process owner", () => {
  it.runIf(process.platform !== "win32")(
    "terminates a saved process group after its command leader exits",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "unicli-owner-leader-exit-"));
      const marker = join(root, "late-descendant.txt");
      const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 500)`;
      const leader = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }).unref()`;
      let identity: ProcessOwnerIdentity | undefined;

      try {
        const launch = spawnOwnedProcess(process.execPath, ["-e", leader], {
          stdio: "ignore",
        });
        identity = await launch.identity;
        await once(launch.child, "close");

        expect(processOwnerExists(identity)).toBe(true);
        await terminateProcessOwner(identity);
        expect(processOwnerExists(identity)).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 600));
        await expect(readFile(marker, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        if (identity && processOwnerExists(identity)) {
          await terminateProcessOwner(identity);
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "closes the Job and kills descendants when the command leader exits",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "unicli-owner-job-exit-"));
      const marker = join(root, "late-descendant.txt");
      const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 500)`;
      const leader = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore", windowsHide: true }).unref()`;
      let identity: ProcessOwnerIdentity | undefined;

      try {
        const launch = spawnOwnedProcess(process.execPath, ["-e", leader], {
          stdio: "ignore",
        });
        identity = await launch.identity;
        await once(launch.child, "close");

        expect(processOwnerExists(identity)).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 600));
        await expect(readFile(marker, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        if (identity && processOwnerExists(identity)) {
          await terminateProcessOwner(identity);
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "verifies group disappearance after macOS reports partial-group EPERM",
    async () => {
      let livenessChecks = 0;
      // REASON: process.kill is the external POSIX boundary; this reproduces Darwin's documented partial-group EPERM followed by a disappearing group.
      const kill = vi
        .spyOn(process, "kill")
        .mockImplementation((pid, signal) => {
          expect(pid).toBe(-987_654);
          if (signal === "SIGTERM") {
            const error = new Error(
              "partial process-group permission",
            ) as NodeJS.ErrnoException;
            error.code = "EPERM";
            throw error;
          }
          if (signal === 0 && livenessChecks++ === 0) {
            const error = new Error(
              "group still observable",
            ) as NodeJS.ErrnoException;
            error.code = "EPERM";
            throw error;
          }
          const error = new Error(
            "group no longer exists",
          ) as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        });

      try {
        await expect(
          terminateProcessOwner({
            kind: "posix-process-group",
            owner_pid: 987_654,
            process_group_id: 987_654,
          }),
        ).resolves.toBeUndefined();
        expect(kill).toHaveBeenCalledWith(-987_654, "SIGTERM");
      } finally {
        kill.mockRestore();
      }
    },
  );

  it("resolves the Windows owner from explicit, bundled, package, user, then PATH locations", () => {
    const explicit = resolveProcessOwnerBinary({
      platform: "win32",
      env: { UNICLI_PROCESS_OWNER: "D:\\tools\\owner.exe" },
    });
    expect(explicit).toBe("D:\\tools\\owner.exe");

    const bundled = win32.join(
      "C:\\repo",
      "packages",
      "sidecars",
      "unicli-process-owner-win32-arm64",
      "unicli-process-owner.exe",
    );
    expect(
      resolveProcessOwnerBinary({
        platform: "win32",
        arch: "arm64",
        env: {},
        bundledRoot: "C:\\repo",
        exists: (path) => path === bundled,
      }),
    ).toBe(bundled);

    const packageJson =
      "C:\\repo\\node_modules\\@zenalexa\\unicli-process-owner-win32-x64\\package.json";
    expect(
      resolveProcessOwnerBinary({
        platform: "win32",
        arch: "x64",
        env: {},
        requireResolve: () => packageJson,
      }),
    ).toBe(win32.join(win32.dirname(packageJson), "unicli-process-owner.exe"));

    expect(
      resolveProcessOwnerBinary({
        platform: "win32",
        arch: "ia32",
        env: {},
        homeDir: "C:\\Users\\agent",
        exists: (path) => path.includes(".unicli"),
      }),
    ).toBe("C:\\Users\\agent\\.unicli\\sidecars\\unicli-process-owner.exe");

    expect(
      resolveProcessOwnerBinary({
        platform: "win32",
        arch: "ia32",
        env: {},
        exists: () => false,
      }),
    ).toBe("unicli-process-owner.exe");
  });
});
