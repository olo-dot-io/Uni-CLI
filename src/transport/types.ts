/**
 * Transport types — the v0.212 "operate anything" contract.
 * @owner       src::transport::types
 * @does        Define transport capabilities, action/snapshot requests, shared context, adapters, and the transport bus.
 * @needs       core envelope, ref store, snapshot encoding.
 * @feeds       transport adapters, task-directed routing, engine compute steps, plugins.
 * @breaks      Compile-time mismatch in transport implementations or callers, or coercing cancellation/ambiguous delivery into an ordinary failure envelope.
 * @invariants  Request cancellation and immutable target params are available to snapshot boundaries; ordinary failures return envelopes, while cancellation and outcome ambiguity remain typed control-flow throws; cleanup remains unconditional and idempotent.
 * @side-effects none
 * @perf        Type-only declarations.
 * @concurrency AbortSignal belongs to one request and must not be replaced by process-global state.
 * @test        npm run typecheck and transport unit suites
 * @stability   stable
 * @since       2026-06-29
 *
 * A `TransportAdapter` is a physical execution channel (HTTP, Chrome CDP,
 * subprocess, macOS AX, Windows UIA, Linux AT-SPI, an explicit OS driver, or
 * screenshot-based Visual) behind a uniform 5-method interface:
 * open / snapshot / action / stream / close.
 *
 * Design contract:
 *  - `action()` returns ordinary failures as an `ActionResult.error` envelope.
 *    The owning task planner decides whether to repair or explicitly replan;
 *    transports never select another provider. Exact cancellation and
 *    outcome-ambiguous delivery throw because replay would be unsafe.
 *  - `Capability.steps` is the single source of truth for pipeline-step
 *    dispatch; the runner validates at parse time, not at execution time.
 *  - `minimum_capability` in an error envelope drives the self-repair loop:
 *    an agent sees "needs `desktop-ax.element_by_role`" and picks the
 *    matching transport/step to fix.
 */

import type { Envelope } from "../core/envelope.js";
import type { RefStore } from "./refs.js";
import type { SnapshotEncoding } from "./snapshot-encoder.js";

/**
 * The built-in transports that together cover the full "operate anything"
 * surface. A transport is a physical execution channel; a strategy (auth
 * path) is orthogonal and lives on the adapter, not here.
 */
export type TransportKind =
  | "http"
  | "cdp-browser"
  | "subprocess"
  | "desktop-ax"
  | "desktop-uia"
  | "desktop-atspi"
  | "cua-driver"
  | "visual";

/**
 * The snapshot encodings a transport may return. A single transport can
 * support more than one format (e.g. cdp-browser returns `dom-ax` natively
 * and `screenshot` via CDP Page.captureScreenshot).
 */
export type SnapshotFormat =
  | "dom-ax"
  | "os-ax"
  | "screenshot"
  | "text"
  | "json";

/** Uniform snapshot shape returned by {@link TransportAdapter.snapshot}. */
export interface Snapshot {
  format: SnapshotFormat;
  encoding?: SnapshotEncoding;
  data: string | Buffer;
  width?: number;
  height?: number;
  scaleX?: number;
  scaleY?: number;
  url?: string;
  title?: string;
  refs?: Record<string, unknown>;
}

/** Target-aware perception request shared by every transport snapshot. */
export interface SnapshotRequest {
  format?: SnapshotFormat | SnapshotEncoding;
  fresh?: boolean;
  signal?: AbortSignal;
  /**
   * Immutable target and snapshot arguments from the owning action request.
   * Transports must ignore fields they do not understand, never substitute a
   * different target.
   */
  params?: Readonly<Record<string, unknown>>;
}

/** Single typed request sent to {@link TransportAdapter.action}. */
export interface ActionRequest {
  /** Pipeline step name, e.g. `"click"`, `"fetch"`, `"exec"`. */
  kind: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Canonical command-contract projection. `true` may conservatively elevate
   * an action, while `false` must never downgrade a physically mutating
   * action detected by the transport.
   */
  canMutate?: boolean;
}

/**
 * Uniform ordinary action result. Success returns `ok:true` + `data`; failure
 * returns `ok:false` + `error` envelope. Cancellation and outcome ambiguity
 * remain typed throws outside this union.
 *
 * Aliased to {@link Envelope} so the core envelope helpers (`ok()`, `err()`)
 * work directly with transport return values.
 */
export type ActionResult<T = unknown> = Envelope<T>;

/**
 * Declarative capability descriptor for a transport.
 *
 * `steps` lists the pipeline step names this transport can execute;
 * the YAML runner validates against this at parse time, not at
 * execution time. `platforms` gates OS-specific transports.
 */
export interface Capability {
  readonly steps: readonly string[];
  readonly snapshotFormats: readonly SnapshotFormat[];
  readonly platforms?: readonly ("darwin" | "win32" | "linux")[];
  /**
   * `true` when calling this transport's `action()` has side-effects on
   * the user's host (file writes, clicks, keystrokes).
   */
  readonly mutatesHost: boolean;
}

/**
 * Observability stream for long-running transports.
 *
 *  - subprocess: stdout / stderr chunks
 *  - cdp-browser: raw CDP events
 *  - desktop-ax / uia / atspi: platform accessibility events
 *  - visual: VLM trace (model, tokens, reasoning)
 */
export interface TransportEvent {
  ts: number;
  kind: "stdout" | "stderr" | "cdp" | "ax-event" | "uia-event" | "visual-trace";
  payload: unknown;
}

/**
 * Dispatcher surface injected into every transport. Cross-provider work must
 * arrive as an explicit task route; a transport must not delegate to a broader
 * provider after failure.
 */
export interface TransportBus {
  refs: RefStore;
  register(adapter: TransportAdapter): void;
  get(kind: TransportKind): TransportAdapter;
  /**
   * Look up the transport that can execute `step` on the given
   * `platform`. Throws a typed error with the envelope shape when no
   * transport matches — the self-repair suggestion is embedded so agents
   * can read `error.minimum_capability` to decide which transport to add
   * or repair.
   */
  require(step: string, platform?: NodeJS.Platform): TransportAdapter;
  /** Enumerate every registered transport. */
  list(): TransportAdapter[];
}

/**
 * Shared state handed to each transport at `open()` time. The bus field
 * allows cross-transport delegation; `vars` is the mutable pipeline
 * variable table.
 */
export interface TransportContext {
  site?: string;
  adapterPath?: string;
  cwd?: string;
  env?: Record<string, string>;
  cookieHeader?: string;
  vars: Record<string, unknown>;
  signal?: AbortSignal;
  bus: TransportBus;
  refs?: RefStore;
}

/**
 * The core interface every transport implements.
 *
 *   open()     — acquire resources (Chrome spawn, CDP attach, AX session,
 *                subprocess shell).
 *   snapshot() — perception. Always returns a uniform {@link Snapshot}
 *                even across transports (screenshot vs AX tree vs DOM).
 *   action()   — execute one pipeline step; ordinary failures are envelopes,
 *                cancellation and ambiguous delivery are typed throws.
 *   stream()   — optional async iterable of {@link TransportEvent}.
 *   close()    — release resources. Must be idempotent.
 */
export interface TransportAdapter {
  readonly kind: TransportKind;
  readonly capability: Capability;

  open(ctx: TransportContext): Promise<void>;

  snapshot(opts?: SnapshotRequest): Promise<Snapshot>;

  action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>>;

  /**
   * Retire provider-local stale state before a bounded retry. The dispatcher
   * calls this only for the already selected provider and physical action.
   */
  recover?(
    req: ActionRequest,
    failure: unknown,
    ctx: TransportContext,
  ): Promise<void>;

  stream?(filter?: { kinds?: string[] }): AsyncIterable<TransportEvent>;

  close(): Promise<void>;
}
