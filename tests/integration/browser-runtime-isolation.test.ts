import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { BrowserInvocationContext } from "../../src/browser/invocation-context.js";
import type {
  BrowserPageCommand,
  BrowserTargetCommandResult,
} from "../../src/browser/runtime-protocol.js";
import {
  RealBrowserBrokerHarness,
  resolveTestBrowserPath,
} from "../helpers/browser-runtime-harness.js";

const browserPath = resolveTestBrowserPath();
const testIfBrowser = browserPath ? it : it.skip;

let harness: RealBrowserBrokerHarness | null = null;
let originServer: Server | null = null;

afterEach(async () => {
  await harness?.cleanup();
  if (originServer) await closeHttpServer(originServer);
  harness = null;
  originServer = null;
});

describe("managed browser profile partitions and target ownership", () => {
  testIfBrowser(
    "shares declared auth storage, isolates disposable contexts, and requires explicit handoff",
    async () => {
      const runtime = new RealBrowserBrokerHarness(browserPath!);
      harness = runtime;
      const origin = await startOriginServer();
      originServer = origin.server;
      await runtime.start();
      const partitionId = `storage:${randomUUID()}`;
      const sharedA = context("shared-a", partitionId);
      const sharedB = context("shared-b", partitionId);
      const isolatedA = context("isolated-a", partitionId);
      const isolatedB = context("isolated-b", partitionId);
      for (const invocation of [sharedA, sharedB, isolatedA, isolatedB]) {
        await runtime.client.requestOrThrow({
          id: randomUUID(),
          action: "session.start",
          context: invocation,
        });
      }

      const [sharedATarget, sharedBTarget, isolatedATarget, isolatedBTarget] =
        await Promise.all([
          command(runtime, sharedA, false, {
            method: "navigate",
            url: origin.url,
          }),
          command(runtime, sharedB, false, {
            method: "navigate",
            url: origin.url,
          }),
          command(runtime, isolatedA, true, {
            method: "navigate",
            url: origin.url,
          }),
          command(runtime, isolatedB, true, {
            method: "navigate",
            url: origin.url,
          }),
        ]);
      expect(
        new Set(
          [sharedATarget, sharedBTarget, isolatedATarget, isolatedBTarget].map(
            (target) => target.target_id,
          ),
        ).size,
      ).toBe(4);
      expect(
        new Set(
          [sharedATarget, sharedBTarget, isolatedATarget, isolatedBTarget].map(
            (target) => target.runtime_id,
          ),
        ).size,
      ).toBe(1);
      expect(
        new Set(
          [sharedATarget, sharedBTarget, isolatedATarget, isolatedBTarget].map(
            (target) => target.browser_pid,
          ),
        ).size,
      ).toBe(1);

      await command(
        runtime,
        sharedA,
        false,
        {
          method: "evaluate",
          expression:
            'localStorage.setItem("auth", "shared-token"); localStorage.getItem("auth")',
        },
        sharedATarget.target_id,
      );
      expect(
        await evaluateStorage(runtime, sharedB, false, sharedBTarget.target_id),
      ).toBe("shared-token");
      expect(
        await evaluateStorage(
          runtime,
          isolatedA,
          true,
          isolatedATarget.target_id,
        ),
      ).toBeNull();
      expect(
        await evaluateStorage(
          runtime,
          isolatedB,
          true,
          isolatedBTarget.target_id,
        ),
      ).toBeNull();

      await command(
        runtime,
        isolatedA,
        true,
        {
          method: "evaluate",
          expression:
            'localStorage.setItem("auth", "isolated-a-token"); localStorage.getItem("auth")',
        },
        isolatedATarget.target_id,
      );
      expect(
        await evaluateStorage(
          runtime,
          isolatedA,
          true,
          isolatedATarget.target_id,
        ),
      ).toBe("isolated-a-token");
      expect(
        await evaluateStorage(
          runtime,
          isolatedB,
          true,
          isolatedBTarget.target_id,
        ),
      ).toBeNull();
      expect(
        await evaluateStorage(runtime, sharedB, false, sharedBTarget.target_id),
      ).toBe("shared-token");

      await expect(
        command(
          runtime,
          sharedB,
          false,
          { method: "title" },
          sharedATarget.target_id,
        ),
      ).rejects.toMatchObject({ code: "browser_target_owned" });
      const handedOff = await runtime.client.requestOrThrow<{
        owner_session_id: string;
        target_id: string;
      }>({
        id: randomUUID(),
        action: "target.handoff",
        target_id: sharedATarget.target_id,
        from: sharedA,
        to: sharedB,
      });
      expect(handedOff).toEqual(
        expect.objectContaining({
          target_id: sharedATarget.target_id,
          owner_session_id: sharedB.agent_session_id,
        }),
      );
      expect(
        await evaluateStorage(runtime, sharedB, false, sharedATarget.target_id),
      ).toBe("shared-token");
      await expect(
        evaluateStorage(runtime, sharedA, false, sharedATarget.target_id),
      ).rejects.toMatchObject({ code: "browser_target_owned" });

      const sharedAEnd = await runtime.client.requestOrThrow<{
        released_targets: unknown[];
      }>({
        id: randomUUID(),
        action: "session.end",
        agent_session_id: sharedA.agent_session_id,
      });
      expect(sharedAEnd.released_targets).toHaveLength(0);
      for (const invocation of [sharedB, isolatedA, isolatedB]) {
        await runtime.client.requestOrThrow({
          id: randomUUID(),
          action: "session.end",
          agent_session_id: invocation.agent_session_id,
        });
      }
      const status = await runtime.client.requestOrThrow<{
        sessions: { sessions: unknown[]; target_leases: unknown[] };
        providers: { managed: Array<{ target_count: number }> };
      }>({ id: randomUUID(), action: "broker.status" });
      expect(status.sessions.sessions).toHaveLength(0);
      expect(status.sessions.target_leases).toHaveLength(0);
      expect(status.providers.managed[0]?.target_count).toBe(0);
      await runtime.shutdownGracefully();
      expect(runtime.stderr()).toBe("");
    },
    45_000,
  );
});

function context(
  agentSessionId: string,
  partitionId: string,
): BrowserInvocationContext {
  return {
    agent_session_id: agentSessionId,
    turn_id: `${agentSessionId}:turn-1`,
    transport: "cli",
    profile_partition_id: partitionId,
  };
}

function command(
  runtime: RealBrowserBrokerHarness,
  invocation: BrowserInvocationContext,
  isolated: boolean,
  pageCommand: BrowserPageCommand,
  targetId?: string,
): Promise<BrowserTargetCommandResult> {
  return runtime.client.requestOrThrow({
    id: randomUUID(),
    action: "target.command",
    context: invocation,
    ...(targetId ? { target_id: targetId } : {}),
    provider: "managed",
    visibility: "hidden",
    profile_partition_id: invocation.profile_partition_id!,
    isolated,
    ephemeral: true,
    command: pageCommand,
  });
}

async function evaluateStorage(
  runtime: RealBrowserBrokerHarness,
  invocation: BrowserInvocationContext,
  isolated: boolean,
  targetId: string,
): Promise<unknown> {
  const result = await command(
    runtime,
    invocation,
    isolated,
    { method: "evaluate", expression: 'localStorage.getItem("auth")' },
    targetId,
  );
  return result.data;
}

async function startOriginServer(): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>storage fixture</title>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Storage origin server did not expose a TCP port");
  }
  return {
    server,
    url: `http://127.0.0.1:${String(address.port)}/`,
  };
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
