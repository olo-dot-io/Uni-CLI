import { execFileSync, spawn } from "node:child_process";
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
}, 30_000);

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

  testIfBrowser(
    "reuses one hidden target across independent CLI turns with the same Agent session",
    async () => {
      const runtime = new RealBrowserBrokerHarness(browserPath!);
      harness = runtime;
      const origin = await startHtmlFixture();
      barrierServer = origin.server;
      await runtime.start();

      const opened = await runCliProcess(runtime.runtimeRoot, [
        "browser",
        "--session",
        "cli-agent",
        "--turn",
        "cli-turn-1",
        "open",
        origin.url,
      ]);
      const currentUrl = await runCliProcess(runtime.runtimeRoot, [
        "browser",
        "--session",
        "cli-agent",
        "--turn",
        "cli-turn-2",
        "get",
        "url",
      ]);

      expect(opened).toMatchObject({
        error: null,
        data: {
          requested_url: origin.url,
          url: origin.url,
          title: "shared CLI target",
        },
      });
      expect(currentUrl).toMatchObject({
        error: null,
        data: { value: origin.url },
      });
      const status = await runtime.client.requestOrThrow<BrowserBrokerStatus>({
        id: randomUUID(),
        action: "broker.status",
      });
      expect(status.sessions.sessions).toEqual([
        expect.objectContaining({
          agent_session_id: "cli-agent",
          active_turn_ids: [],
          target_ids: [status.sessions.target_leases[0]?.target_id],
        }),
      ]);
      expect(status.sessions.target_leases).toEqual([
        expect.objectContaining({
          owner_session_id: "cli-agent",
          provider: "managed",
          visibility: "hidden",
        }),
      ]);
      expect(status.providers.managed).toEqual([
        expect.objectContaining({
          visibility: "hidden",
          target_count: 1,
        }),
      ]);
      if (process.platform !== "win32") {
        const browserCommand = execFileSync(
          "ps",
          [
            "-p",
            String(status.providers.managed[0]!.browser_pid),
            "-o",
            "command=",
          ],
          { encoding: "utf8" },
        );
        expect(browserCommand).toMatch(
          /chrome-headless-shell|--headless(?:=new)?/,
        );
      }

      await runtime.shutdownGracefully();
      expect(runtime.stderr()).toBe("");
    },
    45_000,
  );

  testIfBrowser(
    "recovers the hidden browser after a broker crash and discards targets whose leases were lost",
    async () => {
      const runtime = new RealBrowserBrokerHarness(browserPath!);
      harness = runtime;
      const initialBroker = await runtime.start();
      const firstContext = {
        agent_session_id: "crash-agent",
        turn_id: "before-crash",
        transport: "cli" as const,
        profile_partition_id: "crash-profile",
      };
      await runtime.client.requestOrThrow({
        id: randomUUID(),
        action: "session.start",
        context: firstContext,
      });
      const beforeCrash =
        await runtime.client.requestOrThrow<BrowserTargetCommandResult>({
          id: randomUUID(),
          action: "target.command",
          context: firstContext,
          provider: "managed",
          visibility: "hidden",
          profile_partition_id: "crash-profile",
          isolated: false,
          ephemeral: true,
          command: {
            method: "evaluate",
            expression: 'document.title = "owned before crash"; document.title',
          },
        });
      expect(beforeCrash.data).toBe("owned before crash");

      await runtime.crashBroker(
        beforeCrash.browser_pid,
        initialBroker.broker_pid,
      );
      expect(processIsAlive(beforeCrash.browser_pid)).toBe(true);
      const restartedBroker = await runtime.start();
      expect(restartedBroker.broker_pid).not.toBe(initialBroker.broker_pid);
      expect(restartedBroker.runtime_id).not.toBe(initialBroker.runtime_id);

      const recoveredContext = {
        ...firstContext,
        turn_id: "after-crash",
      };
      await runtime.client.requestOrThrow({
        id: randomUUID(),
        action: "session.start",
        context: recoveredContext,
      });
      const afterCrash =
        await runtime.client.requestOrThrow<BrowserTargetCommandResult>({
          id: randomUUID(),
          action: "target.command",
          context: recoveredContext,
          provider: "managed",
          visibility: "hidden",
          profile_partition_id: "crash-profile",
          isolated: false,
          ephemeral: true,
          command: { method: "title" },
        });

      expect(afterCrash.browser_pid).toBe(beforeCrash.browser_pid);
      expect(afterCrash.runtime_id).toBe(beforeCrash.runtime_id);
      expect(afterCrash.data).not.toBe("owned before crash");
      const status = await runtime.client.requestOrThrow<BrowserBrokerStatus>({
        id: randomUUID(),
        action: "broker.status",
      });
      expect(status.providers.managed).toEqual([
        expect.objectContaining({
          recovered: true,
          browser_pid: beforeCrash.browser_pid,
          target_count: 1,
        }),
      ]);
      const discovered = (await fetch(
        `http://127.0.0.1:${String(status.providers.managed[0]!.cdp_port)}/json/list`,
      ).then((response) => response.json())) as Array<{
        id?: string;
        type?: string;
      }>;
      const pageTargets = discovered.filter((target) => target.type === "page");
      expect(pageTargets.map((target) => target.id)).toEqual([
        afterCrash.target_id,
      ]);

      await runtime.client.requestOrThrow({
        id: randomUUID(),
        action: "session.end",
        agent_session_id: recoveredContext.agent_session_id,
      });
      await runtime.shutdownGracefully();
      expect(processIsAlive(beforeCrash.browser_pid)).toBe(false);
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

async function startHtmlFixture(): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>shared CLI target</title>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTML fixture did not expose a TCP port");
  }
  return {
    server,
    url: `http://127.0.0.1:${String(address.port)}/`,
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

function runCliProcess(
  runtimeRoot: string,
  args: string[],
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(repositoryRoot, "dist", "main.js"), "-f", "json", ...args],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          UNICLI_ALLOW_LOCAL: "1",
          UNICLI_BROWSER_RUNTIME_DIR: runtimeRoot,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = collectProcessOutput(child);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI browser command timed out: ${args.join(" ")}`));
    }, 25_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `CLI browser command exited ${String(code)}: ${output.stderr()}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(output.stdout().trim()) as Record<string, unknown>);
      } catch (error) {
        reject(
          new Error(
            `CLI browser command returned invalid JSON: ${output.stdout()} ${output.stderr()}`,
            { cause: error },
          ),
        );
      }
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
