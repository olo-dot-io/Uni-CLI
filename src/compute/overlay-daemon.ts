/**
 * @owner   src/compute/overlay-daemon.ts
 * @does    Manage JSONL stdio sessions for native compute overlay HUD daemons.
 * @needs   child_process spawn, readline, visual overlay status protocol
 * @feeds   macOS AppKit, Windows Win32, and Linux GTK overlay providers
 * @breaks  Missing ready separation causes cold-start time to consume render animation timeouts.
 * @invariants A daemon must emit provider/status=ready before render requests are written.
 * @side-effects Starts and kills native helper processes.
 * @perf    One persistent process per overlay provider instance.
 * @concurrency Render calls are serialized through one active JSONL request.
 * @test    tests/unit/compute-macos-overlay-swift.test.ts
 * @stability experimental
 * @since   0.224.0
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import type { ComputeOverlayRequest } from "./overlay.js";
import type { ComputeVisualOverlayStatus } from "./visual-timeline.js";

export interface ComputeOverlayDaemonSession {
  render(
    request: ComputeOverlayRequest,
    timeoutMs: number,
  ): Promise<ComputeVisualOverlayStatus>;
  close(): Promise<void>;
}

export class StdioComputeOverlayDaemonSession implements ComputeOverlayDaemonSession {
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private active: PendingOverlayCall | undefined;
  private readiness: PendingOverlayReady | undefined;
  private readonly queue: PendingOverlayCall[] = [];
  private closed = false;
  private readonly readyTimeoutMs: number;

  constructor(
    private readonly command: string,
    private readonly args: readonly string[],
    opts: { readyTimeoutMs?: number } = {},
  ) {
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 8_000;
  }

  render(
    request: ComputeOverlayRequest,
    timeoutMs: number,
  ): Promise<ComputeVisualOverlayStatus> {
    return new Promise((resolve, reject) => {
      this.queue.push({ request, timeoutMs, resolve, reject });
      this.processNext();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines?.close();
    this.rejectReadiness(new Error("overlay daemon closed"));
    this.rejectActive(new Error("overlay daemon closed"));
    this.rejectQueue(new Error("overlay daemon closed"));
    this.child?.kill();
    this.child = undefined;
  }

  private processNext(): void {
    if (this.active || this.queue.length === 0 || this.closed) return;
    const call = this.queue.shift();
    if (!call) return;
    this.active = call;
    void this.ensureReadyChild()
      .then((child) => this.writeActiveCall(child))
      .catch((error) => {
        this.rejectActive(error);
        this.processNext();
      });
  }

  private writeActiveCall(child: ChildProcessWithoutNullStreams): void {
    const call = this.active;
    if (!call || this.closed) return;
    call.timeout = setTimeout(() => {
      this.rejectActive(new Error("overlay render timed out"));
      this.processNext();
    }, call.timeoutMs);
    child.stdin.write(`${JSON.stringify(call.request)}\n`, (error) => {
      if (!error) return;
      this.rejectActive(error);
      this.processNext();
    });
  }

  private async ensureReadyChild(): Promise<ChildProcessWithoutNullStreams> {
    const child = this.ensureChild();
    if (this.readiness?.ready) return child;
    await this.readiness?.promise;
    return child;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    if (this.closed) throw new Error("overlay daemon session is closed");
    const child = spawn(this.command, [...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.readiness = this.createReadiness();
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.on("error", (error) => {
      this.rejectReadiness(error);
      this.rejectActive(error);
      this.child = undefined;
      this.processNext();
    });
    child.on("close", (code) => {
      const error = new Error(
        `overlay daemon exited with code ${code ?? "unknown"}`,
      );
      this.rejectReadiness(error);
      this.rejectActive(error);
      this.child = undefined;
      this.processNext();
    });
    child.stderr.on("data", () => {
      // stderr is reserved for native diagnostics; protocol responses stay on stdout.
    });
    return child;
  }

  private handleLine(line: string): void {
    if (this.resolveReadinessIfReady(line)) return;
    let status: ComputeVisualOverlayStatus;
    try {
      status = parseOverlayStatus(line);
    } catch (error) {
      this.rejectActive(error);
      this.processNext();
      return;
    }
    const call = this.active;
    if (!call) return;
    clearTimeout(call.timeout);
    this.active = undefined;
    call.resolve(status);
    this.processNext();
  }

  private createReadiness(): PendingOverlayReady {
    const ready: PendingOverlayReady = {
      ready: false,
      promise: Promise.resolve(),
      resolve: () => {},
      reject: () => {},
    };
    ready.promise = new Promise<void>((resolve, reject) => {
      ready.resolve = resolve;
      ready.reject = reject;
    });
    ready.timeout = setTimeout(() => {
      if (ready.ready) return;
      ready.reject(new Error("overlay daemon did not report ready"));
    }, this.readyTimeoutMs);
    return ready;
  }

  private resolveReadinessIfReady(line: string): boolean {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return false;
    }
    if (!isRecord(value)) return false;
    if (value.status !== "ready" || typeof value.provider !== "string") {
      return false;
    }
    const readiness = this.readiness;
    if (!readiness || readiness.ready) return true;
    readiness.ready = true;
    if (readiness.timeout) clearTimeout(readiness.timeout);
    readiness.resolve();
    return true;
  }

  private rejectActive(error: unknown): void {
    const call = this.active;
    if (!call) return;
    clearTimeout(call.timeout);
    this.active = undefined;
    call.reject(error);
  }

  private rejectQueue(error: unknown): void {
    while (this.queue.length > 0) this.queue.shift()?.reject(error);
  }

  private rejectReadiness(error: unknown): void {
    const readiness = this.readiness;
    if (!readiness || readiness.ready) return;
    if (readiness.timeout) clearTimeout(readiness.timeout);
    readiness.reject(error);
  }
}

interface PendingOverlayCall {
  request: ComputeOverlayRequest;
  timeoutMs: number;
  timeout?: NodeJS.Timeout;
  resolve(value: ComputeVisualOverlayStatus): void;
  reject(error: unknown): void;
}

interface PendingOverlayReady {
  ready: boolean;
  promise: Promise<void>;
  timeout?: NodeJS.Timeout;
  resolve(): void;
  reject(error: unknown): void;
}

function parseOverlayStatus(stdout: string): ComputeVisualOverlayStatus {
  const value = JSON.parse(
    stdout.trim(),
  ) as Partial<ComputeVisualOverlayStatus>;
  if (typeof value.provider === "string" && typeof value.status === "string") {
    return value as ComputeVisualOverlayStatus;
  }
  throw new Error("overlay sidecar returned invalid JSON");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
