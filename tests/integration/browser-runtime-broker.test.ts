import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  BrowserBrokerStatus,
  BrowserSessionEndResult,
  BrowserTargetCommandResult,
} from "../../src/browser/runtime-protocol.js";
import {
  RealBrowserBrokerHarness,
  collectProcessOutput,
  processIsAlive,
  readParentPid,
  repositoryRoot,
  resolveTestBrowserPath,
  tsxPath,
} from "../helpers/browser-runtime-harness.js";

const clientHelperPath = join(
  repositoryRoot,
  "tests",
  "helpers",
  "browser-broker-client.ts",
);
const browserPath = resolveTestBrowserPath();
const testIfBrowser = browserPath ? it : it.skip;

let harness: RealBrowserBrokerHarness | null = null;
let barrierServer: Server | null = null;

afterEach(async () => {
  await harness?.cleanup();
  if (barrierServer) await closeHttpServer(barrierServer);
  harness = null;
  barrierServer = null;
});

describe("Browser Runtime Broker real process ownership", () => {
  testIfBrowser(
    "shares one broker-owned headless runtime across clients while distinct targets mutate concurrently",
    async () => {
      const runtime = new RealBrowserBrokerHarness(browserPath!);
      harness = runtime;
      const barrier = await startTwoPartyBarrier();
      barrierServer = barrier.server;
      const initialStatus = await runtime.start();
      const partitionId = `integration:${randomUUID()}`;
      const clientInputs = ["agent-a", "agent-b"].map((agentSessionId) => ({
        runtime_root: runtime.runtimeRoot,
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

      const status = await runtime.client.requestOrThrow<BrowserBrokerStatus>({
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
        const ended =
          await runtime.client.requestOrThrow<BrowserSessionEndResult>({
            id: randomUUID(),
            action: "session.end",
            agent_session_id: agentSessionId,
          });
        expect(ended.released_targets).toHaveLength(1);
      }
      const afterEnd = await runtime.client.requestOrThrow<BrowserBrokerStatus>(
        {
          id: randomUUID(),
          action: "broker.status",
        },
      );
      expect(afterEnd.sessions.sessions).toHaveLength(0);
      expect(afterEnd.sessions.target_leases).toHaveLength(0);
      expect(afterEnd.providers.managed[0]?.target_count).toBe(0);

      await runtime.shutdownGracefully();
      expect(processIsAlive(left.browser_pid)).toBe(false);
      expect(runtime.endpointExists()).toBe(false);
      expect(runtime.stderr()).toBe("");
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

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
