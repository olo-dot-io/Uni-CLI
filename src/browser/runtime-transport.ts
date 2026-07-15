/**
 * @owner       src/browser/runtime-transport.ts
 * @does        Serve and call the Browser Runtime Broker over an authenticated owner-only Unix socket or secret-bearing Windows named pipe.
 * @needs       node:crypto, node:fs, node:net, node:os, node:path, src/browser/runtime-protocol.ts, src/engine/user-home.ts
 * @feeds       src/browser/runtime-broker-main.ts, src/browser/runtime-launch.ts, src/browser/runtime-client.ts, native browser host
 * @breaks      BrokerTransportError on endpoint/lock/auth/schema/framing/connect/timeout failures; broker responses preserve provider errors.
 * @invariants  One broker lock owns one endpoint descriptor; descriptor and Unix socket are mode 0600; messages are bounded newline-delimited JSON; tokens compare in constant time.
 * @side-effects Creates/removes runtime files and sockets, opens local IPC connections, and accepts concurrent client requests.
 * @perf        One short local socket connection per request; payloads are capped at 4 MiB.
 * @concurrency The OS accept queue handles independent clients; each connection carries exactly one request/response; broker owns target serialization.
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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
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
import { join } from "node:path";
import { z } from "zod";

import {
  BROWSER_BROKER_MAX_MESSAGE_BYTES,
  BROWSER_BROKER_PRODUCT,
  BROWSER_BROKER_PROTOCOL,
  BROWSER_BROKER_PROTOCOL_VERSION,
  browserBrokerEndpointDescriptorSchema,
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
  handler: (request: BrowserBrokerRequest) => Promise<BrowserBrokerResponse>;
  onShutdown?: () => Promise<void>;
}

interface BrowserBrokerClientOptions {
  runtimeRoot?: string;
  timeoutMs?: number;
}

interface BrokerPaths {
  runtimeRoot: string;
  descriptorPath: string;
  lockPath: string;
  socketPath: string;
}

interface LockPayload {
  pid: number;
  runtime_id: string;
  created_at: string;
}

type BrokerTransportErrorCode =
  | "browser_broker_unavailable"
  | "browser_broker_already_running"
  | "browser_broker_endpoint_invalid"
  | "browser_broker_unauthorized"
  | "browser_broker_protocol_invalid"
  | "browser_broker_message_too_large"
  | "browser_broker_timeout";

const DEFAULT_CLIENT_TIMEOUT_MS = 30_000;
const UNIX_SOCKET_PATH_LIMIT = 100;

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
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<BrowserBrokerResponse>;

export class BrokerTransportError extends Error {
  readonly retryable: boolean;
  readonly suggestion: string;

  constructor(
    readonly code: BrokerTransportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BrokerTransportError";
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

  constructor(error: BrowserBrokerError) {
    super(error.message);
    this.name = "BrowserBrokerClientError";
    this.code = error.code;
    this.suggestion = error.suggestion;
    this.retryable = error.retryable;
  }
}

export class BrowserRuntimeBrokerServer {
  private readonly paths: BrokerPaths;
  private readonly runtimeId: string;
  private readonly handler: BrowserBrokerServerOptions["handler"];
  private readonly onShutdown?: () => Promise<void>;
  private readonly authToken = randomBytes(32).toString("base64url");
  private server: Server | null = null;
  private lockFd: number | null = null;
  private descriptor: BrowserBrokerEndpointDescriptor | null = null;

  constructor(options: BrowserBrokerServerOptions) {
    this.paths = browserBrokerPaths(options.runtimeRoot);
    this.runtimeId = options.runtimeId;
    this.handler = options.handler;
    this.onShutdown = options.onShutdown;
  }

  async start(): Promise<BrowserBrokerEndpointDescriptor> {
    if (this.server || this.lockFd !== null) {
      throw new BrokerTransportError(
        "browser_broker_already_running",
        "This BrowserRuntimeBrokerServer instance is already started",
      );
    }
    prepareRuntimeRoot(this.paths.runtimeRoot);
    this.lockFd = acquireBrokerLock(this.paths.lockPath, this.runtimeId);
    if (process.platform !== "win32")
      rmSync(this.paths.socketPath, { force: true });
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await listen(server, this.paths.socketPath);
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
    if (server?.listening) await attempt(() => closeServer(server));
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
    if (process.platform !== "win32") {
      try {
        rmSync(this.paths.socketPath, { force: true });
      } catch (error) {
        stopError ??= error;
      }
    }
    if (this.lockFd !== null) {
      try {
        closeSync(this.lockFd);
      } catch (error) {
        stopError ??= error;
      }
      this.lockFd = null;
      try {
        rmSync(this.paths.lockPath, { force: true });
      } catch (error) {
        stopError ??= error;
      }
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
    let payload = "";
    let handled = false;
    const fail = (error: BrowserBrokerError): void => {
      if (handled) return;
      handled = true;
      socket.end(
        `${JSON.stringify({ id: "invalid", ok: false, error } satisfies BrowserBrokerResponse)}\n`,
      );
    };
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
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
      payload += chunk.toString("utf8");
      const newline = payload.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      socket.pause();
      const line = payload.slice(0, newline);
      this.handleLine(line)
        .then(({ request, response }) => {
          socket.end(`${JSON.stringify(response)}\n`);
          if (request.action === "broker.shutdown" && this.onShutdown) {
            socket.once("close", () => this.runShutdownCallback());
          }
        })
        .catch((error) => {
          const wireError =
            error instanceof BrokerTransportError
              ? transportWireError(error.code, error.message)
              : transportWireError(
                  "browser_broker_protocol_invalid",
                  errorMessage(error),
                );
          socket.end(
            `${JSON.stringify({
              id: "invalid",
              ok: false,
              error: wireError,
            } satisfies BrowserBrokerResponse)}\n`,
          );
        });
    });
    socket.on("error", (error) => {
      process.stderr.write(
        `[browser-broker] client socket error: ${error.message}\n`,
      );
    });
  }

  private async handleLine(line: string): Promise<{
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
    const token = readWireToken(decoded);
    if (!tokensEqual(token, this.authToken)) {
      throw new BrokerTransportError(
        "browser_broker_unauthorized",
        "Browser broker authentication failed",
      );
    }
    const parsed = browserBrokerWireRequestSchema.safeParse(decoded);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new BrokerTransportError(
        "browser_broker_protocol_invalid",
        `Browser broker request schema mismatch at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid request"}`,
      );
    }
    return {
      request: parsed.data.request,
      response: await this.handler(parsed.data.request),
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
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
  }

  async request(request: BrowserBrokerRequest): Promise<BrowserBrokerResponse> {
    const descriptor = readBrokerEndpointDescriptor(this.runtimeRoot);
    const wireRequest: BrowserBrokerWireRequest = {
      product: BROWSER_BROKER_PRODUCT,
      protocol: BROWSER_BROKER_PROTOCOL,
      version: BROWSER_BROKER_PROTOCOL_VERSION,
      auth_token: descriptor.auth_token,
      request,
    };
    return sendWireRequest(descriptor.socket_path, wireRequest, this.timeoutMs);
  }

  async requestOrThrow<T>(request: BrowserBrokerRequest): Promise<T> {
    const response = await this.request(request);
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

export function readBrokerEndpointDescriptor(
  runtimeRoot?: string,
): BrowserBrokerEndpointDescriptor {
  const path = browserBrokerPaths(runtimeRoot).descriptorPath;
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new BrokerTransportError(
      "browser_broker_unavailable",
      `Browser broker endpoint is unavailable at ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const parsed = browserBrokerEndpointDescriptorSchema.safeParse(decoded);
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

function acquireBrokerLock(path: string, runtimeId: string): number {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      const payload: LockPayload = {
        pid: process.pid,
        runtime_id: runtimeId,
        created_at: new Date().toISOString(),
      };
      writeFileSync(fd, `${JSON.stringify(payload)}\n`, "utf8");
      return fd;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const holder = readLockPayload(path);
      if (holder && processIsAlive(holder.pid)) {
        throw new BrokerTransportError(
          "browser_broker_already_running",
          `Browser broker lock is held by live process ${String(holder.pid)} (${holder.runtime_id})`,
        );
      }
      rmSync(path, { force: true });
    }
  }
  throw new BrokerTransportError(
    "browser_broker_already_running",
    `Browser broker lock could not be acquired: ${path}`,
  );
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
): BrowserBrokerEndpointDescriptor {
  const parsed = browserBrokerEndpointDescriptorSchema.safeParse(
    JSON.parse(readFileSync(path, "utf8")) as unknown,
  );
  if (!parsed.success) {
    throw new BrokerTransportError(
      "browser_broker_endpoint_invalid",
      `Browser broker endpoint descriptor is invalid at ${path}`,
    );
  }
  return parsed.data;
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

function sendWireRequest(
  socketPath: string,
  request: BrowserBrokerWireRequest,
  timeoutMs: number,
): Promise<BrowserBrokerResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let payload = "";
    let byteCount = 0;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("error", finishError);
      socket.off("end", finishPrematureEnd);
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
      reject(
        error instanceof BrokerTransportError
          ? error
          : new BrokerTransportError(
              "browser_broker_unavailable",
              `Browser broker connection failed at ${socketPath}: ${errorMessage(error)}`,
              { cause: error },
            ),
      );
    };
    const finishPrematureEnd = (): void => {
      finishError(
        new BrokerTransportError(
          "browser_broker_unavailable",
          `Browser broker closed the connection before completing a response at ${socketPath}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      finishError(
        new BrokerTransportError(
          "browser_broker_timeout",
          `Browser broker request ${request.request.action} timed out after ${String(timeoutMs)}ms`,
        ),
      );
    }, timeoutMs);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      byteCount += chunk.length;
      if (byteCount > BROWSER_BROKER_MAX_MESSAGE_BYTES) {
        finishError(
          new BrokerTransportError(
            "browser_broker_message_too_large",
            "Browser broker response exceeded the message size limit",
          ),
        );
        return;
      }
      payload += chunk.toString("utf8");
      const newline = payload.indexOf("\n");
      if (newline < 0) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(payload.slice(0, newline)) as unknown;
      } catch (error) {
        finishError(
          new BrokerTransportError(
            "browser_broker_protocol_invalid",
            `Browser broker response is not valid JSON: ${errorMessage(error)}`,
            { cause: error },
          ),
        );
        return;
      }
      const parsed = browserBrokerResponseSchema.safeParse(decoded);
      if (!parsed.success) {
        finishError(
          new BrokerTransportError(
            "browser_broker_protocol_invalid",
            `Browser broker response schema mismatch: ${parsed.error.issues[0]?.message ?? "invalid response"}`,
          ),
        );
        return;
      }
      finishSuccess(parsed.data);
    });
    socket.once("error", finishError);
    socket.once("end", finishPrematureEnd);
  });
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
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
