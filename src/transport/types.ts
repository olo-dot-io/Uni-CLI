/**
 * Transport types — the v0.212 "operate anything" contract.
 *
 * A `TransportAdapter` is a physical execution channel (HTTP, Chrome CDP,
 * subprocess, macOS AX, Windows UIA, Linux AT-SPI, screenshot-based CUA)
 * behind a uniform 5-method interface: open / snapshot / action / stream /
 * close.
 *
 * Design contract:
 *  - `action()` NEVER throws — all failures become an `ActionResult.error`
 *    envelope so the YAML runner can sequence fallbacks without try/catch.
 *  - `Capability.steps` is the single source of truth for pipeline-step
 *    dispatch; the runner validates at parse time, not at execution time.
 *  - `minimum_capability` in an error envelope drives the self-repair loop:
 *    an agent sees "needs `desktop-ax.element_by_role`" and picks the
 *    matching transport/step to fix.
 */

import type { Envelope } from "../core/envelope.js";

/**
 * The seven transports that together cover the full "operate anything"
 * surface. A transport is a physical execution channel; a strategy
 * (auth path) is orthogonal and lives on the adapter, not here.
 */
export type TransportKind =
  | "http"
  | "cdp-browser"
  | "subprocess"
  | "desktop-ax"
  | "desktop-uia"
  | "desktop-atspi"
  | "cua";

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
  data: string | Buffer;
  width?: number;
  height?: number;
  scaleX?: number;
  scaleY?: number;
  url?: string;
  title?: string;
  refs?: Record<string, unknown>;
}

/** Single typed request sent to {@link TransportAdapter.action}. */
export interface ActionRequest {
  /** Pipeline step name, e.g. `"click"`, `"fetch"`, `"exec"`. */
  kind: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Uniform action result. Success returns `ok:true` + `data`; failure
 * returns `ok:false` + `error` envelope. Never throws.
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
 *  - cua: VLM trace (model, tokens, reasoning)
 */
export interface TransportEvent {
  ts: number;
  kind: "stdout" | "stderr" | "cdp" | "ax-event" | "uia-event" | "cua-trace";
  payload: unknown;
}

/**
 * Dispatcher surface injected into every transport so transports can
 * compose (e.g. `cdp-browser` delegates `snapshot(format:"screenshot")`
 * to `cua` on non-trivial perception tasks).
 */
export interface TransportBus {
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
}

/**
 * The core interface every transport implements.
 *
 *   open()     — acquire resources (Chrome spawn, CDP attach, AX session,
 *                subprocess shell).
 *   snapshot() — perception. Always returns a uniform {@link Snapshot}
 *                even across transports (screenshot vs AX tree vs DOM).
 *   action()   — execute one pipeline step. NEVER throws.
 *   stream()   — optional async iterable of {@link TransportEvent}.
 *   close()    — release resources. Must be idempotent.
 */
export interface TransportAdapter {
  readonly kind: TransportKind;
  readonly capability: Capability;

  open(ctx: TransportContext): Promise<void>;

  snapshot(opts?: {
    format?: SnapshotFormat;
    fresh?: boolean;
  }): Promise<Snapshot>;

  action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>>;

  stream?(filter?: { kinds?: string[] }): AsyncIterable<TransportEvent>;

  close(): Promise<void>;
}
