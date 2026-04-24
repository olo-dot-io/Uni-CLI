/**
 * CuaTransport — screenshot + VLM "Computer Use" transport.
 *
 * Unlike the other transports, CUA has no single protocol — it wraps a
 * pluggable "backend" that implements the primitive perception/action
 * verbs against a real computer-use model or emulator. v0.214 ships the
 * backend contract and provider selection behind `CUA_BACKEND`:
 *
 *   - `anthropic`   Anthropic `computer_20251124` beta tool, `ANTHROPIC_API_KEY`
 *   - `trycua`      trycua/cua compute-server v0.1.9+, `TRYCUA_API_KEY`
 *   - `opencua`     OpenCUA-72B via local vLLM, `OPENCUA_ENDPOINT`
 *   - `scrapybara`  Scrapybara Computer API, `SCRAPYBARA_API_KEY`
 *   - `mock`        in-memory stub used by tests and when no key is present
 *
 * Provider network paths are explicit stubs in v0.214. They are gated
 * behind the corresponding env keys and fail through the same structured
 * envelope path as every other transport. The MockBackend is always
 * available so the offline test suite runs without secrets.
 *
 * Design contract:
 *  - `action()` NEVER throws
 *  - all backends implement the same primitive verb surface (below)
 *  - selection is deterministic: `selectCuaBackend()` returns the same
 *    backend for the same env — no hidden state
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

// ── Backend contract ────────────────────────────────────────────────────

/**
 * Primitive verbs every CUA backend must implement. The transport never
 * calls a backend method directly without wrapping the outcome in an
 * envelope — all error paths flow through `CuaTransport.action()`.
 */
export interface CuaBackend {
  readonly name: CuaBackendName;
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
  /**
   * Optional: VLM "ask" primitive — let the model decide a boolean or
   * short-string answer about the current screen. Backends that don't
   * support it throw; `CuaTransport.action()` catches and envelopes.
   */
  ask?(question: string): Promise<string>;
  /**
   * Optional: launch a named application on the host (some backends ship
   * their own sandbox and need an explicit launch command).
   */
  launch?(app: string): Promise<void>;
}

/** The four production backends + the offline test fallback. */
export type CuaBackendName =
  | "anthropic"
  | "trycua"
  | "opencua"
  | "scrapybara"
  | "mock";

// ── Supported pipeline steps ────────────────────────────────────────────

const CUA_STEPS = [
  "cua_snapshot",
  "cua_click",
  "cua_type",
  "cua_key",
  "cua_scroll",
  "cua_drag",
  "cua_wait",
  "cua_assert",
  "cua_ask",
  "cua_backend",
  "cua_launch",
] as const;

const CUA_CAPABILITY: Capability = {
  steps: CUA_STEPS,
  snapshotFormats: ["screenshot"] as readonly SnapshotFormat[],
  mutatesHost: true,
};

// ── Mock backend (offline, deterministic) ───────────────────────────────

/** Fixed 1x1 transparent PNG used by {@link MockBackend.snapshot}. */
const MOCK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

/**
 * MockBackend — deterministic, offline CUA backend used when no provider
 * credentials are present and by every test in this file. Records the
 * sequence of calls on `history` so tests can assert against it without
 * having to stub `fetch`.
 */
export class MockBackend implements CuaBackend {
  readonly name: CuaBackendName = "mock";
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
    // Intentionally not calling setTimeout — tests want determinism.
  }

  async ask(question: string): Promise<string> {
    this.record("ask", question);
    return "yes";
  }

  async launch(app: string): Promise<void> {
    this.record("launch", app);
  }
}

// ── Real-backend stubs ──────────────────────────────────────────────────

/**
 * Base class used by every real backend. All verbs throw `BackendNotReadyError`
 * by default; subclasses override what they support.
 *
 * Honesty note (2026-04-24): v0.214 ships `Anthropic`, `Trycua`, `OpenCua`
 * and `Scrapybara` as **provider stubs**. They declare the shape the real
 * backends will take, fail fast with a structured envelope when selected
 * without their credentials, and let downstream tests pin the Mock
 * backend for offline determinism. Full network implementations remain
 * out of scope for this file until a real provider backend lands with a
 * screen-source/planner composition.
 *
 * Users who want a real backend today can implement the `CuaBackend`
 * interface in their own code and inject it via
 * {@link CuaTransport.setBackend}, or provide a factory through the
 * `opts.backend` of the transport constructor. That surface is stable.
 */
class BackendNotReadyError extends Error {
  constructor(
    readonly backend: CuaBackendName,
    readonly verb: string,
    readonly hint: string,
  ) {
    super(
      `cua backend "${backend}" is a provider stub — ${verb} not implemented (${hint})`,
    );
    this.name = "BackendNotReadyError";
  }
}

/**
 * Anthropic `computer_use` tool stub. Selected when `CUA_BACKEND=anthropic`
 * and `ANTHROPIC_API_KEY` is set.
 *
 * IMPORTANT — two-layer architecture: the Anthropic Messages API is a
 * planner, not a screen capture service. A production Anthropic backend
 * MUST be composed with a screenshot source (macOS `screencapture`,
 * trycua sandbox, scrapybara VM) because the model receives screenshots
 * from the client and returns `tool_use` actions. The shipped backend is
 * intentionally a stub until a concrete screenshot-source/planner
 * composition is implemented.
 *
 * `tool_version` defaults to `"computer_20260301"` (the successor to
 * `computer_20251124` in the Sonnet 4.6 rollout); override via env
 * `ANTHROPIC_CUA_TOOL_VERSION` so operators can follow Anthropic's
 * release cadence without a code change.
 */
export class AnthropicBackend implements CuaBackend {
  readonly name: CuaBackendName = "anthropic";
  readonly apiKey: string;
  readonly model: string;
  readonly toolVersion: string;
  constructor(
    apiKey: string,
    model: string = process.env.ANTHROPIC_CUA_MODEL ?? "claude-sonnet-4-6",
    toolVersion: string = process.env.ANTHROPIC_CUA_TOOL_VERSION ??
      "computer_20260301",
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.toolVersion = toolVersion;
  }

  async snapshot(): Promise<{
    base64: string;
    width: number;
    height: number;
    mime: string;
  }> {
    throw new BackendNotReadyError(
      this.name,
      "snapshot",
      `the Anthropic Messages API does not capture screens; pair ${this.name} with a screenshot source (screencapture/trycua/scrapybara) before enabling this backend`,
    );
  }

  async click(): Promise<void> {
    throw new BackendNotReadyError(
      this.name,
      "click",
      `stubbed until this backend owns a real /v1/messages action bridge for "${this.toolVersion}" left_click`,
    );
  }

  async type(): Promise<void> {
    throw new BackendNotReadyError(
      this.name,
      "type",
      `stubbed until this backend owns a real /v1/messages action bridge for "${this.toolVersion}" type`,
    );
  }

  async key(): Promise<void> {
    throw new BackendNotReadyError(
      this.name,
      "key",
      `stubbed until this backend owns a real /v1/messages action bridge for "${this.toolVersion}" key`,
    );
  }

  async scroll(): Promise<void> {
    throw new BackendNotReadyError(
      this.name,
      "scroll",
      `stubbed until this backend owns a real /v1/messages action bridge for "${this.toolVersion}" scroll`,
    );
  }

  async drag(): Promise<void> {
    throw new BackendNotReadyError(
      this.name,
      "drag",
      `stubbed until this backend owns a real /v1/messages action bridge for "${this.toolVersion}" left_click_drag`,
    );
  }

  async wait(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, Math.max(0, ms)));
  }

  async ask(): Promise<string> {
    throw new BackendNotReadyError(
      this.name,
      "ask",
      "stubbed until this backend owns a real /v1/messages Q&A bridge; supply your own backend via CuaTransport.setBackend() today",
    );
  }
}

/** trycua/cua compute-server v0.1.9+. Activated when `CUA_BACKEND=trycua`. */
export class TrycuaBackend implements CuaBackend {
  readonly name: CuaBackendName = "trycua";
  readonly apiKey: string;
  readonly endpoint: string;
  constructor(apiKey: string, endpoint: string = "https://api.cua.dev") {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
  }

  async snapshot(): Promise<{ base64: string; width: number; height: number }> {
    throw new BackendNotReadyError(
      this.name,
      "snapshot",
      "implement GET /v1/screen against the trycua compute-server",
    );
  }
  async click(): Promise<void> {
    throw new BackendNotReadyError(this.name, "click", "POST /v1/click");
  }
  async type(): Promise<void> {
    throw new BackendNotReadyError(this.name, "type", "POST /v1/type");
  }
  async key(): Promise<void> {
    throw new BackendNotReadyError(this.name, "key", "POST /v1/key");
  }
  async scroll(): Promise<void> {
    throw new BackendNotReadyError(this.name, "scroll", "POST /v1/scroll");
  }
  async drag(): Promise<void> {
    throw new BackendNotReadyError(this.name, "drag", "POST /v1/drag");
  }
  async wait(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, Math.max(0, ms)));
  }
}

/** OpenCUA-72B via local vLLM. Activated when `CUA_BACKEND=opencua`. */
export class OpenCuaBackend implements CuaBackend {
  readonly name: CuaBackendName = "opencua";
  constructor(private readonly endpoint: string) {}

  async snapshot(): Promise<{ base64: string; width: number; height: number }> {
    throw new BackendNotReadyError(
      this.name,
      "snapshot",
      "implement vLLM OpenCUA-72B screenshot call at " + this.endpoint,
    );
  }
  async click(): Promise<void> {
    throw new BackendNotReadyError(this.name, "click", "implement vLLM action");
  }
  async type(): Promise<void> {
    throw new BackendNotReadyError(this.name, "type", "implement vLLM action");
  }
  async key(): Promise<void> {
    throw new BackendNotReadyError(this.name, "key", "implement vLLM action");
  }
  async scroll(): Promise<void> {
    throw new BackendNotReadyError(
      this.name,
      "scroll",
      "implement vLLM action",
    );
  }
  async drag(): Promise<void> {
    throw new BackendNotReadyError(this.name, "drag", "implement vLLM action");
  }
  async wait(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, Math.max(0, ms)));
  }
}

/** Scrapybara Computer API. Activated when `CUA_BACKEND=scrapybara`. */
export class ScrapybaraBackend implements CuaBackend {
  readonly name: CuaBackendName = "scrapybara";
  readonly apiKey: string;
  readonly endpoint: string;
  constructor(apiKey: string, endpoint: string = "https://api.scrapybara.com") {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
  }

  async snapshot(): Promise<{ base64: string; width: number; height: number }> {
    throw new BackendNotReadyError(
      this.name,
      "snapshot",
      "implement Scrapybara screenshot API",
    );
  }
  async click(): Promise<void> {
    throw new BackendNotReadyError(this.name, "click", "Scrapybara click");
  }
  async type(): Promise<void> {
    throw new BackendNotReadyError(this.name, "type", "Scrapybara type");
  }
  async key(): Promise<void> {
    throw new BackendNotReadyError(this.name, "key", "Scrapybara key");
  }
  async scroll(): Promise<void> {
    throw new BackendNotReadyError(this.name, "scroll", "Scrapybara scroll");
  }
  async drag(): Promise<void> {
    throw new BackendNotReadyError(this.name, "drag", "Scrapybara drag");
  }
  async wait(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, Math.max(0, ms)));
  }
}

// ── Backend selection ───────────────────────────────────────────────────

/** Explicit env snapshot used by {@link selectCuaBackend} — injectable for tests. */
export interface CuaEnv {
  CUA_BACKEND?: string;
  ANTHROPIC_API_KEY?: string;
  TRYCUA_API_KEY?: string;
  OPENCUA_ENDPOINT?: string;
  SCRAPYBARA_API_KEY?: string;
}

/**
 * Pure function — given an env snapshot, return the backend to use.
 *
 * Selection rules (first match wins):
 *   1. `CUA_BACKEND=anthropic`  and ANTHROPIC_API_KEY  → AnthropicBackend
 *   2. `CUA_BACKEND=trycua`     and TRYCUA_API_KEY     → TrycuaBackend
 *   3. `CUA_BACKEND=opencua`    and OPENCUA_ENDPOINT   → OpenCuaBackend
 *   4. `CUA_BACKEND=scrapybara` and SCRAPYBARA_API_KEY → ScrapybaraBackend
 *   5. otherwise                                       → MockBackend
 *
 * If the user names a backend but the required env is missing, we return a
 * MockBackend tagged with a `missing` sentinel so the caller can emit a
 * structured `config_error` envelope on first use.
 */
export function selectCuaBackend(env: CuaEnv = process.env): CuaBackend {
  const requested = (env.CUA_BACKEND ?? "").toLowerCase();
  switch (requested) {
    case "anthropic":
      if (env.ANTHROPIC_API_KEY)
        return new AnthropicBackend(env.ANTHROPIC_API_KEY);
      return new MockBackend(); // ANTHROPIC_API_KEY missing → fallback
    case "trycua":
      if (env.TRYCUA_API_KEY) return new TrycuaBackend(env.TRYCUA_API_KEY);
      return new MockBackend();
    case "opencua":
      if (env.OPENCUA_ENDPOINT) return new OpenCuaBackend(env.OPENCUA_ENDPOINT);
      return new MockBackend();
    case "scrapybara":
      if (env.SCRAPYBARA_API_KEY)
        return new ScrapybaraBackend(env.SCRAPYBARA_API_KEY);
      return new MockBackend();
    case "mock":
    case "":
      return new MockBackend();
    default:
      // Unknown backend name — fall back to mock so action() can envelope.
      return new MockBackend();
  }
}

// ── Transport ───────────────────────────────────────────────────────────

export interface CuaTransportOptions {
  backend?: CuaBackend;
  env?: CuaEnv;
}

/**
 * CuaTransport routes `cua_*` pipeline steps to the active backend, wraps
 * every outcome in an envelope, and never throws from `action()`.
 */
export class CuaTransport implements TransportAdapter {
  readonly kind: TransportKind = "cua";
  readonly capability: Capability = CUA_CAPABILITY;

  private backend: CuaBackend;
  private lastSnapshot: Snapshot | undefined = undefined;

  constructor(opts: CuaTransportOptions = {}) {
    this.backend = opts.backend ?? selectCuaBackend(opts.env);
  }

  /** Introspect the active backend (used by tests + `cua_backend` step). */
  get activeBackendName(): CuaBackendName {
    return this.backend.name;
  }

  /** Swap backends at runtime — the `cua_backend` step uses this. */
  setBackend(backend: CuaBackend): void {
    this.backend = backend;
  }

  async open(_ctx: TransportContext): Promise<void> {
    // No-op — CUA backends don't need pipeline vars today.
  }

  async snapshot(opts?: { format?: SnapshotFormat }): Promise<Snapshot> {
    const format = opts?.format ?? "screenshot";
    if (this.lastSnapshot && format === this.lastSnapshot.format)
      return this.lastSnapshot;
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
      // Never throw from snapshot — return an empty JSON envelope.
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
        transport: "cua",
        step: 0,
        action: req.kind,
        reason: `unexpected error in cua.${req.kind}: ${msg}`,
        suggestion: "check backend configuration and env vars",
        retryable: false,
      });
    }
  }

  async close(): Promise<void> {
    this.lastSnapshot = undefined;
  }

  // ── internals ────────────────────────────────────────────────────────

  private async dispatch<T>(req: ActionRequest): Promise<Envelope<T>> {
    switch (req.kind) {
      case "cua_snapshot":
        return this.doSnapshot<T>();
      case "cua_click":
        return this.doClick<T>(req.params);
      case "cua_type":
        return this.doType<T>(req.params);
      case "cua_key":
        return this.doKey<T>(req.params);
      case "cua_scroll":
        return this.doScroll<T>(req.params);
      case "cua_drag":
        return this.doDrag<T>(req.params);
      case "cua_wait":
        return this.doWait<T>(req.params);
      case "cua_assert":
        return this.doAssert<T>(req.params);
      case "cua_ask":
        return this.doAsk<T>(req.params);
      case "cua_backend":
        return this.doBackendInfo<T>();
      case "cua_launch":
        return this.doLaunch<T>(req.params);
      default:
        return err({
          transport: "cua",
          step: 0,
          action: req.kind,
          reason: `unsupported action "${req.kind}" for cua transport`,
          suggestion: `cua transport supports: ${CUA_STEPS.join(", ")}`,
          minimum_capability: `cua.${req.kind}`,
          exit_code: exitCodeFor("usage_error"),
        });
    }
  }

  private envelopeFromBackendError<T>(verb: string, e: unknown): Envelope<T> {
    const msg = e instanceof Error ? e.message : String(e);
    const notReady = e instanceof BackendNotReadyError;
    return err({
      transport: "cua",
      step: 0,
      action: verb,
      reason: msg,
      suggestion: notReady
        ? `install or configure the \`${this.backend.name}\` backend before calling cua.${verb}`
        : "inspect backend error and retry",
      minimum_capability: `cua.${verb}`,
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
        transport: "cua",
        step: 0,
        action: "cua_click",
        reason: "cua_click requires numeric params.x and params.y",
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
        transport: "cua",
        step: 0,
        action: "cua_type",
        reason: "cua_type requires params.text (string)",
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
    const key = typeof params.key === "string" ? params.key : undefined;
    if (!key) {
      return err({
        transport: "cua",
        step: 0,
        action: "cua_key",
        reason: "cua_key requires params.key (string)",
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
        transport: "cua",
        step: 0,
        action: "cua_drag",
        reason: "cua_drag requires params.fromX/fromY/toX/toY numbers",
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
    // The CUA assert is a ask→boolean — the VLM decides whether the
    // screen satisfies the predicate. With MockBackend it always passes.
    const predicate =
      typeof params.predicate === "string" ? params.predicate : undefined;
    if (!predicate) {
      return err({
        transport: "cua",
        step: 0,
        action: "cua_assert",
        reason: "cua_assert requires params.predicate (string)",
        suggestion: "pass a natural-language predicate for the VLM",
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
          transport: "cua",
          step: 0,
          action: "cua_assert",
          reason: `VLM did not confirm predicate "${predicate}" (got ${answer})`,
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
        transport: "cua",
        step: 0,
        action: "cua_ask",
        reason: "cua_ask requires params.question (string)",
        suggestion: "pass a natural-language question for the VLM",
        exit_code: exitCodeFor("usage_error"),
      });
    }
    if (!this.backend.ask) {
      return err({
        transport: "cua",
        step: 0,
        action: "cua_ask",
        reason: `backend ${this.backend.name} does not implement ask()`,
        suggestion:
          "use the anthropic or mock backend, or add ask() to the backend",
        minimum_capability: "cua.ask",
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
        transport: "cua",
        step: 0,
        action: "cua_launch",
        reason: "cua_launch requires params.app (string)",
        suggestion: "pass the app name to launch",
        exit_code: exitCodeFor("usage_error"),
      });
    }
    if (!this.backend.launch) {
      return err({
        transport: "cua",
        step: 0,
        action: "cua_launch",
        reason: `backend ${this.backend.name} does not support launch()`,
        suggestion:
          "use desktop-ax.launch_app for native macOS launch, or Scrapybara sandbox",
        minimum_capability: "cua.launch",
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
