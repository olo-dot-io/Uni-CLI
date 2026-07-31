/**
 * @owner   src/transport/adapters/visual.ts
 * @does    Provide Uni-CLI's explicitly selected request-contained screenshot-plus-model visual transport, with test mocks and fail-closed production selection.
 * @needs   core/envelope, transport/types
 * @feeds   src/transport/bus.ts, src/engine/steps/visual.ts, explicitly selected visual compute routes
 * @breaks  A backend without explicit abort containment, or a shell that overwrites fulfillment with late cancellation, can duplicate desktop input.
 * @invariants Backend selection is deterministic and never silently chooses a mock; legacy non-cancellable backends fail closed; mutations invalidate cached screenshots; fulfilled actions are authoritative and cancellation-caused mutation rejection is outcome-ambiguous.
 * @side-effects May click, type, scroll, drag, or launch through a configured backend.
 * @perf    Screenshot payload size dominates memory use.
 * @concurrency Backend implementations own synchronization and must settle cancellation only after their external work is contained.
 * @test    tests/unit/transport/adapters/visual.test.ts
 * @stability beta
 * @since   0.222.0
 */

import { err, exitCodeFor, ok } from "../../core/envelope.js";
import type { Envelope } from "../../core/envelope.js";
import { settleDispatchedAction } from "../action-settlement.js";
import { isOperationOutcomeAmbiguousError } from "../contained-process.js";
import type {
  ActionRequest,
  ActionResult,
  Capability,
  Snapshot,
  SnapshotFormat,
  TransportAdapter,
  TransportContext,
  TransportKind,
} from "../types.js";

export interface VisualBackend {
  readonly name: VisualBackendName;
  readonly cancellation: typeof VISUAL_CANCELLATION_PROTOCOL;
  snapshot(signal?: AbortSignal): Promise<{
    base64: string;
    width: number;
    height: number;
    mime?: string;
  }>;
  click(
    x: number,
    y: number,
    button?: "left" | "right",
    signal?: AbortSignal,
  ): Promise<void>;
  type(text: string, signal?: AbortSignal): Promise<void>;
  key(key: string, signal?: AbortSignal): Promise<void>;
  scroll(dx: number, dy: number, signal?: AbortSignal): Promise<void>;
  drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    signal?: AbortSignal,
  ): Promise<void>;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  ask?(question: string, signal?: AbortSignal): Promise<string>;
  launch?(app: string, signal?: AbortSignal): Promise<void>;
}

export const VISUAL_CANCELLATION_PROTOCOL = "request-contained-v1" as const;

export type VisualBackendName = "mock" | "remote" | "unavailable";

export const VISUAL_STEPS = [
  "visual_snapshot",
  "visual_click",
  "visual_type",
  "visual_key",
  "visual_scroll",
  "visual_drag",
  "visual_wait",
  "visual_assert",
  "visual_ask",
  "visual_backend",
  "visual_launch",
] as const;

const VISUAL_CAPABILITY: Capability = {
  steps: VISUAL_STEPS,
  snapshotFormats: ["screenshot"] as readonly SnapshotFormat[],
  mutatesHost: true,
};

const VISUAL_READ_ONLY_ACTIONS = new Set([
  "visual_snapshot",
  "visual_wait",
  "visual_assert",
  "visual_ask",
  "visual_backend",
]);

const MOCK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

export class MockBackend implements VisualBackend {
  readonly name: VisualBackendName = "mock";
  readonly cancellation = VISUAL_CANCELLATION_PROTOCOL;
  readonly history: Array<{ verb: string; args: unknown[] }> = [];

  private record(verb: string, ...args: unknown[]): void {
    this.history.push({ verb, args });
  }

  async snapshot(signal?: AbortSignal): Promise<{
    base64: string;
    width: number;
    height: number;
    mime: string;
  }> {
    signal?.throwIfAborted();
    this.record("snapshot");
    return { base64: MOCK_PNG_BASE64, width: 1, height: 1, mime: "image/png" };
  }

  async click(
    x: number,
    y: number,
    button: "left" | "right" = "left",
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    this.record("click", x, y, button);
  }

  async type(text: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.record("type", text);
  }

  async key(key: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.record("key", key);
  }

  async scroll(dx: number, dy: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.record("scroll", dx, dy);
  }

  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    this.record("drag", fromX, fromY, toX, toY);
  }

  async wait(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.record("wait", ms);
  }

  async ask(question: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    this.record("ask", question);
    return "yes";
  }

  async launch(app: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.record("launch", app);
  }
}

class BackendNotReadyError extends Error {
  constructor(
    readonly backend: VisualBackendName,
    readonly verb: string,
    readonly hint: string,
  ) {
    super(`visual backend "${backend}" is not ready for ${verb}: ${hint}`);
    this.name = "BackendNotReadyError";
  }
}

class BackendContractError extends Error {
  constructor(readonly backend: string) {
    super(
      `visual backend "${backend}" does not implement ${VISUAL_CANCELLATION_PROTOCOL} cancellation`,
    );
    this.name = "BackendContractError";
  }
}

export class UnavailableVisualBackend implements VisualBackend {
  readonly name: VisualBackendName = "unavailable";
  readonly cancellation = VISUAL_CANCELLATION_PROTOCOL;

  constructor(readonly reason: string) {}

  private unavailable(verb: string): never {
    throw new BackendNotReadyError(this.name, verb, this.reason);
  }

  async snapshot(
    signal?: AbortSignal,
  ): Promise<{ base64: string; width: number; height: number }> {
    signal?.throwIfAborted();
    this.unavailable("snapshot");
  }

  async click(
    _x: number,
    _y: number,
    _button?: "left" | "right",
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    this.unavailable("click");
  }

  async type(_text: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.unavailable("type");
  }

  async key(_key: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.unavailable("key");
  }

  async scroll(_dx: number, _dy: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.unavailable("scroll");
  }

  async drag(
    _fromX: number,
    _fromY: number,
    _toX: number,
    _toY: number,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    this.unavailable("drag");
  }

  async wait(_ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.unavailable("wait");
  }

  async ask(_question: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    this.unavailable("ask");
  }

  async launch(_app: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.unavailable("launch");
  }
}

export class RemoteVisualBackend implements VisualBackend {
  readonly name: VisualBackendName = "remote";
  readonly cancellation = VISUAL_CANCELLATION_PROTOCOL;

  constructor(
    readonly endpoint: string,
    readonly apiKey?: string,
  ) {}

  private notReady(verb: string): never {
    throw new BackendNotReadyError(
      this.name,
      verb,
      `configure a production remote visual backend at ${this.endpoint}`,
    );
  }

  async snapshot(
    signal?: AbortSignal,
  ): Promise<{ base64: string; width: number; height: number }> {
    signal?.throwIfAborted();
    this.notReady("snapshot");
  }
  async click(
    _x?: number,
    _y?: number,
    _button?: "left" | "right",
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    this.notReady("click");
  }
  async type(_text?: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.notReady("type");
  }
  async key(_key?: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.notReady("key");
  }
  async scroll(
    _dx?: number,
    _dy?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    this.notReady("scroll");
  }
  async drag(
    _fromX?: number,
    _fromY?: number,
    _toX?: number,
    _toY?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    this.notReady("drag");
  }
  async wait(ms: number, signal?: AbortSignal): Promise<void> {
    await waitForVisualDelay(Math.max(0, ms), signal);
  }
  async ask(_question?: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    this.notReady("ask");
  }
}

export interface VisualEnv {
  VISUAL_BACKEND?: string;
  VISUAL_BACKEND_ENDPOINT?: string;
  VISUAL_BACKEND_API_KEY?: string;
}

export function selectVisualBackend(
  env: VisualEnv = process.env,
): VisualBackend {
  const requested = (env.VISUAL_BACKEND ?? "").trim().toLowerCase();
  if (requested === "mock") return new MockBackend();
  if (requested === "remote" && env.VISUAL_BACKEND_ENDPOINT?.trim()) {
    return new RemoteVisualBackend(
      env.VISUAL_BACKEND_ENDPOINT.trim(),
      env.VISUAL_BACKEND_API_KEY,
    );
  }
  if (requested === "remote") {
    return new UnavailableVisualBackend(
      "VISUAL_BACKEND=remote requires VISUAL_BACKEND_ENDPOINT",
    );
  }
  if (requested) {
    return new UnavailableVisualBackend(
      `unsupported VISUAL_BACKEND value ${JSON.stringify(env.VISUAL_BACKEND)}; supported values are remote and explicit test-only mock`,
    );
  }
  return new UnavailableVisualBackend(
    "set VISUAL_BACKEND=remote and VISUAL_BACKEND_ENDPOINT; mock must be selected explicitly for tests",
  );
}

export interface VisualTransportOptions {
  backend?: VisualBackend;
  env?: VisualEnv;
}

export class VisualTransport implements TransportAdapter {
  readonly kind: TransportKind = "visual";
  readonly capability: Capability = VISUAL_CAPABILITY;

  private backend: VisualBackend;
  private lastSnapshot: Snapshot | undefined = undefined;

  constructor(opts: VisualTransportOptions = {}) {
    this.backend = opts.backend ?? selectVisualBackend(opts.env);
  }

  get activeBackendName(): VisualBackendName {
    return this.backend.name;
  }

  setBackend(backend: VisualBackend): void {
    this.backend = backend;
    this.lastSnapshot = undefined;
  }

  async open(_ctx: TransportContext): Promise<void> {}

  async snapshot(opts?: {
    format?: SnapshotFormat;
    signal?: AbortSignal;
  }): Promise<Snapshot> {
    opts?.signal?.throwIfAborted();
    const format = opts?.format ?? "screenshot";
    if (this.lastSnapshot && format === this.lastSnapshot.format) {
      return this.lastSnapshot;
    }
    const raw = await this.requireCancellableBackend().snapshot(opts?.signal);
    const snap: Snapshot = {
      format: "screenshot",
      data: Buffer.from(raw.base64, "base64"),
      width: raw.width,
      height: raw.height,
    };
    this.lastSnapshot = snap;
    return snap;
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    const start = Date.now();
    if (!VISUAL_READ_ONLY_ACTIONS.has(req.kind)) {
      this.lastSnapshot = undefined;
    }
    try {
      const envelope = await settleDispatchedAction(
        req.kind,
        !VISUAL_READ_ONLY_ACTIONS.has(req.kind) || req.canMutate === true,
        req.signal,
        () => this.dispatch<T>(req),
      );
      envelope.elapsedMs = Date.now() - start;
      return envelope;
    } catch (e) {
      if (isOperationOutcomeAmbiguousError(e)) throw e;
      req.signal?.throwIfAborted();
      if (
        e instanceof BackendContractError ||
        e instanceof BackendNotReadyError
      ) {
        return this.envelopeFromBackendError<T>(req.kind, e);
      }
      const msg = e instanceof Error ? e.message : String(e);
      return err({
        transport: "visual",
        step: 0,
        action: req.kind,
        reason: `unexpected error in visual.${req.kind}: ${msg}`,
        suggestion: "check visual backend configuration",
        retryable: false,
      });
    }
  }

  async close(): Promise<void> {
    this.lastSnapshot = undefined;
  }

  private async dispatch<T>(req: ActionRequest): Promise<Envelope<T>> {
    switch (req.kind) {
      case "visual_snapshot":
        return this.doSnapshot<T>(req.signal);
      case "visual_click":
        return this.doClick<T>(req.params, req.signal);
      case "visual_type":
        return this.doType<T>(req.params, req.signal);
      case "visual_key":
        return this.doKey<T>(req.params, req.signal);
      case "visual_scroll":
        return this.doScroll<T>(req.params, req.signal);
      case "visual_drag":
        return this.doDrag<T>(req.params, req.signal);
      case "visual_wait":
        return this.doWait<T>(req.params, req.signal);
      case "visual_assert":
        return this.doAssert<T>(req.params, req.signal);
      case "visual_ask":
        return this.doAsk<T>(req.params, req.signal);
      case "visual_backend":
        return this.doBackendInfo<T>();
      case "visual_launch":
        return this.doLaunch<T>(req.params, req.signal);
      default:
        return err({
          transport: "visual",
          step: 0,
          action: req.kind,
          reason: `unsupported action "${req.kind}" for visual transport`,
          suggestion: `visual transport supports: ${VISUAL_STEPS.join(", ")}`,
          minimum_capability: `visual.${req.kind}`,
          exit_code: exitCodeFor("usage_error"),
        });
    }
  }

  private envelopeFromBackendError<T>(verb: string, e: unknown): Envelope<T> {
    const msg = e instanceof Error ? e.message : String(e);
    const configurationError =
      e instanceof BackendNotReadyError || e instanceof BackendContractError;
    return err({
      transport: "visual",
      step: 0,
      action: verb,
      reason: msg,
      suggestion: configurationError
        ? `configure the \`${this.backend.name}\` visual backend before calling visual.${verb}`
        : "inspect backend error and retry",
      minimum_capability: `visual.${verb}`,
      retryable: !configurationError,
      exit_code: configurationError
        ? exitCodeFor("config_error")
        : exitCodeFor("service_unavailable"),
    });
  }

  private requireCancellableBackend(): VisualBackend {
    if (this.backend.cancellation !== VISUAL_CANCELLATION_PROTOCOL) {
      throw new BackendContractError(String(this.backend.name));
    }
    return this.backend;
  }

  private async doSnapshot<T>(signal?: AbortSignal): Promise<Envelope<T>> {
    try {
      const raw = await this.requireCancellableBackend().snapshot(signal);
      this.lastSnapshot = {
        format: "screenshot",
        data: Buffer.from(raw.base64, "base64"),
        width: raw.width,
        height: raw.height,
      };
      return ok({
        backend: this.backend.name,
        width: raw.width,
        height: raw.height,
        base64: raw.base64,
      } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromBackendError<T>("snapshot", e);
    }
  }

  private async doClick<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const x = typeof params.x === "number" ? params.x : undefined;
    const y = typeof params.y === "number" ? params.y : undefined;
    if (x === undefined || y === undefined) {
      return err({
        transport: "visual",
        step: 0,
        action: "visual_click",
        reason: "visual_click requires numeric params.x and params.y",
        suggestion: "pass { x, y } coordinates in pixel space",
        exit_code: exitCodeFor("usage_error"),
      });
    }
    const button =
      params.button === "right" ? ("right" as const) : ("left" as const);
    try {
      await this.requireCancellableBackend().click(x, y, button, signal);
      return ok({ x, y, button } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromBackendError<T>("click", e);
    }
  }

  private async doType<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const text = typeof params.text === "string" ? params.text : undefined;
    if (text === undefined) {
      return err({
        transport: "visual",
        step: 0,
        action: "visual_type",
        reason: "visual_type requires params.text (string)",
        suggestion: "pass the literal text to type",
        exit_code: exitCodeFor("usage_error"),
      });
    }
    try {
      await this.requireCancellableBackend().type(text, signal);
      return ok({ text } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromBackendError<T>("type", e);
    }
  }

  private async doKey<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const key =
      typeof params.key === "string"
        ? params.key
        : typeof params.combo === "string"
          ? params.combo
          : undefined;
    if (!key) {
      return err({
        transport: "visual",
        step: 0,
        action: "visual_key",
        reason: "visual_key requires params.key or params.combo (string)",
        suggestion: 'pass a named key, e.g. "Return", "cmd+a"',
        exit_code: exitCodeFor("usage_error"),
      });
    }
    try {
      await this.requireCancellableBackend().key(key, signal);
      return ok({ key } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromBackendError<T>("key", e);
    }
  }

  private async doScroll<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const dx = typeof params.dx === "number" ? params.dx : 0;
    const dy = typeof params.dy === "number" ? params.dy : 0;
    try {
      await this.requireCancellableBackend().scroll(dx, dy, signal);
      return ok({ dx, dy } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromBackendError<T>("scroll", e);
    }
  }

  private async doDrag<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const fromX = typeof params.fromX === "number" ? params.fromX : undefined;
    const fromY = typeof params.fromY === "number" ? params.fromY : undefined;
    const toX = typeof params.toX === "number" ? params.toX : undefined;
    const toY = typeof params.toY === "number" ? params.toY : undefined;
    if (
      fromX === undefined ||
      fromY === undefined ||
      toX === undefined ||
      toY === undefined
    ) {
      return err({
        transport: "visual",
        step: 0,
        action: "visual_drag",
        reason: "visual_drag requires params.fromX/fromY/toX/toY numbers",
        suggestion: "pass all four drag endpoints as numeric pixel coords",
        exit_code: exitCodeFor("usage_error"),
      });
    }
    try {
      await this.requireCancellableBackend().drag(
        fromX,
        fromY,
        toX,
        toY,
        signal,
      );
      return ok({ fromX, fromY, toX, toY } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromBackendError<T>("drag", e);
    }
  }

  private async doWait<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const ms =
      typeof params.ms === "number"
        ? params.ms
        : typeof params.seconds === "number"
          ? params.seconds * 1000
          : 0;
    try {
      await this.requireCancellableBackend().wait(Math.max(0, ms), signal);
      return ok({ ms } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromBackendError<T>("wait", e);
    }
  }

  private async doAssert<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const predicate =
      typeof params.predicate === "string" ? params.predicate : undefined;
    if (!predicate) {
      return err({
        transport: "visual",
        step: 0,
        action: "visual_assert",
        reason: "visual_assert requires params.predicate (string)",
        suggestion: "pass a natural-language predicate for the visual backend",
        exit_code: exitCodeFor("usage_error"),
      });
    }
    try {
      const backend = this.requireCancellableBackend();
      if (!backend.ask) {
        return err({
          transport: "visual",
          step: 0,
          action: "visual_assert",
          reason: `backend ${this.backend.name} does not implement ask()`,
          suggestion: "configure a visual backend with ask() support",
          minimum_capability: "visual.assert",
          exit_code: exitCodeFor("service_unavailable"),
        });
      }
      const answer = await backend.ask(
        `Does the screen satisfy: ${predicate}?`,
        signal,
      );
      const truthy = /^(y|yes|true|1)$/i.test(answer.trim());
      if (!truthy) {
        return err({
          transport: "visual",
          step: 0,
          action: "visual_assert",
          reason: `visual backend did not confirm predicate "${predicate}" (got ${answer})`,
          suggestion: "inspect the latest snapshot or refine the predicate",
          retryable: true,
        });
      }
      return ok({ predicate, answer } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromBackendError<T>("assert", e);
    }
  }

  private async doAsk<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const question =
      typeof params.question === "string" ? params.question : undefined;
    if (!question) {
      return err({
        transport: "visual",
        step: 0,
        action: "visual_ask",
        reason: "visual_ask requires params.question (string)",
        suggestion: "pass a natural-language question for the visual backend",
        exit_code: exitCodeFor("usage_error"),
      });
    }
    const backend = this.requireCancellableBackend();
    if (!backend.ask) {
      return err({
        transport: "visual",
        step: 0,
        action: "visual_ask",
        reason: `backend ${this.backend.name} does not implement ask()`,
        suggestion: "configure a backend with ask() support",
        minimum_capability: "visual.ask",
        exit_code: exitCodeFor("service_unavailable"),
      });
    }
    try {
      const answer = await backend.ask(question, signal);
      return ok({ question, answer } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromBackendError<T>("ask", e);
    }
  }

  private async doBackendInfo<T>(): Promise<Envelope<T>> {
    return ok({ backend: this.backend.name } as unknown as T);
  }

  private async doLaunch<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const app = typeof params.app === "string" ? params.app : undefined;
    if (!app) {
      return err({
        transport: "visual",
        step: 0,
        action: "visual_launch",
        reason: "visual_launch requires params.app (string)",
        suggestion: "pass the app name to launch",
        exit_code: exitCodeFor("usage_error"),
      });
    }
    const backend = this.requireCancellableBackend();
    if (!backend.launch) {
      return err({
        transport: "visual",
        step: 0,
        action: "visual_launch",
        reason: `backend ${this.backend.name} does not support launch()`,
        suggestion: "use a native desktop transport for local app launch",
        minimum_capability: "visual.launch",
        exit_code: exitCodeFor("service_unavailable"),
      });
    }
    try {
      await backend.launch(app, signal);
      return ok({ app } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromBackendError<T>("launch", e);
    }
  }
}

async function waitForVisualDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(
        signal?.reason ?? new DOMException("Visual wait aborted", "AbortError"),
      );
    };
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
