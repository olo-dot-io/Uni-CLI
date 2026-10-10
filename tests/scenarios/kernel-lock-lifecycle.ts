import childProcess, { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const existsSync = fs.existsSync;
const spawnSync = childProcess.spawnSync;
// REASON: Model macOS 14's absent lockf binary while keeping the filesystem, Perl provider, and kernel locks real.
if (process.platform === "darwin") {
  fs.existsSync = (path) => path !== "/usr/bin/lockf" && existsSync(path);
  childProcess.spawnSync = ((...args: Parameters<typeof spawnSync>) =>
    Reflect.apply(spawnSync, childProcess, [
      args[0] === "/usr/bin/lockf" ? `${args[0]}.absent-on-macos-14` : args[0],
      ...args.slice(1),
    ])) as typeof spawnSync;
  syncBuiltinESMExports();
}

if (process.argv[2] === "hold" || process.argv[2] === "once") {
  await import("../helpers/kernel-file-lock-owner.js");
} else {
  const { acquireKernelFileLock, KernelFileLockError } =
    await import("../../src/browser/kernel-file-lock.js");
  const root = fs.mkdtempSync(join(tmpdir(), "unicli-lock-lifecycle-"));
  const path = join(root, "owner.lock");
  const failures: string[] = [];
  const children: ChildProcess[] = [];
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx"));
  const script = fileURLToPath(import.meta.url);
  let observations = 0;
  const observe = (ok: boolean, label: string): void => {
    observations++;
    if (!ok) failures.push(label);
  };
  const launch = (mode: "hold" | "once") => {
    const child = spawn(
      process.execPath,
      ["--import", tsx.href, script, mode, path],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    const exited = new Promise<void>((resolve) => child.once("exit", resolve));
    const envelope = new Promise<Record<string, unknown>>((resolve, reject) => {
      let output = "";
      let diagnostics = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Lock owner timed out ${diagnostics}`));
      }, 10_000);
      child.stderr?.on("data", (data: Buffer) => {
        diagnostics += data.toString();
      });
      child.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        try {
          resolve(
            JSON.parse(output.slice(0, newline)) as Record<string, unknown>,
          );
        } catch (error) {
          reject(error);
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        if (!output.includes("\n")) {
          reject(
            new Error(`Lock owner exited without a result ${diagnostics}`),
          );
        }
      });
    });
    return { child, exited, envelope };
  };

  try {
    const first = await acquireKernelFileLock(path);
    try {
      observe(fs.statSync(path).isFile(), "persistent regular-file marker");
      // Restore platform discovery for this contender to check interoperation with newer macOS lockf.
      fs.existsSync = existsSync;
      childProcess.spawnSync = spawnSync;
      syncBuiltinESMExports();
      let unexpected;
      try {
        unexpected = await acquireKernelFileLock(path);
        failures.push("second acquisition bypassed the owner's lock");
      } catch (error) {
        observe(
          error instanceof KernelFileLockError && error.code === "contended",
          "cross-provider contention retains its error code",
        );
      } finally {
        await unexpected?.release();
      }
    } finally {
      await first.release();
      await first.release();
    }

    const owner = launch("hold");
    const ready = await owner.envelope;
    observe(
      ready.status === "acquired",
      "replacement owner acquires released lock",
    );
    if (ready.status !== "acquired") throw new Error(JSON.stringify(ready));
    if (process.platform !== "win32") owner.child.kill("SIGSTOP");
    const contenders = Array.from({ length: 4 }, () => launch("once"));
    for (const contender of contenders) {
      const result = await contender.envelope;
      await contender.exited;
      observe(
        result.status === "failed" && result.code === "contended",
        "concurrent process cannot acquire a paused owner's lock",
      );
    }
    owner.child.kill("SIGKILL");
    await owner.exited;
    const successor = launch("once");
    const result = await successor.envelope;
    await successor.exited;
    observe(
      result.status === "acquired",
      "process exit releases kernel ownership",
    );
    observe(fs.statSync(path).isFile(), "marker survives ownership transfer");
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.once("exit", resolve));
      }
    }
    fs.existsSync = existsSync;
    childProcess.spawnSync = spawnSync;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(
    `${JSON.stringify({ scenario: "kernel-lock-lifecycle", observations, failures }, null, 2)}\n`,
  );
  if (failures.length) process.exitCode = 1;
}
