import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type {
  BrowserBrokerStatus,
  BrowserSessionEndResult,
  BrowserTargetCommandResult,
} from "../../src/browser/runtime-protocol.js";
import {
  BrowserRuntimeBrokerClient,
  browserBrokerPaths,
} from "../../src/browser/runtime-transport.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const tsxPath = join(repositoryRoot, "node_modules", ".bin", "tsx");
const brokerMainPath = join(
  repositoryRoot,
  "src",
  "browser",
  "runtime-broker-main.ts",
);
const clientHelperPath = join(
  repositoryRoot,
  "tests",
  "helpers",
  "browser-broker-client.ts",
);
const browserPath = resolveTestBrowserPath();
const testIfBrowser = browserPath ? it : it.skip;

let brokerProcess: ChildProcess | null = null;
let runtimeRoot: string | null = null;
let barrierServer: Server | null = null;

afterEach(async () => {
  if (
    runtimeRoot &&
    existsSync(browserBrokerPaths(runtimeRoot).descriptorPath)
  ) {
    try {
      await new BrowserRuntimeBrokerClient({
        runtimeRoot,
        timeoutMs: 10_000,
      }).requestOrThrow({ id: randomUUID(), action: "broker.shutdown" });
    } catch {
      brokerProcess?.kill("SIGTERM");
    }
  } else {
    brokerProcess?.kill("SIGTERM");
  }
  if (brokerProcess) await waitForExit(brokerProcess, 12_000);
  if (barrierServer) await closeHttpServer(barrierServer);
  if (runtimeRoot) rmSync(runtimeRoot, { recursive: true, force: true });
  brokerProcess = null;
  runtimeRoot = null;
  barrierServer = null;
});

describe("Browser Runtime Broker real process ownership", () => {
  testIfBrowser(
    "shares one broker-owned headless runtime across clients while distinct targets mutate concurrently",
    async () => {
      runtimeRoot = mkdtempSync(join(tmpdir(), "unicli-broker-integration-"));
      const barrier = await startTwoPartyBarrier();
      barrierServer = barrier.server;
      const broker = spawn(tsxPath, [brokerMainPath], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CHROME_PATH: browserPath!,
          UNICLI_BROWSER_RUNTIME_DIR: runtimeRoot,
          UNICLI_BROWSER_EPHEMERAL: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      brokerProcess = broker;
      const brokerOutput = collectProcessOutput(broker);
      const client = new BrowserRuntimeBrokerClient({
        runtimeRoot,
        timeoutMs: 20_000,
      });
      const initialStatus = await waitForBroker(client, broker, 15_000);

      const partitionId = `integration:${randomUUID()}`;
      const clientInputs = ["agent-a", "agent-b"].map((agentSessionId) => ({
        runtime_root: runtimeRoot!,
        agent_session_id: agentSessionId,
        turn_id: `${agentSessionId}:turn-1`,
        profile_partition_id: partitionId,
        barrier_url: barrier.url,
      }));
      const [left, right] = await Promise.all(
        clientInputs.map((input) => runClientProcess(input)),
      );

      expect(left.data).toEqual({ status: 200, body: "released" });
      expect(right.data).toEqual({ status: 200, body: "released" });
      expect(left.target_id).not.toBe(right.target_id);
      expect(left.runtime_id).toBe(right.runtime_id);
      expect(left.browser_pid).toBe(right.browser_pid);
      expect(left.visibility).toBe("hidden");
      expect(right.visibility).toBe("hidden");
      expect(readParentPid(left.browser_pid)).toBe(initialStatus.broker_pid);

      const status = await client.requestOrThrow<BrowserBrokerStatus>({
        id: randomUUID(),
        action: "broker.status",
      });
      expect(status.runtime_id).toBe(initialStatus.runtime_id);
      expect(status.sessions.sessions).toHaveLength(2);
      expect(status.sessions.target_leases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target_id: left.target_id,
            owner_session_id: "agent-a",
          }),
          expect.objectContaining({
            target_id: right.target_id,
            owner_session_id: "agent-b",
          }),
        ]),
      );
      expect(status.providers.managed).toHaveLength(1);
      expect(status.providers.managed[0]).toEqual(
        expect.objectContaining({
          runtime_id: left.runtime_id,
          browser_pid: left.browser_pid,
          broker_pid: initialStatus.broker_pid,
          profile_partition_id: partitionId,
          visibility: "hidden",
          target_count: 2,
        }),
      );

      for (const agentSessionId of ["agent-a", "agent-b"]) {
        const ended = await client.requestOrThrow<BrowserSessionEndResult>({
          id: randomUUID(),
          action: "session.end",
          agent_session_id: agentSessionId,
        });
        expect(ended.released_targets).toHaveLength(1);
      }
      const afterEnd = await client.requestOrThrow<BrowserBrokerStatus>({
        id: randomUUID(),
        action: "broker.status",
      });
      expect(afterEnd.sessions.sessions).toHaveLength(0);
      expect(afterEnd.sessions.target_leases).toHaveLength(0);
      expect(afterEnd.providers.managed[0]?.target_count).toBe(0);

      await client.requestOrThrow({
        id: randomUUID(),
        action: "broker.shutdown",
      });
      await waitForExit(broker, 12_000);
      expect(processIsAlive(left.browser_pid)).toBe(false);
      expect(existsSync(browserBrokerPaths(runtimeRoot).descriptorPath)).toBe(
        false,
      );
      expect(brokerOutput.stderr()).toBe("");
    },
    45_000,
  );
});

async function startTwoPartyBarrier(): Promise<{
  server: Server;
  url: string;
}> {
  const pending: ServerResponse[] = [];
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.url !== "/barrier") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    pending.push(response);
    if (pending.length !== 2) return;
    for (const waiting of pending.splice(0)) {
      waiting.statusCode = 200;
      waiting.end("released");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Barrier server did not expose a TCP port");
  }
  return {
    server,
    url: `http://127.0.0.1:${String(address.port)}/barrier`,
  };
}

function runClientProcess(
  input: Record<string, string>,
): Promise<BrowserTargetCommandResult> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(input)).toString("base64url");
    const child = spawn(tsxPath, [clientHelperPath, encoded], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = collectProcessOutput(child);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Independent browser broker client timed out"));
    }, 25_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `Independent browser broker client exited ${String(code)}: ${output.stderr()}`,
          ),
        );
        return;
      }
      try {
        resolve(
          JSON.parse(output.stdout().trim()) as BrowserTargetCommandResult,
        );
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function waitForBroker(
  client: BrowserRuntimeBrokerClient,
  processHandle: ChildProcess,
  timeoutMs: number,
): Promise<BrowserBrokerStatus> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(
        `Browser broker exited before readiness with ${String(processHandle.exitCode)}`,
      );
    }
    try {
      return await client.requestOrThrow<BrowserBrokerStatus>({
        id: randomUUID(),
        action: "broker.status",
      });
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(
    `Browser broker did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function collectProcessOutput(child: ChildProcess): {
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

function resolveTestBrowserPath(): string | null {
  const candidates = [
    process.env.UNICLI_BROWSER_TEST_CHROME_PATH,
    process.env.CHROME_PATH,
    process.env.HOME
      ? join(
          process.env.HOME,
          ".cache",
          "unicli",
          "chrome-for-testing",
          "chrome-headless-shell",
        )
      : undefined,
  ];
  return (
    candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
  );
}

function readParentPid(pid: number): number {
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Browser broker process did not exit cleanly"));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
