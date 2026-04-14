/**
 * Transport types — the v0.212 "operate anything" contract.
 *
 * Phase 1.1 lands the two types needed by the core envelope + registry
 * (`TransportKind`, `Capability`). Phase 1.2 expands this file with the
 * full `TransportAdapter` interface, `Snapshot`, `ActionRequest`,
 * `ActionResult`, `TransportBus`, `TransportContext`, `TransportEvent`.
 */

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
 * Declarative capability descriptor for a transport.
 *
 * `steps` lists the pipeline step names this transport can execute;
 * the YAML runner validates against this at parse time, not at
 * execution time. `platforms` gates OS-specific transports.
 */
export interface Capability {
  readonly steps: readonly string[];
  readonly snapshotFormats: readonly string[];
  readonly platforms?: readonly ("darwin" | "win32" | "linux")[];
  /**
   * `true` when calling this transport's `action()` has side-effects on
   * the user's host (file writes, clicks, keystrokes).
   */
  readonly mutatesHost: boolean;
}
