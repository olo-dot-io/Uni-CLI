/**
 * @owner       src::transport::sidecar
 * @does        Serialize bounded request frames through one native sidecar generation and retire that entire process tree on cancellation, timeout, exit, or protocol corruption.
 * @needs       node child_process, node util, and contained-process ownership primitives
 * @feeds       Windows UIA, Linux AT-SPI, and native overlay transports
 * @breaks      Reusing a generation after a bad or late frame can attribute an old mutation to a new request; equating leader exit with containment lets descendants mutate after settlement.
 * @invariants  One request is active; ids and kinds match exactly; frames, queue depth, and queued bytes are bounded; queued cancellation is exact; no generation is reused after any transport/protocol failure; no queued request starts until process-tree containment completes; close is idempotent.
 * @side-effects Spawns, writes to, and terminates native sidecar process groups.
 * @perf        Calls are serialized; healthy calls reuse one process; failure adds bounded process-tree retirement latency.
 * @concurrency Every child event is generation-bound, AbortSignal listener is removed exactly once, and retirement gates the next request.
 * @test        tests/unit/transport/sidecar.test.ts, tests/unit/transport/adapters/desktop-uia.test.ts, tests/unit/transport/adapters/desktop-atspi.test.ts
 * @stability   stable
 * @since       2026-07-15
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { TextDecoder } from "node:util";
import {
  type CancellationDelivery,
  OperationOutcomeAmbiguousError,
  ProcessContainmentAmbiguousError,
} from "./contained-process.js";
import { spawnOwnedProcess, terminateOwnedProcess } from "./process-owner.js";

export interface SidecarCallOptions {
  signal?: AbortSignal;
  cancellationDelivery?: CancellationDelivery;
  timeoutMs?: number;
  validate?(value: unknown): void;
}

export interface SidecarClient {
  readonly cancellation: typeof SIDECAR_CANCELLATION_PROTOCOL;
  call<T = unknown>(
    kind: string,
    params: Record<string, unknown>,
    options?: SidecarCallOptions,
  ): Promise<T>;
  close(): Promise<void>;
}

export interface StdioSidecarOptions {
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  maxFrameBytes?: number;
  maxQueueSize?: number;
  maxQueuedBytes?: number;
  initialize?: SidecarInitialization;
}

export interface SidecarInitialization {
  kind: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  validate?(value: unknown): void;
}

export const SIDECAR_CANCELLATION_PROTOCOL = "process-contained-v2" as const;

export interface SidecarError {
  transport: string;
  action: string;
  reason: string;
  suggestion: string;
  minimum_capability: string;
  exit_code: number;
  stable_token?: string;
  ref?: string;
}

interface SidecarResponse<T = unknown> {
  id: number;
  kind: string;
  ok: boolean;
  data?: T;
  error?: SidecarError;
}

type PendingCallState = "queued" | "active" | "cancelling" | "settled";

interface PendingCall {
  id: number;
  kind: string;
  frame: Buffer;
  signal?: AbortSignal;
  cancellationDelivery: CancellationDelivery;
  timeoutMs: number;
  validate?: (value: unknown) => void;
  frameDispatched: boolean;
  abortListener?: () => void;
  deadline?: ReturnType<typeof setTimeout>;
  state: PendingCallState;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface SidecarGeneration {
  id: number;
  child: ChildProcessWithoutNullStreams;
  decoder: BoundedJsonLineDecoder;
  close: Promise<void>;
  initialized: boolean;
  initializing: boolean;
  initializationDeadline?: ReturnType<typeof setTimeout>;
  retired: boolean;
  retirement?: Promise<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_QUEUE_SIZE = 1_024;
const DEFAULT_MAX_QUEUED_BYTES = 32 * 1024 * 1024;
const SIDECAR_CLOSE_TIMEOUT_MS = 2_000;

export class StdioSidecarClient implements SidecarClient {
  readonly cancellation = SIDECAR_CANCELLATION_PROTOCOL;

  private readonly requestTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxQueueSize: number;
  private readonly maxQueuedBytes: number;
  private readonly initialization: SidecarInitialization | undefined;
  private nextId = 0;
  private nextGenerationId = 0;
  private active: PendingCall | undefined;
  private readonly queue: PendingCall[] = [];
  private generation: SidecarGeneration | undefined;
  private retirement: Promise<void> | undefined;
  private closeOperation: Promise<void> | undefined;
  private fatalError: unknown;
  private pendingCount = 0;
  private bufferedBytes = 0;
  private closed = false;

  constructor(
    private readonly command: string,
    private readonly args: readonly string[] = [],
    private readonly opts: StdioSidecarOptions = {},
  ) {
    this.requestTimeoutMs = positiveInteger(
      opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.maxFrameBytes = positiveInteger(
      opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      "maxFrameBytes",
    );
    this.maxQueueSize = positiveInteger(
      opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      "maxQueueSize",
    );
    this.maxQueuedBytes = positiveInteger(
      opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES,
      "maxQueuedBytes",
    );
    if (opts.initialize) {
      validateRequest(opts.initialize.kind, opts.initialize.params ?? {});
      if (opts.initialize.timeoutMs !== undefined) {
        positiveInteger(opts.initialize.timeoutMs, "initialize.timeoutMs");
      }
    }
    this.initialization = opts.initialize;
  }

  async call<T = unknown>(
    kind: string,
    params: Record<string, unknown>,
    options: SidecarCallOptions = {},
  ): Promise<T> {
    const signal = options.signal;
    signal?.throwIfAborted();
    this.throwIfUnavailable();
    validateRequest(kind, params);
    if (this.pendingCount >= this.maxQueueSize) {
      throw new Error(
        `sidecar queue limit of ${String(this.maxQueueSize)} requests exceeded`,
      );
    }
    if (this.nextId >= Number.MAX_SAFE_INTEGER) {
      throw new Error("sidecar request id space exhausted");
    }
    const id = this.nextId + 1;
    const frame = encodeRequest(id, kind, params, this.maxFrameBytes);
    if (this.bufferedBytes + frame.byteLength > this.maxQueuedBytes) {
      throw new Error(
        `sidecar queued frame limit of ${String(this.maxQueuedBytes)} bytes exceeded`,
      );
    }
    const timeoutMs = positiveInteger(
      options.timeoutMs ?? this.requestTimeoutMs,
      "timeoutMs",
    );
    this.nextId = id;
    this.pendingCount += 1;
    this.bufferedBytes += frame.byteLength;

    return await new Promise<T>((resolve, reject) => {
      const call: PendingCall = {
        id,
        kind,
        frame,
        signal,
        cancellationDelivery: options.cancellationDelivery ?? "contained",
        timeoutMs,
        validate: options.validate,
        frameDispatched: false,
        state: "queued",
        resolve: (value) => resolve(value as T),
        reject,
      };
      if (signal) {
        call.abortListener = () => this.cancelCall(call);
        signal.addEventListener("abort", call.abortListener, { once: true });
      }
      this.queue.push(call);
      if (signal?.aborted) this.cancelCall(call);
      else this.processNext();
    });
  }

  close(): Promise<void> {
    this.closeOperation ??= this.closeSession();
    return this.closeOperation;
  }

  private async closeSession(): Promise<void> {
    this.closed = true;
    const reason = new Error("sidecar closed");
    this.rejectQueue(reason);
    const generation = this.generation;
    if (generation) {
      await this.retireGeneration(generation, reason);
    } else if (this.retirement) {
      await this.retirement;
    }
    if (this.fatalError !== undefined) throw this.fatalError;
  }

  private throwIfUnavailable(): void {
    if (this.fatalError !== undefined) throw this.fatalError;
    if (this.closed) throw new Error("sidecar client is closed");
  }

  private processNext(): void {
    if (this.active || this.retirement || this.closed) return;
    let call = this.queue.shift();
    while (call && call.state !== "queued") call = this.queue.shift();
    if (!call) return;
    call.state = "active";
    this.active = call;

    try {
      const generation = this.ensureGeneration();
      this.dispatch(generation, call);
    } catch (error) {
      this.active = undefined;
      this.rejectCall(call, error);
      this.processNext();
    }
  }

  private ensureGeneration(): SidecarGeneration {
    if (this.generation) return this.generation;
    this.throwIfUnavailable();
    const child = spawnOwnedProcess(this.command, this.args, {
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    }).child;
    const generation: SidecarGeneration = {
      id: ++this.nextGenerationId,
      child,
      decoder: new BoundedJsonLineDecoder(this.maxFrameBytes),
      close: new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      ),
      initialized: this.initialization === undefined,
      initializing: false,
      retired: false,
    };
    this.generation = generation;
    child.stdout.on("data", (chunk: Buffer) => {
      if (generation.retired) return;
      try {
        generation.decoder.push(chunk, (line) => {
          if (generation.retired) return false;
          this.handleLine(generation, line);
          return !generation.retired;
        });
      } catch (error) {
        void this.retireGeneration(generation, error);
      }
    });
    child.stderr.resume();
    child.once("error", (error) => {
      void this.retireGeneration(generation, error);
    });
    child.once("exit", (code, signal) => {
      void this.retireGeneration(
        generation,
        new Error(
          `sidecar generation ${String(generation.id)} exited with ${
            signal ? `signal ${signal}` : `code ${String(code ?? "unknown")}`
          }`,
        ),
      );
    });
    return generation;
  }

  private dispatch(generation: SidecarGeneration, call: PendingCall): void {
    if (!generation.initialized) {
      this.initializeGeneration(generation);
      return;
    }
    call.deadline = setTimeout(() => {
      void this.retireGeneration(
        generation,
        new SidecarResponseTimeoutError(call.kind, call.timeoutMs),
      );
    }, call.timeoutMs);
    call.frameDispatched = generation.child.pid !== undefined;
    try {
      generation.child.stdin.write(call.frame, (error) => {
        if (!error || generation.retired) return;
        void this.retireGeneration(generation, error);
      });
    } catch (error) {
      void this.retireGeneration(generation, error);
    }
  }

  private handleLine(generation: SidecarGeneration, line: string): void {
    let response: SidecarResponse;
    try {
      response = parseSidecarResponse(line);
    } catch (error) {
      void this.retireGeneration(generation, error);
      return;
    }

    if (generation.initializing) {
      this.handleInitializationResponse(generation, response);
      return;
    }

    const call = this.active;
    if (!call) {
      void this.retireGeneration(
        generation,
        new SidecarProtocolError(
          `sidecar generation ${String(generation.id)} emitted a response with no active request`,
        ),
      );
      return;
    }
    if (response.id !== call.id || response.kind !== call.kind) {
      void this.retireGeneration(
        generation,
        new SidecarProtocolError(
          `sidecar response ${String(response.id)}/${response.kind} did not match active request ${String(call.id)}/${call.kind}`,
        ),
      );
      return;
    }

    if (response.ok && call.validate) {
      try {
        call.validate(response.data);
      } catch (error) {
        void this.retireGeneration(generation, error);
        return;
      }
    }
    this.active = undefined;
    if (response.ok) this.resolveCall(call, response.data);
    else this.rejectCall(call, response.error);
    this.processNext();
  }

  private initializeGeneration(generation: SidecarGeneration): void {
    const initialization = this.initialization;
    if (!initialization || generation.initializing) return;
    generation.initializing = true;
    const timeoutMs = initialization.timeoutMs ?? this.requestTimeoutMs;
    generation.initializationDeadline = setTimeout(() => {
      void this.retireGeneration(
        generation,
        new SidecarResponseTimeoutError(initialization.kind, timeoutMs),
      );
    }, timeoutMs);
    const frame = encodeRequest(
      0,
      initialization.kind,
      initialization.params ?? {},
      this.maxFrameBytes,
    );
    try {
      generation.child.stdin.write(frame, (error) => {
        if (!error || generation.retired) return;
        void this.retireGeneration(generation, error);
      });
    } catch (error) {
      void this.retireGeneration(generation, error);
    }
  }

  private handleInitializationResponse(
    generation: SidecarGeneration,
    response: SidecarResponse,
  ): void {
    const initialization = this.initialization;
    if (
      !initialization ||
      response.id !== 0 ||
      response.kind !== initialization.kind
    ) {
      void this.retireGeneration(
        generation,
        new SidecarProtocolError(
          `sidecar initialization response ${String(response.id)}/${response.kind} did not match 0/${initialization?.kind ?? "<none>"}`,
        ),
      );
      return;
    }
    if (!response.ok) {
      void this.retireGeneration(generation, response.error);
      return;
    }
    try {
      initialization.validate?.(response.data);
    } catch (error) {
      void this.retireGeneration(generation, error);
      return;
    }
    if (generation.initializationDeadline) {
      clearTimeout(generation.initializationDeadline);
    }
    generation.initializing = false;
    generation.initialized = true;
    const call = this.active;
    if (call) this.dispatch(generation, call);
  }

  private cancelCall(call: PendingCall): void {
    if (call.state === "settled" || call.state === "cancelling") return;
    const reason = abortReason(call.signal);
    if (call.state === "queued") {
      const index = this.queue.indexOf(call);
      if (index >= 0) this.queue.splice(index, 1);
      this.rejectCall(call, reason);
      this.processNext();
      return;
    }
    if (this.active !== call) return;
    const generation = this.generation;
    if (!generation) {
      this.active = undefined;
      this.rejectCall(call, this.activeFailure(call, reason));
      this.processNext();
      return;
    }
    void this.retireGeneration(generation, reason);
  }

  private retireGeneration(
    generation: SidecarGeneration,
    reason: unknown,
  ): Promise<void> {
    if (generation.retirement) return generation.retirement;
    generation.retired = true;
    if (this.generation === generation) this.generation = undefined;
    const call = this.active;
    if (call) {
      call.state = "cancelling";
      this.active = undefined;
      if (call.deadline) clearTimeout(call.deadline);
    }
    if (generation.initializationDeadline) {
      clearTimeout(generation.initializationDeadline);
    }

    const retirement = this.containGeneration(generation).then(
      () => {
        if (call) this.rejectCall(call, this.activeFailure(call, reason));
      },
      (containmentError: unknown) => {
        const failure = containmentFailure(call, reason, containmentError);
        this.fatalError = failure;
        this.closed = true;
        if (call) this.rejectCall(call, failure);
        this.rejectQueue(failure);
      },
    );
    generation.retirement = retirement;
    this.retirement = retirement;
    void retirement.finally(() => {
      if (this.retirement === retirement) this.retirement = undefined;
      this.processNext();
    });
    return retirement;
  }

  private async containGeneration(
    generation: SidecarGeneration,
  ): Promise<void> {
    generation.child.stdin.destroy();
    if (generation.child.pid !== undefined) {
      await terminateOwnedProcess(generation.child);
    }
    await withTimeout(
      generation.close,
      SIDECAR_CLOSE_TIMEOUT_MS,
      `sidecar generation ${String(generation.id)} did not close its stdio after process-tree termination`,
    );
  }

  private resolveCall(call: PendingCall, value: unknown): void {
    if (!this.settleCall(call)) return;
    call.resolve(value);
  }

  private rejectCall(call: PendingCall, error: unknown): void {
    if (!this.settleCall(call)) return;
    call.reject(error);
  }

  private settleCall(call: PendingCall): boolean {
    if (call.state === "settled") return false;
    call.state = "settled";
    if (call.deadline) clearTimeout(call.deadline);
    if (call.signal && call.abortListener) {
      call.signal.removeEventListener("abort", call.abortListener);
    }
    this.pendingCount -= 1;
    this.bufferedBytes -= call.frame.byteLength;
    return true;
  }

  private activeFailure(call: PendingCall, error: unknown): unknown {
    return call.frameDispatched &&
      call.cancellationDelivery === "outcome-ambiguous"
      ? new OperationOutcomeAmbiguousError(call.kind, error)
      : error;
  }

  private rejectQueue(error: unknown): void {
    while (this.queue.length > 0) {
      const call = this.queue.shift();
      if (call) this.rejectCall(call, error);
    }
  }
}

class BoundedJsonLineDecoder {
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;

  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Buffer, onLine: (line: string) => boolean): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      this.append(chunk.subarray(offset, end));
      if (newline < 0) return;
      const line = this.decodeLine();
      offset = newline + 1;
      if (!onLine(line)) return;
    }
  }

  private append(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    if (this.bufferedBytes + chunk.byteLength > this.maxFrameBytes) {
      throw new SidecarProtocolError(
        `sidecar response exceeded ${String(this.maxFrameBytes)} bytes`,
      );
    }
    this.chunks.push(chunk);
    this.bufferedBytes += chunk.byteLength;
  }

  private decodeLine(): string {
    let frame = Buffer.concat(this.chunks, this.bufferedBytes);
    this.chunks.length = 0;
    this.bufferedBytes = 0;
    if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch (error) {
      throw new SidecarProtocolError("sidecar response was not valid UTF-8", {
        cause: error,
      });
    }
  }
}

class SidecarProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SidecarProtocolError";
  }
}

class SidecarResponseTimeoutError extends Error {
  constructor(kind: string, timeoutMs: number) {
    super(`sidecar ${kind} response timed out after ${String(timeoutMs)}ms`);
    this.name = "TimeoutError";
  }
}

function encodeRequest(
  id: number,
  kind: string,
  params: Record<string, unknown>,
  maxFrameBytes: number,
): Buffer {
  const payload = JSON.stringify({ id, kind, params });
  const frame = Buffer.from(`${payload}\n`, "utf8");
  if (frame.byteLength - 1 > maxFrameBytes) {
    throw new Error(`sidecar request exceeded ${String(maxFrameBytes)} bytes`);
  }
  return frame;
}

function parseSidecarResponse(line: string): SidecarResponse {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new SidecarProtocolError("sidecar response was not valid JSON", {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new SidecarProtocolError("sidecar response must be an object");
  }
  const allowedKeys = new Set(["id", "kind", "ok", "data", "error"]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new SidecarProtocolError("sidecar response contained unknown fields");
  }
  if (
    !Number.isSafeInteger(value.id) ||
    (value.id as number) < 0 ||
    typeof value.kind !== "string" ||
    value.kind.length === 0 ||
    typeof value.ok !== "boolean"
  ) {
    throw new SidecarProtocolError(
      "sidecar response requires a non-negative integer id, non-empty kind, and boolean ok",
    );
  }
  if (value.ok) {
    if ("error" in value) {
      throw new SidecarProtocolError(
        "successful sidecar response must not contain error",
      );
    }
  } else {
    if ("data" in value || !isSidecarError(value.error)) {
      throw new SidecarProtocolError(
        "failed sidecar response requires one structured error and no data",
      );
    }
  }
  return value as unknown as SidecarResponse;
}

function validateRequest(kind: string, params: Record<string, unknown>): void {
  if (typeof kind !== "string" || kind.length === 0) {
    throw new TypeError("sidecar request kind must be a non-empty string");
  }
  if (!isRecord(params)) {
    throw new TypeError("sidecar request params must be an object");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function containmentFailure(
  call: PendingCall | undefined,
  reason: unknown,
  containmentError: unknown,
): unknown {
  if (call?.frameDispatched) {
    const authoritativeError =
      call.cancellationDelivery === "outcome-ambiguous"
        ? new OperationOutcomeAmbiguousError(call.kind, reason)
        : reason;
    return new ProcessContainmentAmbiguousError(
      call.kind,
      reason,
      authoritativeError,
      containmentError,
    );
  }
  return new AggregateError(
    [reason, containmentError],
    "Sidecar generation failed and its process tree could not be contained",
  );
}

function abortReason(signal?: AbortSignal): unknown {
  return (
    signal?.reason ?? new DOMException("Sidecar call aborted", "AbortError")
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSidecarError(value: unknown): value is SidecarError {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set([
    "transport",
    "action",
    "reason",
    "suggestion",
    "minimum_capability",
    "exit_code",
    "stable_token",
    "ref",
  ]);
  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    typeof value.transport === "string" &&
    typeof value.action === "string" &&
    typeof value.reason === "string" &&
    typeof value.suggestion === "string" &&
    typeof value.minimum_capability === "string" &&
    Number.isSafeInteger(value.exit_code) &&
    (value.stable_token === undefined ||
      typeof value.stable_token === "string") &&
    (value.ref === undefined || typeof value.ref === "string")
  );
}
