import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export interface SidecarClient {
  call<T = unknown>(kind: string, params: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export interface SidecarError {
  transport: string;
  action: string;
  reason: string;
  suggestion: string;
  minimum_capability: string;
  exit_code: number;
}

interface SidecarResponse<T = unknown> {
  id: number;
  kind: string;
  ok: boolean;
  data?: T;
  error?: SidecarError;
}

interface PendingCall {
  id: number;
  kind: string;
  params: Record<string, unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

export class StdioSidecarClient implements SidecarClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private nextId = 0;
  private active: PendingCall | undefined;
  private readonly queue: PendingCall[] = [];
  private closed = false;

  constructor(
    private readonly command: string,
    private readonly args: readonly string[] = [],
    private readonly opts: { env?: NodeJS.ProcessEnv } = {},
  ) {}

  async call<T = unknown>(
    kind: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id,
        kind,
        params,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.processNext();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines?.close();
    this.rejectActive(new Error("sidecar closed"));
    this.rejectQueue(new Error("sidecar closed"));
    this.child?.kill();
    this.child = undefined;
  }

  private processNext(): void {
    if (this.active || this.queue.length === 0 || this.closed) return;
    const call = this.queue.shift();
    if (!call) return;
    this.active = call;
    const child = this.ensureChild();
    const request = JSON.stringify({
      id: call.id,
      kind: call.kind,
      params: call.params,
    });
    child.stdin.write(`${request}\n`, (error) => {
      if (!error) return;
      this.rejectActive(error);
      this.processNext();
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    if (this.closed) {
      throw new Error("sidecar client is closed");
    }

    const child = spawn(this.command, [...this.args], {
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.on("error", (error) => {
      this.rejectActive(error);
      this.child = undefined;
      this.processNext();
    });
    child.on("close", (code) => {
      this.rejectActive(
        new Error(`sidecar exited with code ${code ?? "unknown"}`),
      );
      this.child = undefined;
      this.processNext();
    });
    child.stderr.on("data", () => {
      // stderr is reserved for sidecar diagnostics; callers receive protocol
      // failures through stdout envelopes.
    });
    return child;
  }

  private handleLine(line: string): void {
    let response: SidecarResponse;
    try {
      response = JSON.parse(line) as SidecarResponse;
    } catch (error) {
      this.rejectActive(error);
      this.processNext();
      return;
    }

    const call = this.active;
    if (!call || call.id !== response.id) return;
    this.active = undefined;
    if (response.ok) {
      call.resolve(response.data);
    } else {
      call.reject(
        response.error ?? new Error(`sidecar ${response.kind} failed`),
      );
    }
    this.processNext();
  }

  private rejectActive(error: unknown): void {
    const call = this.active;
    if (!call) return;
    this.active = undefined;
    call.reject(error);
  }

  private rejectQueue(error: unknown): void {
    while (this.queue.length > 0) {
      this.queue.shift()?.reject(error);
    }
  }
}

export function isSidecarError(value: unknown): value is SidecarError {
  return (
    typeof value === "object" &&
    value !== null &&
    "transport" in value &&
    "reason" in value &&
    "suggestion" in value &&
    "minimum_capability" in value &&
    "exit_code" in value
  );
}
