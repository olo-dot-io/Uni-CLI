/**
 * @owner       src/commands/browser/lifecycle.ts
 * @does        Register Browser Runtime Broker lifecycle, provider start/status, session end/handoff, Chrome tab claim, remote status, and doctor commands.
 * @needs       node:crypto, commander, src/browser bridge/doctor/invocation/runtime-launch/runtime-protocol/runtime-transport/remote-browser, output
 * @feeds       src/commands/browser/index.ts and the public `unicli browser` command tree
 * @breaks      Structured broker/provider/lifecycle errors produce nonzero command exits without legacy transport or direct-CDP fallback.
 * @invariants  Status/doctor are probe-only; broker start launches no provider; provider and visibility are explicit; handoff is linearizable.
 * @side-effects Explicit commands may start/stop the broker, start a selected provider, claim a Chrome tab, or transfer/end Agent sessions.
 * @perf        Status is one local IPC; start is lazy; restart waits at most five seconds for endpoint ownership to turn over.
 * @concurrency Broker lock and target queues own cross-process serialization; handoff starts both endpoint turns before atomic transfer.
 * @test        tests/unit/commands/browser.test.ts, tests/unit/browser-doctor.test.ts, tests/integration/browser-runtime-autostart.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import { Command } from "commander";

import { createBrowserInvocationContext } from "../../browser/invocation-context.js";
import {
  currentBrowserInvocationScope,
  registerBrowserTurnFinalizer,
} from "../../browser/invocation-scope.js";
import { repairBrowserDoctor, runBrowserDoctor } from "../../browser/doctor.js";
import {
  ensureBrowserRuntimeBroker,
  probeBrowserRuntimeBroker,
} from "../../browser/runtime-launch.js";
import type { BrowserBrokerStatus } from "../../browser/runtime-protocol.js";
import { readRemoteEndpoint } from "../../browser/remote-browser.js";
import type { OutputFormat } from "../../types.js";
import { detectFormat, format } from "../../output/formatter.js";
import { makeCtx } from "../../output/envelope.js";
import { mapErrorToExitCode } from "../../output/error-map.js";
import { getOperatorPage, withBrowserOperatorContext } from "./runtime.js";

export function registerBrowserLifecycleCommands(
  browser: Command,
  program: Command,
): void {
  registerBrokerCommands(browser, program);

  browser
    .command("start")
    .description(
      "Start the selected browser provider through the shared broker",
    )
    .action(() =>
      runLifecycleCommand(program, "browser.start", async () =>
        withBrowserOperatorContext(browser, async () => {
          const page = await getOperatorPage(browser, "browser");
          await page.title();
          return {
            ok: true,
            provider: page.scope.provider,
            visibility: page.scope.visibility,
            profile_partition_id: page.scope.profilePartitionId,
            target: await page.browserTargetInfo(),
          };
        }),
      ),
    );

  browser
    .command("status")
    .description(
      "Show broker, provider, session, lease, TTL, and visibility state",
    )
    .option("--json", "JSON output (alias for -f json)")
    .action((options: { json?: boolean }) =>
      runLifecycleCommand(
        program,
        "browser.status",
        async () => readRuntimeStatus(),
        options.json,
      ),
    );

  browser
    .command("remote")
    .description("Show secret-redacted remote CDP provider configuration")
    .action(() =>
      runLifecycleCommand(program, "browser.remote", async () => {
        const configured = readRemoteEndpoint();
        const runtime = await readRuntimeStatus();
        return {
          configured: configured !== null,
          endpoint_origin: configured
            ? `${new URL(configured.endpoint).protocol}//${new URL(configured.endpoint).host}`
            : null,
          broker_provider: runtime.status?.providers.remote ?? null,
          raw_headers_returned: false,
        };
      }),
    );

  browser
    .command("doctor")
    .description(
      "Report broker/provider/lease/visibility truth and exact repairs",
    )
    .option("--json", "JSON output (alias for -f json)")
    .option("--repair", "Start only the windowless broker control plane")
    .action((options: { json?: boolean; repair?: boolean }) =>
      runLifecycleCommand(
        program,
        "browser.doctor",
        async () => {
          const repair = options.repair
            ? await repairBrowserDoctor()
            : undefined;
          const report = await runBrowserDoctor(repair);
          if (report.status !== "ready") process.exitCode = 1;
          return report;
        },
        options.json,
      ),
    );

  browser
    .command("sessions")
    .description("Show live Agent sessions, turns, targets, leases, and TTL")
    .option("--json", "JSON output (alias for -f json)")
    .action((options: { json?: boolean }) =>
      runLifecycleCommand(
        program,
        "browser.sessions",
        async () => {
          const runtime = await readRuntimeStatus();
          return {
            broker_state: runtime.state,
            session_ttl_ms: runtime.status?.session_ttl_ms ?? null,
            ...(runtime.status?.sessions ?? {
              sessions: [],
              tombstoned_session_ids: [],
              target_leases: [],
              pending_release_session_ids: [],
              pending_release_target_ids: [],
            }),
          };
        },
        options.json,
      ),
    );

  browser
    .command("session-end <agent-session-id>")
    .description("End one Agent browser session and release all owned targets")
    .action((agentSessionId: string) =>
      runLifecycleCommand(program, "browser.session_end", async () => {
        const runtime = await probeBrowserRuntimeBroker();
        return runtime.client.requestOrThrow({
          id: randomUUID(),
          action: "session.end",
          agent_session_id: agentSessionId,
        });
      }),
    );

  browser
    .command("bind <tab-id>")
    .description(
      "Claim an explicit existing Chrome tab for the current Agent session",
    )
    .action((tabIdRaw: string) =>
      runLifecycleCommand(program, "browser.bind", async () =>
        withBrowserOperatorContext(
          browser,
          async () => {
            const tabId = parseNonNegativeInteger(tabIdRaw, "tab id");
            const page = await getOperatorPage(browser, "browser");
            return page.claimChromeTab(tabId);
          },
          { provider: "chrome", visibility: "background" },
        ),
      ),
    );

  browser
    .command("handoff <target-id>")
    .description("Atomically transfer a target to another live Agent session")
    .requiredOption("--to-session <id>", "Destination Agent session id")
    .option("--to-turn <id>", "Destination turn id")
    .action(
      (targetId: string, options: { toSession: string; toTurn?: string }) =>
        runLifecycleCommand(program, "browser.handoff", async () =>
          withBrowserOperatorContext(browser, async () => {
            const source = currentBrowserInvocationScope();
            if (!source) throw new Error("Browser invocation scope is missing");
            const runtime = await ensureBrowserRuntimeBroker();
            await runtime.client.requestOrThrow({
              id: randomUUID(),
              action: "session.start",
              context: source.context,
            });
            registerBrowserTurnFinalizer(
              `${source.context.agent_session_id}\0${source.context.turn_id}`,
              () =>
                runtime.client.requestOrThrow({
                  id: randomUUID(),
                  action: "turn.end",
                  context: source.context,
                }),
            );
            const destination = createBrowserInvocationContext({
              transport: "cli",
              agentSessionId: options.toSession,
              turnId: options.toTurn ?? `handoff:${randomUUID()}`,
              profilePartitionId: source.profilePartitionId,
            });
            await runtime.client.requestOrThrow({
              id: randomUUID(),
              action: "session.start",
              context: destination,
            });
            const lease = await runtime.client.requestOrThrow({
              id: randomUUID(),
              action: "target.handoff",
              target_id: targetId,
              from: source.context,
              to: destination,
            });
            await runtime.client.requestOrThrow({
              id: randomUUID(),
              action: "turn.end",
              context: destination,
            });
            return lease;
          }),
        ),
    );
}

function registerBrokerCommands(browser: Command, program: Command): void {
  const broker = browser
    .command("broker")
    .description("Manage the windowless Browser Runtime Broker control plane");
  broker
    .command("start")
    .description("Start the broker without starting a browser")
    .action(() =>
      runLifecycleCommand(program, "browser.broker.start", async () => {
        const connection = await ensureBrowserRuntimeBroker();
        return {
          state: "running",
          started: connection.spawned,
          browser_provider_started: false,
          ...connection.status,
        };
      }),
    );
  broker
    .command("status")
    .description("Probe broker status without auto-start")
    .action(() =>
      runLifecycleCommand(program, "browser.broker.status", readRuntimeStatus),
    );
  broker
    .command("stop")
    .description("Stop the broker and release all sessions/providers")
    .action(() =>
      runLifecycleCommand(program, "browser.broker.stop", async () => {
        let connection: Awaited<ReturnType<typeof probeBrowserRuntimeBroker>>;
        try {
          connection = await probeBrowserRuntimeBroker();
        } catch (error) {
          if (isBrokerUnavailable(error)) {
            return { state: "stopped", already_stopped: true };
          }
          throw error;
        }
        const result = await connection.client.requestOrThrow({
          id: randomUUID(),
          action: "broker.shutdown",
        });
        await waitForBrokerStop();
        return { state: "stopped", already_stopped: false, result };
      }),
    );
  broker
    .command("restart")
    .description("Restart the broker without starting a browser provider")
    .action(() =>
      runLifecycleCommand(program, "browser.broker.restart", async () => {
        try {
          const existing = await probeBrowserRuntimeBroker();
          await existing.client.requestOrThrow({
            id: randomUUID(),
            action: "broker.shutdown",
          });
          await waitForBrokerStop();
        } catch (error) {
          if (!isBrokerUnavailable(error)) throw error;
        }
        const connection = await ensureBrowserRuntimeBroker();
        return {
          state: "running",
          browser_provider_started: false,
          ...connection.status,
        };
      }),
    );
}

async function readRuntimeStatus(): Promise<{
  state: "running" | "stopped";
  status?: BrowserBrokerStatus;
}> {
  try {
    const connection = await probeBrowserRuntimeBroker({ timeoutMs: 1_000 });
    return { state: "running", status: connection.status };
  } catch (error) {
    if (isBrokerUnavailable(error)) return { state: "stopped" };
    throw error;
  }
}

async function waitForBrokerStop(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await probeBrowserRuntimeBroker({ timeoutMs: 250 });
    } catch (error) {
      if (isBrokerUnavailable(error)) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Browser broker did not stop within 5000ms");
}

function isBrokerUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "browser_broker_unavailable"
  );
}

function parseNonNegativeInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is outside the supported integer range`);
  }
  return parsed;
}

async function runLifecycleCommand(
  program: Command,
  command: string,
  operation: () => Promise<unknown>,
  jsonAlias = false,
): Promise<void> {
  const startedAt = Date.now();
  const outputFormat = detectFormat(
    jsonAlias ? "json" : (program.opts().format as OutputFormat | undefined),
  );
  const context = makeCtx(command, startedAt);
  try {
    const result = await operation();
    context.duration_ms = Date.now() - startedAt;
    console.log(
      format(
        result as Record<string, unknown>,
        undefined,
        outputFormat,
        context,
      ),
    );
  } catch (error) {
    const structured = error as Partial<{
      code: string;
      suggestion: string;
      retryable: boolean;
    }>;
    context.duration_ms = Date.now() - startedAt;
    context.error = {
      code: structured.code ?? "browser_runtime_error",
      message: error instanceof Error ? error.message : String(error),
      ...(structured.suggestion ? { suggestion: structured.suggestion } : {}),
      retryable: structured.retryable ?? false,
    };
    console.error(format(null, undefined, outputFormat, context));
    process.exitCode = mapErrorToExitCode(error);
  }
}
