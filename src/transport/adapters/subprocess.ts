/**
 * @owner       src::transport::adapters::subprocess
 * @does        Execute commands, waits, and desktop launch plans through request-contained native process groups.
 * @needs       contained process runner, transport envelopes, event queue
 * @feeds       compute launch/wait fallback and direct subprocess transport actions
 * @breaks      Ignoring request cancellation lets launcher descendants mutate the host after the owning Agent turn ends.
 * @invariants  Abort and timeout await the owned process group; ordinary command failures become envelopes; arbitrary commands and external app delivery are outcome-ambiguous because they may daemonize outside that group.
 * @side-effects Executes arbitrary declared commands and can launch desktop applications.
 * @perf        Buffers stdout/stderr once and streams each chunk to observers.
 * @concurrency Each action owns one process group; event streaming is serialized through one adapter queue.
 * @test        tests/unit/transport/adapters/subprocess.test.ts and compute launch cancellation blackboxes
 * @stability   stable
 * @since       2026-07-15
 */

import { setTimeout as delay } from "node:timers/promises";
import { err, exitCodeFor, ok } from "../../core/envelope.js";
import type { Envelope } from "../../core/envelope.js";
import {
  isOperationOutcomeAmbiguousError,
  runContainedProcess,
  type CancellationDelivery,
} from "../contained-process.js";
import type {
  ActionRequest,
  ActionResult,
  Capability,
  Snapshot,
  SnapshotFormat,
  TransportAdapter,
  TransportContext,
  TransportEvent,
  TransportKind,
} from "../types.js";

const SUBPROCESS_STEPS = [
  "exec",
  "write_temp",
  "download",
  "wait",
  "launch_app",
] as const;

const SUBPROCESS_CAPABILITY: Capability = {
  steps: SUBPROCESS_STEPS,
  snapshotFormats: ["text", "json"] as readonly SnapshotFormat[],
  mutatesHost: true,
};

interface ExecParams {
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  env?: unknown;
  stdin?: unknown;
  timeoutMs?: unknown;
}

interface LaunchParams {
  app?: unknown;
  args?: unknown;
  debugPort?: unknown;
  timeoutMs?: unknown;
}

interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CommandPlan {
  command: string;
  args: string[];
}

export function launchPlanForPlatform(
  platform: NodeJS.Platform,
  app: string,
  args: readonly string[] = [],
  debugPort?: number,
): CommandPlan {
  const launchArgs =
    typeof debugPort === "number" && Number.isFinite(debugPort)
      ? [...args, `--remote-debugging-port=${debugPort}`]
      : [...args];
  if (platform === "darwin") {
    return {
      command: "open",
      args: [
        "-a",
        app,
        ...(launchArgs.length > 0 ? ["--args", ...launchArgs] : []),
      ],
    };
  }
  if (platform === "win32") {
    const command =
      launchArgs.length > 0
        ? "Start-Process -FilePath $args[0] -ArgumentList $args[1]"
        : "Start-Process -FilePath $args[0]";
    const planArgs = [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
      app,
    ];
    if (launchArgs.length > 0) {
      planArgs.push(launchArgs.join(" "));
    }
    return { command: "powershell.exe", args: planArgs };
  }
  return {
    command: "gtk-launch",
    args: [app, ...launchArgs],
  };
}

/** Minimal async queue fed by stdout/stderr chunks, drained by `stream()`. */
class EventQueue {
  private readonly buffer: TransportEvent[] = [];
  private readonly waiters: Array<(v: IteratorResult<TransportEvent>) => void> =
    [];
  private closed = false;

  push(e: TransportEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: e, done: false });
    else this.buffer.push(e);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) {
      const w = this.waiters.shift();
      if (w) w({ value: undefined as unknown as TransportEvent, done: true });
    }
  }

  async next(): Promise<IteratorResult<TransportEvent>> {
    const buffered = this.buffer.shift();
    if (buffered) return { value: buffered, done: false };
    if (this.closed)
      return { value: undefined as unknown as TransportEvent, done: true };
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export class SubprocessTransport implements TransportAdapter {
  readonly kind: TransportKind = "subprocess";
  readonly capability: Capability = SUBPROCESS_CAPABILITY;

  private ctx: TransportContext | undefined;
  private readonly queue = new EventQueue();
  private lastOutcome: ExecOutcome | undefined;

  async open(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
  }

  async snapshot(opts?: {
    format?: SnapshotFormat;
    signal?: AbortSignal;
  }): Promise<Snapshot> {
    opts?.signal?.throwIfAborted();
    const format = opts?.format ?? "text";
    if (format === "json") {
      return {
        format: "json",
        data: JSON.stringify(this.lastOutcome ?? {}),
      };
    }
    return { format: "text", data: this.lastOutcome?.stdout ?? "" };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    const start = Date.now();
    try {
      req.signal?.throwIfAborted();
      let envelope: Envelope<unknown>;
      switch (req.kind) {
        case "exec":
          envelope = await this.doExec(req.params as ExecParams, req.signal);
          break;
        case "launch_app":
          envelope = await this.doLaunch(
            req.params as LaunchParams,
            req.signal,
          );
          break;
        case "wait": {
          const p = req.params as { seconds?: unknown; ms?: unknown };
          const ms =
            typeof p.ms === "number"
              ? p.ms
              : typeof p.seconds === "number"
                ? p.seconds * 1000
                : 0;
          if (ms > 0) {
            await delay(
              ms,
              undefined,
              req.signal ? { signal: req.signal } : {},
            );
          }
          envelope = ok(undefined);
          break;
        }
        default:
          envelope = err({
            transport: "subprocess",
            step: 0,
            action: req.kind,
            reason: `unsupported action "${req.kind}" for subprocess transport`,
            suggestion: `subprocess transport supports: ${SUBPROCESS_STEPS.join(", ")}`,
            minimum_capability: `subprocess.${req.kind}`,
            exit_code: exitCodeFor("usage_error"),
          });
      }
      envelope.elapsedMs = Date.now() - start;
      return envelope as ActionResult<T>;
    } catch (e) {
      if (isOperationOutcomeAmbiguousError(e)) throw e;
      req.signal?.throwIfAborted();
      const msg = e instanceof Error ? e.message : String(e);
      return err({
        transport: "subprocess",
        step: 0,
        action: req.kind,
        reason: msg,
        suggestion: "inspect the command, args, and environment",
        retryable: false,
      });
    }
  }

  /** Optional event stream — drains stdout/stderr pushed by `doExec`. */
  stream(): AsyncIterable<TransportEvent> {
    const queue = this.queue;
    return {
      [Symbol.asyncIterator](): AsyncIterator<TransportEvent> {
        return {
          async next() {
            return queue.next();
          },
          async return() {
            return {
              value: undefined as unknown as TransportEvent,
              done: true,
            };
          },
        };
      },
    };
  }

  async close(): Promise<void> {
    this.ctx = undefined;
    this.queue.close();
  }

  // ── internals ────────────────────────────────────────────────────

  private async doLaunch(
    p: LaunchParams,
    signal?: AbortSignal,
  ): Promise<Envelope<ExecOutcome>> {
    const app = typeof p.app === "string" ? p.app.trim() : "";
    if (!app) {
      return err({
        transport: "subprocess",
        step: 0,
        action: "launch_app",
        reason: "missing required param `app`",
        suggestion: "pass params.app with the application name or desktop id",
        retryable: false,
        exit_code: exitCodeFor("usage_error"),
      });
    }

    const args = Array.isArray(p.args) ? p.args.map((arg) => String(arg)) : [];
    const debugPort =
      typeof p.debugPort === "number"
        ? p.debugPort
        : typeof p.debugPort === "string"
          ? Number(p.debugPort)
          : undefined;
    const plan = launchPlanForPlatform(process.platform, app, args, debugPort);
    return this.doExec(
      {
        command: plan.command,
        args: plan.args,
        timeoutMs: p.timeoutMs,
      },
      signal,
      "outcome-ambiguous",
    );
  }

  private async doExec(
    p: ExecParams,
    signal?: AbortSignal,
    cancellationDelivery: CancellationDelivery = "outcome-ambiguous",
  ): Promise<Envelope<ExecOutcome>> {
    const command = typeof p.command === "string" ? p.command : undefined;
    if (!command) {
      return err({
        transport: "subprocess",
        step: 0,
        action: "exec",
        reason: "missing required param `command`",
        suggestion: "pass params.command (binary name or absolute path)",
        retryable: false,
        exit_code: exitCodeFor("usage_error"),
      });
    }
    const args = Array.isArray(p.args) ? p.args.map((a) => String(a)) : [];
    const cwd = typeof p.cwd === "string" ? p.cwd : this.ctx?.cwd;
    const envExtra =
      p.env && typeof p.env === "object" && !Array.isArray(p.env)
        ? (p.env as Record<string, string>)
        : undefined;
    const env = envExtra
      ? ({ ...process.env, ...envExtra } as NodeJS.ProcessEnv)
      : undefined;
    const stdin = typeof p.stdin === "string" ? p.stdin : undefined;
    const timeout =
      typeof p.timeoutMs === "number"
        ? p.timeoutMs
        : typeof p.timeoutMs === "string"
          ? Number(p.timeoutMs)
          : undefined;

    const result = await runContainedProcess(command, args, {
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      ...(stdin === undefined ? {} : { input: stdin }),
      ...(timeout === undefined ? {} : { timeoutMs: timeout }),
      ...(signal ? { signal } : {}),
      cancellationDelivery,
      onStdout: (chunk) => {
        this.queue.push({
          ts: Date.now(),
          kind: "stdout",
          payload: chunk.toString("utf8"),
        });
      },
      onStderr: (chunk) => {
        this.queue.push({
          ts: Date.now(),
          kind: "stderr",
          payload: chunk.toString("utf8"),
        });
      },
    });
    const outcome: ExecOutcome = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
    this.lastOutcome = outcome;
    if (outcome.exitCode !== 0) {
      return err({
        transport: "subprocess",
        step: 0,
        action: "exec",
        reason: `process \`${command}\` exited with code ${String(outcome.exitCode)}${outcome.stderr ? `: ${outcome.stderr.slice(0, 200)}` : ""}`,
        suggestion: "inspect stderr for the failure cause",
        retryable: false,
      });
    }
    return ok(outcome);
  }
}
