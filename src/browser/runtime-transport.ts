/**
 * @owner       src/browser/runtime-transport.ts
 * @does        Serve and call the Browser Runtime Broker over an authenticated owner-only Unix socket or secret-bearing Windows named pipe, preserving outcome ambiguity after mutating request dispatch, classifying unpublished broker generations as retryable, and propagating disconnect cancellation into broker work.
 * @needs       node:crypto, node:fs, node:net, node:os, node:path, src/browser/kernel-file-lock.ts, src/browser/runtime-protocol.ts, src/engine/user-home.ts
 * @feeds       src/browser/runtime-broker-main.ts, src/browser/runtime-launch.ts, src/browser/runtime-client.ts, native browser host
 * @breaks      BrokerTransportError on endpoint/lock/auth/schema/framing/connect/timeout failures and BrowserBrokerOutcomeAmbiguousError when a mutating frame lacks an authoritative response; broker responses preserve provider errors.
 * @invariants  One kernel-backed guard owns one broker lock and endpoint descriptor; shutdown unpublishes that descriptor before severing accepted connections; once the guard is exclusive a naked PID can never veto stale-state takeover, while every published legacy descriptor is either authenticated at its trusted endpoint, proven absent by the kernel, or rejected fail-closed; only the server instance that successfully bound the Unix socket may unlink it; descriptor and Unix socket are owner-only; control frames are bounded newline-delimited JSON; large responses use length-and-digest-verified artifacts; tokens compare in constant time; every failure after mutating frame dispatch is non-retryable outcome ambiguity; client disconnect and server stop abort matching handlers.
 * @side-effects Creates/removes runtime files and sockets, opens local IPC connections, and accepts concurrent client requests.
 * @perf        One short local socket connection per request; control frames are capped at 4 MiB and response artifacts at 128 MiB.
 * @concurrency A kernel socket guard on Linux/Windows or a process-owned BSD lock descriptor serializes stale-lock takeover across processes; no resident guardian can outlive or die independently from the broker; the OS accept queue handles independent clients; each connection carries exactly one request/response; broker owns target serialization.
 * @test        tests/unit/browser-runtime-protocol.test.ts, tests/integration/browser-runtime-broker.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import {
  acquireKernelFileLock,
  KernelFileLockError,
  type KernelFileLock,
} from "./kernel-file-lock.js";
import {
  BROWSER_BROKER_MAX_MESSAGE_BYTES,
  BROWSER_BROKER_MAX_ARTIFACT_BYTES,
  BROWSER_BROKER_PRODUCT,
  BROWSER_BROKER_PROTOCOL,
  BROWSER_BROKER_PROTOCOL_VERSION,
  browserPageCommandCanMutate,
  browserBrokerWireRequestSchema,
  type BrowserBrokerEndpointDescriptor,
  type BrowserBrokerError,
  type BrowserBrokerRequest,
  type BrowserBrokerResponse,
  type BrowserBrokerWireRequest,
} from "./runtime-protocol.js";
import { userHome } from "../engine/user-home.js";

interface BrowserBrokerServerOptions {
  runtimeRoot?: string;
  runtimeId: string;
  handler: (
    request: BrowserBrokerRequest,
    signal?: AbortSignal,
  ) => Promise<BrowserBrokerResponse>;
  onShutdown?: () => Promise<void>;
}

interface BrowserBrokerClientOptions {
  runtimeRoot?: string;
  requestTimeoutMs?: number;
}

interface BrokerPaths {
  runtimeRoot: string;
  descriptorPath: string;
  lockPath: string;
  guardPath: string;
  socketPath: string;
}

interface LockPayload {
  pid: number;
  runtime_id: string;
  created_at: string;
}

type BrokerOwnershipGuard =
  | { kind: "socket"; server: Server }
  | { kind: "file"; lock: KernelFileLock };

interface BrowserBrokerEndpointEnvelope {
  product: typeof BROWSER_BROKER_PRODUCT;
  protocol: typeof BROWSER_BROKER_PROTOCOL;
  version: number;
  runtime_id: string;
  pid: number;
  socket_path: string;
  auth_token: string;
  started_at: string;
}

interface BrowserBrokerCompatibleWireRequest {
  product: typeof BROWSER_BROKER_PRODUCT;
  protocol: typeof BROWSER_BROKER_PROTOCOL;
  version: number;
  auth_token: string;
  request: BrowserBrokerRequest;
}

type BrokerTransportErrorCode =
  | "browser_broker_unavailable"
  | "browser_broker_already_running"
  | "browser_broker_endpoint_invalid"
  | "browser_broker_protocol_mismatch"
  | "browser_broker_unauthorized"
  | "browser_broker_protocol_invalid"
  | "browser_broker_message_too_large"
  | "browser_broker_timeout";

export const BROWSER_BROKER_DEFAULT_REQUEST_TIMEOUT_MS = 150_000;
const SERVER_FRAME_TIMEOUT_MS = 30_000;
const PUBLISHED_BROKER_PROBE_TIMEOUT_MS = 1_000;
const UNIX_SOCKET_PATH_LIMIT = 100;

const browserBrokerArtifactHeaderSchema = z
  .object({
    id: z.string(),
    artifact: z
      .object({
        encoding: z.literal("json"),
        byte_length: z
          .number()
          .int()
          .positive()
          .max(BROWSER_BROKER_MAX_ARTIFACT_BYTES),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict();

type BrowserBrokerArtifactHeader = z.infer<
  typeof browserBrokerArtifactHeaderSchema
>;

const browserBrokerEndpointEnvelopeSchema = z
  .object({
    product: z.literal(BROWSER_BROKER_PRODUCT),
    protocol: z.literal(BROWSER_BROKER_PROTOCOL),
    version: z.number().int().positive(),
    runtime_id: z.string().uuid(),
    pid: z.number().int().positive(),
    socket_path: z.string().min(1),
    auth_token: z.string().min(32).max(256),
    started_at: z.iso.datetime(),
  })
  .strict() satisfies z.ZodType<BrowserBrokerEndpointEnvelope>;

const browserBrokerResponseSchema = z
  .object({
    id: z.string(),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        suggestion: z.string(),
        retryable: z.boolean(),
        outcome_ambiguous: z.literal(true).optional(),
        target_unusable: z.literal(true).optional(),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<BrowserBrokerResponse>;

export class BrokerTransportError extends Error {
  readonly retryable: boolean;
  readonly suggestion: string;
  readonly requestId?: string;

  constructor(
    readonly code: BrokerTransportErrorCode,
    message: string,
    options?: ErrorOptions & { requestId?: string },
  ) {
    super(message, options);
    this.name = "BrokerTransportError";
    this.requestId = options?.requestId;
    this.retryable =
      code === "browser_broker_unavailable" ||
      code === "browser_broker_timeout";
    this.suggestion = brokerTransportSuggestion(code);
  }
}

export class BrowserBrokerClientError extends Error {
  readonly code: string;
  readonly suggestion: string;
  readonly retryable: boolean;
  readonly outcome_ambiguous?: true;
  readonly target_unusable?: true;

  constructor(error: BrowserBrokerError) {
    super(error.message);
    this.name = "BrowserBrokerClientError";
    this.code = error.code;
    this.suggestion = error.suggestion;
    this.retryable = error.retryable;
    if (
      error.outcome_ambiguous === true ||
      error.code === "browser_command_outcome_ambiguous" ||
      (error.code === "browser_command_canceled" && !error.retryable)
    ) {
      this.outcome_ambiguous = true;
      this.target_unusable = true;
    } else if (error.target_unusable === true) {
      this.target_unusable = true;
    }
  }
}

export class BrowserBrokerOutcomeAmbiguousError extends Error {
  readonly code = "browser_command_outcome_ambiguous";
  readonly retryable = false;
  readonly outcome_ambiguous = true;
  readonly suggestion =
    "Inspect the external effect before deciding whether to repeat it; continue only after the prior target has been invalidated.";

  constructor(
    readonly requestId: string,
    readonly operation: string,
    cause: unknown,
  ) {
    super(
      `Browser broker ${operation} lost its authoritative response after dispatch; the external outcome is ambiguous`,
      { cause },
    );
    this.name = "BrowserBrokerOutcomeAmbiguousError";
  }
}

export class BrowserRuntimeBrokerServer {
  private readonly paths: BrokerPaths;
  private readonly runtimeId: string;
  private readonly handler: BrowserBrokerServerOptions["handler"];
  private readonly onShutdown?: () => Promise<void>;
  private readonly authToken = randomBytes(32).toString("base64url");
  private server: Server | null = null;
  private socketOwned = false;
  private lockGuard: BrokerOwnershipGuard | null = null;
  private lockOwned = false;
  private descriptor: BrowserBrokerEndpointDescriptor | null = null;
  private readonly acceptedSockets = new Map<
    Socket,
    {
      handled: boolean;
      frameTimer: ReturnType<typeof setTimeout> | null;
      requestController: AbortController | null;
      handlerSettled: boolean;
    }
  >();

  constructor(options: BrowserBrokerServerOptions) {
    this.paths = browserBrokerPaths(options.runtimeRoot);
    this.runtimeId = options.runtimeId;
    this.handler = options.handler;
    this.onShutdown = options.onShutdown;
  }

  async start(): Promise<BrowserBrokerEndpointDescriptor> {
    if (this.server || this.lockGuard !== null) {
      throw new BrokerTransportError(
        "browser_broker_already_running",
        "This BrowserRuntimeBrokerServer instance is already started",
      );
    }
    prepareRuntimeRoot(this.paths.runtimeRoot);
    this.lockGuard = await acquireBrokerLock(this.paths, this.runtimeId);
    this.lockOwned = true;
    if (process.platform !== "win32")
      rmSync(this.paths.socketPath, { force: true });
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await listen(server, this.paths.socketPath);
      this.socketOwned = true;
      if (process.platform !== "win32") chmodSync(this.paths.socketPath, 0o600);
      const descriptor: BrowserBrokerEndpointDescriptor = {
        product: BROWSER_BROKER_PRODUCT,
        protocol: BROWSER_BROKER_PROTOCOL,
        version: BROWSER_BROKER_PROTOCOL_VERSION,
        runtime_id: this.runtimeId,
        pid: process.pid,
        socket_path: this.paths.socketPath,
        auth_token: this.authToken,
        started_at: new Date().toISOString(),
      };
      writeEndpointDescriptor(this.paths.descriptorPath, descriptor);
      this.descriptor = descriptor;
      return descriptor;
    } catch (error) {
      await this.stop();
      throw new BrokerTransportError(
        "browser_broker_unavailable",
        `Browser broker failed to listen on ${this.paths.socketPath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async stop(): Promise<void> {
    let stopError: unknown;
    const attempt = async (operation: () => Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        stopError ??= error;
      }
    };
    const server = this.server;
    this.server = null;
    const descriptor = this.descriptor;
    this.descriptor = null;
    if (descriptor) {
      try {
        removeEndpointDescriptor(
          this.paths.descriptorPath,
          descriptor.runtime_id,
        );
      } catch (error) {
        stopError ??= error;
      }
    }
    if (server?.listening) {
      const closing = closeServer(server);
      for (const [socket, state] of this.acceptedSockets) {
        if (state.requestController && !state.handlerSettled) {
          state.requestController.abort(
            new Error("Browser broker transport is shutting down"),
          );
        }
        socket.destroy();
      }
      await attempt(() => closing);
    }
    if (process.platform !== "win32" && this.socketOwned) {
      try {
        rmSync(this.paths.socketPath, { force: true });
      } catch (error) {
        stopError ??= error;
      }
    }
    this.socketOwned = false;
    if (this.lockOwned) {
      try {
        removeBrokerLock(this.paths.lockPath, this.runtimeId);
      } catch (error) {
        stopError ??= error;
      }
      this.lockOwned = false;
    }
    const lockGuard = this.lockGuard;
    this.lockGuard = null;
    if (lockGuard) {
      await attempt(() => releaseBrokerGuard(lockGuard));
    }
    if (stopError) {
      throw stopError instanceof BrokerTransportError
        ? stopError
        : new BrokerTransportError(
            "browser_broker_unavailable",
            `Browser broker transport did not stop cleanly: ${errorMessage(stopError)}`,
            { cause: stopError },
          );
    }
  }

  private accept(socket: Socket): void {
    let byteCount = 0;
    const chunks: Buffer[] = [];
    const state: {
      handled: boolean;
      frameTimer: ReturnType<typeof setTimeout> | null;
      requestController: AbortController | null;
      handlerSettled: boolean;
    } = {
      handled: false,
      frameTimer: null,
      requestController: null,
      handlerSettled: false,
    };
    const fail = (error: BrowserBrokerError): void => {
      if (state.handled) return;
      state.handled = true;
      if (state.frameTimer) clearTimeout(state.frameTimer);
      sendBrokerResponse(socket, {
        id: "invalid",
        ok: false,
        error,
      } satisfies BrowserBrokerResponse);
    };
    state.frameTimer = setTimeout(() => {
      fail(
        transportWireError(
          "browser_broker_timeout",
          `Browser broker request frame timed out after ${String(SERVER_FRAME_TIMEOUT_MS)}ms`,
        ),
      );
    }, SERVER_FRAME_TIMEOUT_MS);
    this.acceptedSockets.set(socket, state);
    socket.on("data", (chunk: Buffer) => {
      if (state.handled) return;
      byteCount += chunk.length;
      if (byteCount > BROWSER_BROKER_MAX_MESSAGE_BYTES) {
        fail(
          transportWireError(
            "browser_broker_message_too_large",
            `Browser broker message exceeded ${String(BROWSER_BROKER_MAX_MESSAGE_BYTES)} bytes`,
          ),
        );
        return;
      }
      chunks.push(chunk);
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) return;
      state.handled = true;
      if (state.frameTimer) clearTimeout(state.frameTimer);
      socket.pause();
      const requestController = new AbortController();
      state.requestController = requestController;
      const payload = Buffer.concat(chunks);
      const line = payload.subarray(0, payload.indexOf(0x0a)).toString("utf8");
      this.handleLine(line, requestController.signal)
        .then(({ request, response }) => {
          state.handlerSettled = true;
          sendBrokerResponse(socket, response);
          if (request.action === "broker.shutdown" && this.onShutdown) {
            socket.once("close", () => this.runShutdownCallback());
          }
        })
        .catch((error) => {
          state.handlerSettled = true;
          const wireError =
            error instanceof BrokerTransportError
              ? transportWireError(error.code, error.message)
              : transportWireError(
                  "browser_broker_protocol_invalid",
                  errorMessage(error),
                );
          sendBrokerResponse(socket, {
            id:
              error instanceof BrokerTransportError
                ? (error.requestId ?? "invalid")
                : "invalid",
            ok: false,
            error: wireError,
          } satisfies BrowserBrokerResponse);
        });
    });
    socket.once("close", () => {
      if (state.frameTimer) clearTimeout(state.frameTimer);
      if (state.requestController && !state.handlerSettled) {
        state.requestController.abort(
          new Error("Browser broker client disconnected before completion"),
        );
      }
      this.acceptedSockets.delete(socket);
    });
    socket.on("error", () => socket.destroy());
  }

  private async handleLine(
    line: string,
    signal: AbortSignal,
  ): Promise<{
    request: BrowserBrokerRequest;
    response: BrowserBrokerResponse;
  }> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch (error) {
      throw new BrokerTransportError(
        "browser_broker_protocol_invalid",
        `Browser broker request is not valid JSON: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const requestId = readWireRequestId(decoded);
    const token = readWireToken(decoded);
    if (!tokensEqual(token, this.authToken)) {
      throw new BrokerTransportError(
        "browser_broker_unauthorized",
        "Browser broker authentication failed",
        { requestId },
      );
    }
    const parsed = browserBrokerWireRequestSchema.safeParse(decoded);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BrokerTransportError(
        "browser_broker_protocol_invalid",
        `Browser broker request schema mismatch at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid request"}`,
        { requestId },
      );
    }
    return {
      request: parsed.data.request,
      response: await this.handler(parsed.data.request, signal),
    };
  }

  private runShutdownCallback(): void {
    this.onShutdown?.().catch((error) => {
      process.stderr.write(
        `[browser-broker] shutdown failed: ${errorMessage(error)}\n`,
      );
      process.exitCode = 1;
    });
  }
}

export class BrowserRuntimeBrokerClient {
  private readonly runtimeRoot?: string;
  private readonly timeoutMs: number;

  constructor(options: BrowserBrokerClientOptions = {}) {
    this.runtimeRoot = options.runtimeRoot;
    this.timeoutMs =
      options.requestTimeoutMs ?? BROWSER_BROKER_DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async request(
    request: BrowserBrokerRequest,
    signal?: AbortSignal,
  ): Promise<BrowserBrokerResponse> {
    signal?.throwIfAborted();
    const descriptor = readBrokerEndpointDescriptor(this.runtimeRoot);
    const wireRequest: BrowserBrokerWireRequest = {
      product: BROWSER_BROKER_PRODUCT,
      protocol: BROWSER_BROKER_PROTOCOL,
      version: BROWSER_BROKER_PROTOCOL_VERSION,
      auth_token: descriptor.auth_token,
      request,
    };
    try {
      return await sendWireRequest(
        descriptor.socket_path,
        wireRequest,
        this.timeoutMs,
        signal,
      );
    } catch (error) {
      if (brokerGenerationWasUnpublished(this.runtimeRoot, descriptor, error)) {
        throw new BrokerTransportError(
          "browser_broker_unavailable",
          `Browser broker generation ${descriptor.runtime_id} ended before ${request.action} returned`,
          { cause: error, requestId: request.id },
        );
      }
      throw error;
    }
  }

  async requestOrThrow<T>(
    request: BrowserBrokerRequest,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.request(request, signal);
    if (!response.ok) {
      if (!response.error) {
        throw new BrokerTransportError(
          "browser_broker_protocol_invalid",
          `Browser broker returned ok=false without an error for ${request.action}`,
        );
      }
      throw new BrowserBrokerClientError(response.error);
    }
    return response.data as T;
  }
}

function brokerGenerationWasUnpublished(
  runtimeRoot: string | undefined,
  expected: BrowserBrokerEndpointDescriptor,
  error: unknown,
): boolean {
  if (
    !(error instanceof BrokerTransportError) ||
    error.code !== "browser_broker_endpoint_invalid"
  ) {
    return false;
  }
  try {
    const current = readBrokerEndpointEnvelope(
      browserBrokerPaths(runtimeRoot).descriptorPath,
    );
    return current.runtime_id !== expected.runtime_id;
  } catch (readError) {
    return brokerEndpointDefinitelyAbsent(readError);
  }
}

export async function shutdownBrowserRuntimeBroker(
  options: BrowserBrokerClientOptions = {},
): Promise<{
  runtime_id: string;
  protocol_version: number;
  response: unknown;
}> {
  const path = browserBrokerPaths(options.runtimeRoot).descriptorPath;
  const descriptor = readBrokerEndpointEnvelope(path);
  const request = {
    id: randomUUID(),
    action: "broker.shutdown" as const,
  };
  const response = await sendWireRequest(
    descriptor.socket_path,
    {
      product: BROWSER_BROKER_PRODUCT,
      protocol: BROWSER_BROKER_PROTOCOL,
      version: descriptor.version,
      auth_token: descriptor.auth_token,
      request,
    },
    options.requestTimeoutMs ?? BROWSER_BROKER_DEFAULT_REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) {
    if (!response.error) {
      throw new BrokerTransportError(
        "browser_broker_protocol_invalid",
        "Browser broker returned ok=false without an error for broker.shutdown",
      );
    }
    throw new BrowserBrokerClientError(response.error);
  }
  return {
    runtime_id: descriptor.runtime_id,
    protocol_version: descriptor.version,
    response: response.data,
  };
}

export function readBrokerEndpointDescriptor(
  runtimeRoot?: string,
): BrowserBrokerEndpointDescriptor {
  const path = browserBrokerPaths(runtimeRoot).descriptorPath;
  const descriptor = readBrokerEndpointEnvelope(path);
  if (descriptor.version !== BROWSER_BROKER_PROTOCOL_VERSION) {
    throw new BrokerTransportError(
      "browser_broker_protocol_mismatch",
      `Browser broker protocol ${String(descriptor.version)} at ${path} does not match client protocol ${String(BROWSER_BROKER_PROTOCOL_VERSION)}`,
    );
  }
  return descriptor as BrowserBrokerEndpointDescriptor;
}

function readBrokerEndpointEnvelope(
  path: string,
): BrowserBrokerEndpointEnvelope {
  let descriptorStat;
  try {
    descriptorStat = lstatSync(path);
  } catch (error) {
    throw new BrokerTransportError(
      "browser_broker_unavailable",
      `Browser broker endpoint is unavailable at ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (descriptorStat.isSymbolicLink() || !descriptorStat.isFile()) {
    throw new BrokerTransportError(
      "browser_broker_endpoint_invalid",
      `Browser broker endpoint descriptor must be a regular non-symlink file at ${path}`,
    );
  }
  if (
    process.platform !== "win32" &&
    ((descriptorStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" &&
        descriptorStat.uid !== process.getuid()))
  ) {
    throw new BrokerTransportError(
      "browser_broker_endpoint_invalid",
      `Browser broker endpoint descriptor is not owner-only at ${path}`,
    );
  }
  let encoded: string;
  try {
    encoded = readFileSync(path, "utf8");
  } catch (error) {
    throw new BrokerTransportError(
      "browser_broker_unavailable",
      `Browser broker endpoint is unavailable at ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded) as unknown;
  } catch (error) {
    throw new BrokerTransportError(
      "browser_broker_endpoint_invalid",
      `Browser broker endpoint descriptor is not valid JSON at ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const parsed = browserBrokerEndpointEnvelopeSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new BrokerTransportError(
      "browser_broker_endpoint_invalid",
      `Browser broker endpoint descriptor is invalid at ${path}: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
    );
  }
  return parsed.data;
}

export function browserBrokerPaths(runtimeRoot?: string): BrokerPaths {
  const root =
    runtimeRoot ??
    process.env.UNICLI_BROWSER_RUNTIME_DIR ??
    join(userHome(), ".unicli", "browser-runtime");
  return {
    runtimeRoot: root,
    descriptorPath: join(root, "broker.json"),
    lockPath: join(root, "broker.lock"),
    guardPath: join(root, "broker.guard"),
    socketPath: resolveSocketPath(root),
  };
}

function resolveSocketPath(runtimeRoot: string): string {
  const direct = join(runtimeRoot, "broker.sock");
  if (process.platform === "win32") {
    const key = createHash("sha256")
      .update(runtimeRoot)
      .digest("hex")
      .slice(0, 24);
    return `\\\\.\\pipe\\unicli-browser-${key}`;
  }
  if (Buffer.byteLength(direct) <= UNIX_SOCKET_PATH_LIMIT) return direct;
  const key = createHash("sha256")
    .update(runtimeRoot)
    .digest("hex")
    .slice(0, 24);
  const privateTempDir = join(tmpdir(), `unicli-browser-${key}`);
  mkdirSync(privateTempDir, { recursive: true, mode: 0o700 });
  chmodSync(privateTempDir, 0o700);
  return join(privateTempDir, "broker.sock");
}

function prepareRuntimeRoot(runtimeRoot: string): void {
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  chmodSync(runtimeRoot, 0o700);
}

async function acquireBrokerLock(
  paths: BrokerPaths,
  runtimeId: string,
): Promise<BrokerOwnershipGuard> {
  const guard = await acquireBrokerGuard(paths.guardPath);
  try {
    const publishedBroker = await probePublishedBroker(paths);
    if (publishedBroker) {
      throw new BrokerTransportError(
        "browser_broker_already_running",
        `Browser broker ${publishedBroker.runtime_id} is reachable at ${publishedBroker.socket_path} (pid ${String(publishedBroker.pid)})`,
      );
    }
    rmSync(paths.lockPath, { force: true });
    rmSync(paths.descriptorPath, { force: true });
    writeBrokerLock(paths.lockPath, {
      pid: process.pid,
      runtime_id: runtimeId,
      created_at: new Date().toISOString(),
    });
    return guard;
  } catch (error) {
    await releaseBrokerGuard(guard);
    throw error;
  }
}

async function probePublishedBroker(
  paths: BrokerPaths,
): Promise<BrowserBrokerEndpointEnvelope | null> {
  let descriptor: BrowserBrokerEndpointEnvelope;
  try {
    descriptor = readBrokerEndpointEnvelope(paths.descriptorPath);
  } catch (error) {
    if (brokerEndpointDefinitelyAbsent(error)) {
      await assertDefaultBrokerEndpointUnoccupied(paths.socketPath);
      return null;
    }
    throw error;
  }
  if (!trustedPublishedSocketPath(paths, descriptor.socket_path)) {
    throw new BrokerTransportError(
      "browser_broker_endpoint_invalid",
      `Browser broker endpoint descriptor declares an untrusted socket path: ${descriptor.socket_path}`,
    );
  }
  const requestId = randomUUID();
  try {
    await sendWireRequest(
      descriptor.socket_path,
      {
        product: BROWSER_BROKER_PRODUCT,
        protocol: BROWSER_BROKER_PROTOCOL,
        version: descriptor.version,
        auth_token: descriptor.auth_token,
        request: { id: requestId, action: "broker.status" },
      },
      PUBLISHED_BROKER_PROBE_TIMEOUT_MS,
    );
    return descriptor;
  } catch (error) {
    if (
      error instanceof BrokerTransportError &&
      error.code === "browser_broker_unavailable" &&
      brokerEndpointDefinitelyAbsent(error)
    ) {
      return null;
    }
    if (
      error instanceof BrokerTransportError &&
      error.code === "browser_broker_timeout"
    ) {
      throw new BrokerTransportError(
        "browser_broker_already_running",
        `Browser broker endpoint ${descriptor.socket_path} accepted a probe but did not settle; refusing a second owner`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function assertDefaultBrokerEndpointUnoccupied(
  socketPath: string,
): Promise<void> {
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error === undefined) resolveProbe();
      else rejectProbe(error);
    };
    const timer = setTimeout(() => {
      finish(
        new BrokerTransportError(
          "browser_broker_already_running",
          `Browser broker endpoint ${socketPath} accepted a connection but its descriptor is missing; refusing to unlink a live endpoint`,
        ),
      );
    }, PUBLISHED_BROKER_PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      finish(
        new BrokerTransportError(
          "browser_broker_already_running",
          `Browser broker endpoint ${socketPath} is reachable but its descriptor is missing; refusing a second owner`,
        ),
      );
    });
    socket.once("error", (error) => {
      if (isErrno(error, "ENOENT") || isErrno(error, "ECONNREFUSED")) {
        finish();
        return;
      }
      finish(
        new BrokerTransportError(
          "browser_broker_endpoint_invalid",
          `Browser broker endpoint ${socketPath} cannot be proven stale without a descriptor: ${errorMessage(error)}`,
          { cause: error },
        ),
      );
    });
  });
}

function trustedPublishedSocketPath(
  paths: BrokerPaths,
  socketPath: string,
): boolean {
  if (socketPath === paths.socketPath) return true;
  if (process.platform === "win32") {
    return socketPath.startsWith("\\\\.\\pipe\\unicli-browser-");
  }
  return resolve(dirname(socketPath)) === resolve(paths.runtimeRoot);
}

function brokerEndpointDefinitelyAbsent(error: unknown): boolean {
  if (isErrno(error, "ENOENT") || isErrno(error, "ECONNREFUSED")) return true;
  if (error instanceof Error && error.cause !== undefined) {
    return brokerEndpointDefinitelyAbsent(error.cause);
  }
  return false;
}

async function acquireBrokerGuard(
  guardPath: string,
): Promise<BrokerOwnershipGuard> {
  if (process.platform === "darwin" || process.platform.endsWith("bsd")) {
    return acquireBsdBrokerGuard(guardPath);
  }
  const endpoint = brokerGuardSocketPath(guardPath);
  const server = createServer();
  try {
    await listen(server, endpoint);
    return { kind: "socket", server };
  } catch (error) {
    server.close();
    if (isErrno(error, "EADDRINUSE")) {
      throw new BrokerTransportError(
        "browser_broker_already_running",
        `Browser broker ownership guard is already held for ${guardPath}`,
        { cause: error },
      );
    }
    throw new BrokerTransportError(
      "browser_broker_unavailable",
      `Browser broker ownership guard could not bind for ${guardPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function brokerGuardSocketPath(guardPath: string): string {
  const key = createHash("sha256").update(guardPath).digest("hex").slice(0, 32);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\unicli-browser-guard-${key}`
    : `\0unicli-browser-guard-${key}`;
}

async function acquireBsdBrokerGuard(
  guardPath: string,
): Promise<BrokerOwnershipGuard> {
  try {
    return { kind: "file", lock: acquireKernelFileLock(guardPath) };
  } catch (error) {
    if (error instanceof KernelFileLockError && error.code === "contended") {
      throw new BrokerTransportError(
        "browser_broker_already_running",
        `Browser broker ownership guard is already held for ${guardPath}`,
        { cause: error },
      );
    }
    throw new BrokerTransportError(
      "browser_broker_unavailable",
      `Browser broker ownership guard could not lock ${guardPath}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function releaseBrokerGuard(guard: BrokerOwnershipGuard): Promise<void> {
  if (guard.kind === "socket") {
    if (guard.server.listening) await closeServer(guard.server);
    return;
  }
  guard.lock.release();
}

function writeBrokerLock(path: string, payload: LockPayload): void {
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function removeBrokerLock(path: string, runtimeId: string): void {
  if (!existsSync(path)) return;
  const holder = readLockPayload(path);
  if (holder?.runtime_id === runtimeId) rmSync(path);
}

function readLockPayload(path: string): LockPayload | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw new BrokerTransportError(
      "browser_broker_endpoint_invalid",
      `Browser broker lock is unreadable at ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof (decoded as Record<string, unknown>).pid !== "number" ||
    !Number.isInteger((decoded as Record<string, unknown>).pid) ||
    ((decoded as Record<string, unknown>).pid as number) <= 0 ||
    typeof (decoded as Record<string, unknown>).runtime_id !== "string" ||
    typeof (decoded as Record<string, unknown>).created_at !== "string"
  ) {
    throw new BrokerTransportError(
      "browser_broker_endpoint_invalid",
      `Browser broker lock has an invalid schema at ${path}`,
    );
  }
  return decoded as LockPayload;
}

function writeEndpointDescriptor(
  path: string,
  descriptor: BrowserBrokerEndpointDescriptor,
): void {
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

function removeEndpointDescriptor(path: string, runtimeId: string): void {
  if (!existsSync(path)) return;
  const current = readBrokerEndpointDescriptorFromPath(path);
  if (current.runtime_id === runtimeId) rmSync(path, { force: true });
}

function readBrokerEndpointDescriptorFromPath(
  path: string,
): BrowserBrokerEndpointEnvelope {
  return readBrokerEndpointEnvelope(path);
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function sendBrokerResponse(
  socket: Socket,
  response: BrowserBrokerResponse,
): void {
  let payload = Buffer.from(JSON.stringify(response), "utf8");
  if (payload.length > BROWSER_BROKER_MAX_ARTIFACT_BYTES) {
    payload = Buffer.from(
      JSON.stringify({
        id: response.id,
        ok: false,
        error: transportWireError(
          "browser_broker_message_too_large",
          `Browser broker response exceeded the ${String(BROWSER_BROKER_MAX_ARTIFACT_BYTES)}-byte artifact limit`,
        ),
      } satisfies BrowserBrokerResponse),
      "utf8",
    );
  }
  if (payload.length <= BROWSER_BROKER_MAX_MESSAGE_BYTES) {
    socket.end(Buffer.concat([payload, Buffer.from("\n")]));
    return;
  }
  const header: BrowserBrokerArtifactHeader = {
    id: response.id,
    artifact: {
      encoding: "json",
      byte_length: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    },
  };
  socket.write(`${JSON.stringify(header)}\n`);
  socket.end(payload);
}

function sendWireRequest(
  socketPath: string,
  request: BrowserBrokerWireRequest | BrowserBrokerCompatibleWireRequest,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BrowserBrokerResponse> {
  signal?.throwIfAborted();
  const requestPayload = Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
  if (requestPayload.length > BROWSER_BROKER_MAX_MESSAGE_BYTES) {
    return Promise.reject(
      new BrokerTransportError(
        "browser_broker_message_too_large",
        `Browser broker request exceeded ${String(BROWSER_BROKER_MAX_MESSAGE_BYTES)} bytes`,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const headerChunks: Buffer[] = [];
    const artifactChunks: Buffer[] = [];
    let headerByteCount = 0;
    let artifactByteCount = 0;
    let artifactHeader: BrowserBrokerArtifactHeader | null = null;
    let frameDispatched = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("error", finishError);
      socket.off("end", finishPrematureEnd);
      signal?.removeEventListener("abort", finishAbort);
    };
    const finishSuccess = (response: BrowserBrokerResponse): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.end();
      resolve(response);
    };
    const finishError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      const transportError =
        signal?.aborted && error === signal.reason
          ? error
          : error instanceof BrokerTransportError
            ? error
            : new BrokerTransportError(
                "browser_broker_unavailable",
                `Browser broker connection failed at ${socketPath}: ${errorMessage(error)}`,
                { cause: error },
              );
      const authoritativeError =
        frameDispatched &&
        !requestOutcomeCanBeAmbiguous(request.request) &&
        transportError instanceof BrokerTransportError &&
        transportError.code === "browser_broker_unavailable"
          ? new BrokerTransportError(
              "browser_broker_endpoint_invalid",
              `Browser broker endpoint lost the ${request.request.action} response after accepting its request frame`,
              { cause: transportError, requestId: request.request.id },
            )
          : transportError;
      reject(
        frameDispatched && requestOutcomeCanBeAmbiguous(request.request)
          ? new BrowserBrokerOutcomeAmbiguousError(
              request.request.id,
              browserBrokerOperation(request.request),
              authoritativeError,
            )
          : authoritativeError,
      );
    };
    const finishAbort = (): void => finishError(signal?.reason);
    const finishPrematureEnd = (): void => {
      finishError(
        new BrokerTransportError(
          "browser_broker_unavailable",
          `Browser broker closed the connection before completing a response at ${socketPath}`,
        ),
      );
    };
    const finishArtifact = (): void => {
      if (!artifactHeader) return;
      const payload = Buffer.concat(artifactChunks);
      if (payload.length !== artifactHeader.artifact.byte_length) {
        finishError(
          new BrokerTransportError(
            "browser_broker_protocol_invalid",
            `Browser broker artifact length mismatch: expected ${String(artifactHeader.artifact.byte_length)}, received ${String(payload.length)}`,
          ),
        );
        return;
      }
      const digest = createHash("sha256").update(payload).digest("hex");
      if (digest !== artifactHeader.artifact.sha256) {
        finishError(
          new BrokerTransportError(
            "browser_broker_protocol_invalid",
            "Browser broker artifact integrity check failed",
          ),
        );
        return;
      }
      readResponse(payload, artifactHeader.id, finishSuccess, finishError);
    };
    const acceptArtifactChunk = (chunk: Buffer): void => {
      if (!artifactHeader || chunk.length === 0) return;
      artifactByteCount += chunk.length;
      if (artifactByteCount > artifactHeader.artifact.byte_length) {
        finishError(
          new BrokerTransportError(
            "browser_broker_protocol_invalid",
            "Browser broker artifact exceeded its declared length",
          ),
        );
        return;
      }
      artifactChunks.push(chunk);
      if (artifactByteCount === artifactHeader.artifact.byte_length) {
        finishArtifact();
      }
    };
    const acceptHeader = (chunk: Buffer): void => {
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) {
        headerByteCount += chunk.length;
        if (headerByteCount > BROWSER_BROKER_MAX_MESSAGE_BYTES) {
          finishError(
            new BrokerTransportError(
              "browser_broker_message_too_large",
              "Browser broker response header exceeded the message size limit",
            ),
          );
          return;
        }
        headerChunks.push(chunk);
        return;
      }
      headerByteCount += newline;
      if (headerByteCount > BROWSER_BROKER_MAX_MESSAGE_BYTES) {
        finishError(
          new BrokerTransportError(
            "browser_broker_message_too_large",
            "Browser broker response header exceeded the message size limit",
          ),
        );
        return;
      }
      headerChunks.push(chunk.subarray(0, newline));
      const headerBytes = Buffer.concat(headerChunks);
      const decoded = parseJsonPayload(headerBytes, "response header");
      if (decoded instanceof BrokerTransportError) {
        finishError(decoded);
        return;
      }
      const inline = browserBrokerResponseSchema.safeParse(decoded);
      if (inline.success) {
        if (inline.data.id !== request.request.id) {
          finishError(
            new BrokerTransportError(
              "browser_broker_protocol_invalid",
              `Browser broker response id mismatch: expected ${request.request.id}, received ${inline.data.id}`,
            ),
          );
          return;
        }
        if (chunk.length !== newline + 1) {
          finishError(
            new BrokerTransportError(
              "browser_broker_protocol_invalid",
              "Inline browser broker response included trailing bytes",
            ),
          );
          return;
        }
        finishSuccess(inline.data);
        return;
      }
      const artifact = browserBrokerArtifactHeaderSchema.safeParse(decoded);
      if (!artifact.success) {
        finishError(
          new BrokerTransportError(
            "browser_broker_protocol_invalid",
            `Browser broker response schema mismatch: ${inline.error.issues[0]?.message ?? artifact.error.issues[0]?.message ?? "invalid response"}`,
          ),
        );
        return;
      }
      if (artifact.data.id !== request.request.id) {
        finishError(
          new BrokerTransportError(
            "browser_broker_protocol_invalid",
            `Browser broker artifact id mismatch: expected ${request.request.id}, received ${artifact.data.id}`,
          ),
        );
        return;
      }
      artifactHeader = artifact.data;
      acceptArtifactChunk(chunk.subarray(newline + 1));
    };
    timer = setTimeout(() => {
      finishError(
        new BrokerTransportError(
          "browser_broker_timeout",
          `Browser broker request ${request.request.action} timed out after ${String(timeoutMs)}ms`,
        ),
      );
    }, timeoutMs);
    socket.once("connect", () => {
      try {
        socket.write(requestPayload);
        frameDispatched = true;
      } catch (error) {
        finishError(error);
      }
    });
    socket.on("data", (chunk: Buffer) => {
      if (artifactHeader) acceptArtifactChunk(chunk);
      else acceptHeader(chunk);
    });
    socket.once("error", finishError);
    socket.once("end", finishPrematureEnd);
    signal?.addEventListener("abort", finishAbort, { once: true });
  });
}

function requestOutcomeCanBeAmbiguous(request: BrowserBrokerRequest): boolean {
  return (
    request.action === "target.command" &&
    browserPageCommandCanMutate(request.command)
  );
}

function browserBrokerOperation(request: BrowserBrokerRequest): string {
  return request.action === "target.command"
    ? `target.command:${request.command.method}`
    : request.action;
}

function parseJsonPayload(
  payload: Buffer,
  label: string,
): unknown | BrokerTransportError {
  try {
    return JSON.parse(payload.toString("utf8")) as unknown;
  } catch (error) {
    return new BrokerTransportError(
      "browser_broker_protocol_invalid",
      `Browser broker ${label} is not valid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function readResponse(
  payload: Buffer,
  expectedId: string,
  resolve: (response: BrowserBrokerResponse) => void,
  reject: (error: unknown) => void,
): void {
  const decoded = parseJsonPayload(payload, "artifact");
  if (decoded instanceof BrokerTransportError) {
    reject(decoded);
    return;
  }
  const parsed = browserBrokerResponseSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.id !== expectedId) {
    reject(
      new BrokerTransportError(
        "browser_broker_protocol_invalid",
        `Browser broker artifact response mismatch: ${parsed.success ? "request id changed" : (parsed.error.issues[0]?.message ?? "invalid response")}`,
      ),
    );
    return;
  }
  resolve(parsed.data);
}

function readWireToken(decoded: unknown): string {
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof (decoded as Record<string, unknown>).auth_token !== "string"
  ) {
    return "";
  }
  return (decoded as Record<string, unknown>).auth_token as string;
}

function readWireRequestId(decoded: unknown): string | undefined {
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof (decoded as Record<string, unknown>).request !== "object" ||
    (decoded as Record<string, unknown>).request === null
  ) {
    return undefined;
  }
  const request = (decoded as Record<string, unknown>).request as Record<
    string,
    unknown
  >;
  return typeof request.id === "string" ? request.id : undefined;
}

function tokensEqual(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function transportWireError(
  code: BrokerTransportErrorCode,
  message: string,
): BrowserBrokerError {
  const error = new BrokerTransportError(code, message);
  return {
    code: error.code,
    message: error.message,
    suggestion: error.suggestion,
    retryable: error.retryable,
  };
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function brokerTransportSuggestion(code: BrokerTransportErrorCode): string {
  switch (code) {
    case "browser_broker_unavailable":
      return "Start the Uni-CLI browser broker and retry the request.";
    case "browser_broker_already_running":
      return "Use the live broker reported by the endpoint descriptor; do not start a second owner.";
    case "browser_broker_endpoint_invalid":
      return "Stop the stale broker process, remove only the reported endpoint descriptor, and restart.";
    case "browser_broker_protocol_mismatch":
      return "Run `unicli browser broker restart` to retire the authenticated older broker and start the current protocol.";
    case "browser_broker_unauthorized":
      return "Reconnect through the owner-only endpoint descriptor; do not reuse cached broker credentials.";
    case "browser_broker_protocol_invalid":
      return "Upgrade Uni-CLI clients and the broker together so their protocol versions match.";
    case "browser_broker_message_too_large":
      return "Use snapshot references or files instead of sending an oversized inline broker payload.";
    case "browser_broker_timeout":
      return "Inspect broker status and the target queue before retrying the same operation.";
  }
}
