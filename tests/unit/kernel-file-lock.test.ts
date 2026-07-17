import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireKernelFileLock,
  KernelFileLockError,
} from "../../src/browser/kernel-file-lock.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
const tsxImportPath = pathToFileURL(require.resolve("tsx")).href;
const ownerHelperPath = join(
  repositoryRoot,
  "tests",
  "helpers",
  "kernel-file-lock-owner.ts",
);
const posixKernelIt = ["darwin", "linux"].includes(process.platform)
  ? it
  : it.skip;

let root: string | null = null;
let owner: ChildProcess | null = null;

afterEach(async () => {
  if (owner && owner.exitCode === null && owner.signalCode === null) {
    if (process.platform !== "win32") owner.kill("SIGCONT");
    owner.kill("SIGKILL");
    await waitForExit(owner);
  }
  owner = null;
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("process-owned kernel file lock", () => {
  it("retains ownership after the lock provider exits", async () => {
    root = mkdtempSync(join(tmpdir(), "unicli-kernel-lock-"));
    const path = join(root, "owner.lock");
    const first = await acquireKernelFileLock(path);

    await expect(acquireKernelFileLock(path)).rejects.toEqual(
      expect.objectContaining<Partial<KernelFileLockError>>({
        code: "contended",
      }),
    );
    expect(statSync(path).isFile()).toBe(true);

    await first.release();
    await first.release();
    const successor = await acquireKernelFileLock(path);
    await successor.release();
  });

  posixKernelIt(
    "keeps a paused owner exclusive across twelve processes and releases atomically on exit",
    async () => {
      root = mkdtempSync(join(tmpdir(), "unicli-kernel-lock-process-"));
      const path = join(root, "owner.lock");
      owner = spawn(
        process.execPath,
        ["--import", tsxImportPath, ownerHelperPath, "hold", path],
        {
          cwd: repositoryRoot,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const ready = await readFirstEnvelope(owner);
      expect(ready).toMatchObject({ status: "acquired", pid: owner.pid });
      expect(
        childProcessCommands(owner.pid!).every(
          (command) =>
            !command.includes("/usr/bin/lockf") &&
            !command.includes("/usr/bin/flock") &&
            !command.includes("/bin/flock"),
        ),
      ).toBe(true);

      owner.kill("SIGSTOP");
      const contenders = await Promise.all(
        Array.from({ length: 12 }, () => runContender(path)),
      );
      expect(contenders).toEqual(
        Array.from({ length: 12 }, () =>
          expect.objectContaining({ status: "failed", code: "contended" }),
        ),
      );

      owner.kill("SIGKILL");
      await waitForExit(owner);
      owner = null;

      const successor = await acquireKernelFileLock(path);
      await successor.release();
      expect(statSync(path).isFile()).toBe(true);
    },
    20_000,
  );

  it.runIf(process.platform === "win32")(
    "keeps one named-pipe owner exclusive across twelve processes and releases atomically on exit",
    async () => {
      root = mkdtempSync(join(tmpdir(), "unicli-kernel-lock-process-"));
      const path = join(root, "owner.lock");
      owner = spawn(
        process.execPath,
        ["--import", tsxImportPath, ownerHelperPath, "hold", path],
        {
          cwd: repositoryRoot,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const ready = await readFirstEnvelope(owner);
      expect(ready).toMatchObject({ status: "acquired", pid: owner.pid });

      const contenders = await Promise.all(
        Array.from({ length: 12 }, () => runContender(path)),
      );
      expect(contenders).toEqual(
        Array.from({ length: 12 }, () =>
          expect.objectContaining({ status: "failed", code: "contended" }),
        ),
      );

      owner.kill("SIGKILL");
      await waitForExit(owner);
      owner = null;

      const successor = await acquireKernelFileLock(path);
      await successor.release();
      expect(statSync(path).isFile()).toBe(true);
    },
    20_000,
  );
});

async function runContender(path: string): Promise<Record<string, unknown>> {
  const contender = spawn(
    process.execPath,
    ["--import", tsxImportPath, ownerHelperPath, "once", path],
    {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const envelope = await readFirstEnvelope(contender);
  await waitForExit(contender);
  return envelope;
}

function readFirstEnvelope(
  child: ChildProcess,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Kernel lock helper did not produce an envelope: ${stderr || stdout}`,
        ),
      );
    }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(
          JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>,
        );
      } catch (error) {
        reject(error);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (stdout.includes("\n")) return;
      clearTimeout(timer);
      reject(
        new Error(
          `Kernel lock helper exited ${String(code ?? signal)} without an envelope: ${stderr || stdout}`,
        ),
      );
    });
  });
}

function childProcessCommands(pid: number): string[] {
  const rows = execFileSync("ps", ["-axo", "ppid=,command="], {
    encoding: "utf8",
  });
  return rows
    .trim()
    .split("\n")
    .map((row) => row.trim().match(/^(\d+)\s+(.*)$/))
    .filter((row): row is RegExpMatchArray => Number(row?.[1]) === pid)
    .map((row) => row[2]!);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
