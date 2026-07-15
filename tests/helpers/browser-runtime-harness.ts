import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserBrokerStatus } from "../../src/browser/runtime-protocol.js";
import {
  BrowserRuntimeBrokerClient,
  browserBrokerPaths,
} from "../../src/browser/runtime-transport.js";

export const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
export const tsxPath = join(repositoryRoot, "node_modules", ".bin", "tsx");
export const browserBrokerMainPath = join(
  repositoryRoot,
  "src",
  "browser",
  "runtime-broker-main.ts",
);

export class RealBrowserBrokerHarness {
  readonly runtimeRoot = mkdtempSync(
    join(tmpdir(), "unicli-broker-integration-"),
  );
  readonly client = new BrowserRuntimeBrokerClient({
    runtimeRoot: this.runtimeRoot,
    timeoutMs: 20_000,
  });
  private processHandle: ChildProcess | null = null;
  private output: ReturnType<typeof collectProcessOutput> | null = null;

  constructor(readonly browserPath: string) {}

  async start(env: Record<string, string> = {}): Promise<BrowserBrokerStatus> {
    if (this.processHandle) {
      throw new Error("Real browser broker harness is already started");
    }
    const child = spawn(tsxPath, [browserBrokerMainPath], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...env,
        CHROME_PATH: this.browserPath,
        UNICLI_BROWSER_RUNTIME_DIR: this.runtimeRoot,
        UNICLI_BROWSER_EPHEMERAL: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.processHandle = child;
    this.output = collectProcessOutput(child);
    return waitForBroker(this.client, child, () => this.stderr(), 15_000);
  }

  async shutdownGracefully(): Promise<void> {
    const child = this.requireProcess();
    await this.client.requestOrThrow({
      id: randomUUID(),
      action: "broker.shutdown",
    });
    await waitForExit(child, 12_000);
  }

  async cleanup(): Promise<void> {
    const child = this.processHandle;
    if (child && child.exitCode === null) {
      if (existsSync(browserBrokerPaths(this.runtimeRoot).descriptorPath)) {
        try {
          await this.client.requestOrThrow({
            id: randomUUID(),
            action: "broker.shutdown",
          });
        } catch {
          child.kill("SIGTERM");
        }
      } else {
        child.kill("SIGTERM");
      }
      try {
        await waitForExit(child, 12_000);
      } catch {
        child.kill("SIGKILL");
      }
    }
    rmSync(this.runtimeRoot, { recursive: true, force: true });
    this.processHandle = null;
  }

  brokerPid(): number {
    const pid = this.requireProcess().pid;
    if (!pid) throw new Error("Browser broker process has no PID");
    return pid;
  }

  stderr(): string {
    return this.output?.stderr() ?? "";
  }

  endpointExists(): boolean {
    return existsSync(browserBrokerPaths(this.runtimeRoot).descriptorPath);
  }

  private requireProcess(): ChildProcess {
    if (!this.processHandle) {
      throw new Error("Real browser broker harness has not been started");
    }
    return this.processHandle;
  }
}

export function resolveTestBrowserPath(): string | null {
  const candidates = [
    process.env.UNICLI_BROWSER_TEST_CHROME_PATH,
    process.env.CHROME_PATH,
  ];
  return (
    candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
  );
}

export function readParentPid(pid: number): number {
  if (process.platform === "win32") {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}").ParentProcessId`,
      ],
      { encoding: "utf8" },
    );
    return Number.parseInt(output.trim(), 10);
  }
  return Number.parseInt(
    execFileSync("ps", ["-p", String(pid), "-o", "ppid="], {
      encoding: "utf8",
    }).trim(),
    10,
  );
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function collectProcessOutput(child: ChildProcess): {
  stdout: () => string;
  stderr: () => string;
} {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  return {
    stdout: () => Buffer.concat(stdout).toString("utf8"),
    stderr: () => Buffer.concat(stderr).toString("utf8"),
  };
}

export function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Browser broker process did not exit cleanly"));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForBroker(
  client: BrowserRuntimeBrokerClient,
  processHandle: ChildProcess,
  readStderr: () => string,
  timeoutMs: number,
): Promise<BrowserBrokerStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(
        `Browser broker exited before readiness with ${String(processHandle.exitCode)}: ${readStderr()}`,
      );
    }
    try {
      return await client.requestOrThrow<BrowserBrokerStatus>({
        id: randomUUID(),
        action: "broker.status",
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    `Browser broker did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}: ${readStderr()}`,
  );
}
