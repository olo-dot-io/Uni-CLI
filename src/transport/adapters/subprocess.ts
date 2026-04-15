/**
 * SubprocessTransport — wraps `child_process.spawn` behind the
 * TransportAdapter interface.
 *
 * Mirrors the contract of the existing yaml-runner `exec` step
 * (command + args + stdin + env + cwd + timeout) and adds a lightweight
 * event stream (`stream()`) for callers that want to observe stdout/stderr
 * chunks as they arrive.
 */

import { spawn } from "node:child_process";
import { err, exitCodeFor, ok } from "../../core/envelope.js";
import type { Envelope } from "../../core/envelope.js";
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

interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
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

  async snapshot(opts?: { format?: SnapshotFormat }): Promise<Snapshot> {
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
      let envelope: Envelope<unknown>;
      switch (req.kind) {
        case "exec":
          envelope = await this.doExec(req.params as ExecParams);
          break;
        case "wait": {
          const p = req.params as { seconds?: unknown; ms?: unknown };
          const ms =
            typeof p.ms === "number"
              ? p.ms
              : typeof p.seconds === "number"
                ? p.seconds * 1000
                : 0;
          if (ms > 0) await new Promise((r) => setTimeout(r, ms));
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

  private async doExec(p: ExecParams): Promise<Envelope<ExecOutcome>> {
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

    return new Promise<Envelope<ExecOutcome>>((resolve) => {
      let settled = false;
      let child;
      try {
        child = spawn(command, args, {
          cwd,
          env,
          timeout,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        resolve(
          err({
            transport: "subprocess",
            step: 0,
            action: "exec",
            reason: msg,
            suggestion: `check that \`${command}\` is installed and on PATH`,
            retryable: false,
          }),
        );
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
        this.queue.push({
          ts: Date.now(),
          kind: "stdout",
          payload: chunk.toString("utf8"),
        });
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
        this.queue.push({
          ts: Date.now(),
          kind: "stderr",
          payload: chunk.toString("utf8"),
        });
      });

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        resolve(
          err({
            transport: "subprocess",
            step: 0,
            action: "exec",
            reason: error.message,
            suggestion: `check that \`${command}\` is installed and on PATH`,
            retryable: false,
          }),
        );
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const exitCode = code ?? (signal ? 1 : 0);
        const outcome: ExecOutcome = { stdout, stderr, exitCode };
        this.lastOutcome = outcome;
        if (exitCode !== 0) {
          resolve(
            err({
              transport: "subprocess",
              step: 0,
              action: "exec",
              reason: `process \`${command}\` exited with code ${exitCode}${
                stderr ? `: ${stderr.slice(0, 200)}` : ""
              }`,
              suggestion: "inspect stderr for the failure cause",
              retryable: false,
            }),
          );
          return;
        }
        resolve(ok(outcome));
      });

      if (stdin !== undefined) {
        child.stdin?.write(stdin);
        child.stdin?.end();
      }
    });
  }
}
