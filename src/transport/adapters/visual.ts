/**
 * @owner   src/transport/adapters/visual.ts
 * @does    Provide Uni-CLI's screenshot-plus-model visual fallback transport behind the transport bus.
 * @needs   core/envelope, transport/types
 * @feeds   src/transport/bus.ts, src/engine/steps/visual.ts, compute cascade visual fallback
 * @breaks  Throws no public errors; backend failures become structured envelopes.
 * @invariants Backend selection is deterministic from env; action() never throws.
 * @side-effects May click, type, scroll, drag, or launch through a configured backend.
 * @perf    Screenshot payload size dominates memory use.
 * @concurrency Backend implementations own their own synchronization.
 * @test    tests/unit/transport/adapters/visual.test.ts
 * @stability beta
 * @since   0.222.0
 */

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
  TransportKind,
} from "../types.js";

export interface VisualBackend {
  readonly name: VisualBackendName;
  snapshot(): Promise<{
    base64: string;
    width: number;
    height: number;
    mime?: string;
  }>;
  click(x: number, y: number, button?: "left" | "right"): Promise<void>;
  type(text: string): Promise<void>;
  key(key: string): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
  wait(ms: number): Promise<void>;
  ask?(question: string): Promise<string>;
  launch?(app: string): Promise<void>;
}

export type VisualBackendName = "mock" | "remote";

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

const MOCK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

export class MockBackend implements VisualBackend {
  readonly name: VisualBackendName = "mock";
  readonly history: Array<{ verb: string; args: unknown[] }> = [];

  private record(verb: string, ...args: unknown[]): void {
    this.history.push({ verb, args });
  }

  async snapshot(): Promise<{
    base64: string;
    width: number;
    height: number;
    mime: string;
  }> {
    this.record("snapshot");
    return { base64: MOCK_PNG_BASE64, width: 1, height: 1, mime: "image/png" };
  }

  async click(
    x: number,
    y: number,
    button: "left" | "right" = "left",
  ): Promise<void> {
    this.record("click", x, y, button);
  }

  async type(text: string): Promise<void> {
    this.record("type", text);
  }

  async key(key: string): Promise<void> {
    this.record("key", key);
  }

  async scroll(dx: number, dy: number): Promise<void> {
    this.record("scroll", dx, dy);
  }

  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): Promise<void> {
    this.record("drag", fromX, fromY, toX, toY);
  }

  async wait(ms: number): Promise<void> {
    this.record("wait", ms);
  }

  async ask(question: string): Promise<string> {
    this.record("ask", question);
    return "yes";
  }

  async launch(app: string): Promise<void> {
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

export class RemoteVisualBackend implements VisualBackend {
  readonly name: VisualBackendName = "remote";

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

  async snapshot(): Promise<{ base64: string; width: number; height: number }> {
    this.notReady("snapshot");
  }
  async click(): Promise<void> {
    this.notReady("click");
  }
  async type(): Promise<void> {
    this.notReady("type");
  }
  async key(): Promise<void> {
    this.notReady("key");
  }
  async scroll(): Promise<void> {
    this.notReady("scroll");
  }
  async drag(): Promise<void> {
    this.notReady("drag");
  }
  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
  async ask(): Promise<string> {
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
  const requested = (env.VISUAL_BACKEND ?? "").toLowerCase();
  if (requested === "remote" && env.VISUAL_BACKEND_ENDPOINT) {
    return new RemoteVisualBackend(
      env.VISUAL_BACKEND_ENDPOINT,
      env.VISUAL_BACKEND_API_KEY,
    );
  }
  return new MockBackend();
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
  }

  async open(_ctx: TransportContext): Promise<void> {}

  async snapshot(opts?: { format?: SnapshotFormat }): Promise<Snapshot> {
    const format = opts?.format ?? "screenshot";
    if (this.lastSnapshot && format === this.lastSnapshot.format) {
      return this.lastSnapshot;
    }
    try {
      const raw = await this.backend.snapshot();
      const snap: Snapshot = {
        format: "screenshot",
        data: Buffer.from(raw.base64, "base64"),
        width: raw.width,
        height: raw.height,
      };
      this.lastSnapshot = snap;
      return snap;
    } catch {
      return { format: "json", data: JSON.stringify({ ok: false }) };
    }
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    const start = Date.now();
    try {
      const envelope = await this.dispatch<T>(req);
      envelope.elapsedMs = Date.now() - start;
      return envelope;
    } catch (e) {
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
        return this.doSnapshot<T>();
      case "visual_click":
        return this.doClick<T>(req.params);
      case "visual_type":
        return this.doType<T>(req.params);
      case "visual_key":
        return this.doKey<T>(req.params);
      case "visual_scroll":
        return this.doScroll<T>(req.params);
      case "visual_drag":
        return this.doDrag<T>(req.params);
      case "visual_wait":
        return this.doWait<T>(req.params);
      case "visual_assert":
        return this.doAssert<T>(req.params);
      case "visual_ask":
        return this.doAsk<T>(req.params);
      case "visual_backend":
        return this.doBackendInfo<T>();
      case "visual_launch":
        return this.doLaunch<T>(req.params);
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
    const notReady = e instanceof BackendNotReadyError;
    return err({
      transport: "visual",
      step: 0,
      action: verb,
      reason: msg,
      suggestion: notReady
        ? `configure the \`${this.backend.name}\` visual backend before calling visual.${verb}`
        : "inspect backend error and retry",
      minimum_capability: `visual.${verb}`,
      retryable: !notReady,
      exit_code: notReady
        ? exitCodeFor("config_error")
        : exitCodeFor("service_unavailable"),
    });
  }

  private async doSnapshot<T>(): Promise<Envelope<T>> {
    try {
      const raw = await this.backend.snapshot();
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
      return this.envelopeFromBackendError<T>("snapshot", e);
    }
  }

  private async doClick<T>(
    params: Record<string, unknown>,
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
      await this.backend.click(x, y, button);
      return ok({ x, y, button } as unknown as T);
    } catch (e) {
      return this.envelopeFromBackendError<T>("click", e);
    }
  }

  private async doType<T>(
    params: Record<string, unknown>,
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
      await this.backend.type(text);
      return ok({ text } as unknown as T);
    } catch (e) {
      return this.envelopeFromBackendError<T>("type", e);
    }
  }

  private async doKey<T>(
    params: Record<string, unknown>,
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
      await this.backend.key(key);
      return ok({ key } as unknown as T);
    } catch (e) {
      return this.envelopeFromBackendError<T>("key", e);
    }
  }

  private async doScroll<T>(
    params: Record<string, unknown>,
  ): Promise<Envelope<T>> {
    const dx = typeof params.dx === "number" ? params.dx : 0;
    const dy = typeof params.dy === "number" ? params.dy : 0;
    try {
      await this.backend.scroll(dx, dy);
      return ok({ dx, dy } as unknown as T);
    } catch (e) {
      return this.envelopeFromBackendError<T>("scroll", e);
    }
  }

  private async doDrag<T>(
    params: Record<string, unknown>,
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
      await this.backend.drag(fromX, fromY, toX, toY);
      return ok({ fromX, fromY, toX, toY } as unknown as T);
    } catch (e) {
      return this.envelopeFromBackendError<T>("drag", e);
    }
  }

  private async doWait<T>(
    params: Record<string, unknown>,
  ): Promise<Envelope<T>> {
    const ms =
      typeof params.ms === "number"
        ? params.ms
        : typeof params.seconds === "number"
          ? params.seconds * 1000
          : 0;
    try {
      await this.backend.wait(Math.max(0, ms));
      return ok({ ms } as unknown as T);
    } catch (e) {
      return this.envelopeFromBackendError<T>("wait", e);
    }
  }

  private async doAssert<T>(
    params: Record<string, unknown>,
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
      const answer = this.backend.ask
        ? await this.backend.ask(`Does the screen satisfy: ${predicate}?`)
        : "yes";
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
      return this.envelopeFromBackendError<T>("assert", e);
    }
  }

  private async doAsk<T>(
    params: Record<string, unknown>,
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
    if (!this.backend.ask) {
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
      const answer = await this.backend.ask(question);
      return ok({ question, answer } as unknown as T);
    } catch (e) {
      return this.envelopeFromBackendError<T>("ask", e);
    }
  }

  private async doBackendInfo<T>(): Promise<Envelope<T>> {
    return ok({ backend: this.backend.name } as unknown as T);
  }

  private async doLaunch<T>(
    params: Record<string, unknown>,
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
    if (!this.backend.launch) {
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
      await this.backend.launch(app);
      return ok({ app } as unknown as T);
    } catch (e) {
      return this.envelopeFromBackendError<T>("launch", e);
    }
  }
}
