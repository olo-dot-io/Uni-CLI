/**
 * DesktopUiaTransport — Windows UI Automation (UIA) transport stub.
 *
 * v0.214 ships this adapter as a declared-but-unimplemented transport.
 * Registering it with the bus makes capability queries honest (agents
 * can see that `uia_invoke` / `uia_get_pattern` exist on win32) without
 * pretending the bodies work. Every call returns a structured
 * `service_unavailable` envelope whose `minimum_capability` tells the
 * self-repair loop what to build next.
 *
 * Design contract:
 *  - `open()` NEVER throws
 *  - `action()` always returns an `ok:false` envelope with `exit_code: 69`
 *  - `minimum_capability: "desktop-uia.<verb>"` so agents can route
 */

import { err, exitCodeFor } from "../../core/envelope.js";
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

const UIA_STEPS = [
  "uia_invoke",
  "uia_get_pattern",
  "ax_focus",
  "focus_window",
  "launch_app",
  "clipboard_read",
  "clipboard_write",
] as const;

const UIA_CAPABILITY: Capability = {
  steps: UIA_STEPS,
  snapshotFormats: ["os-ax"] as readonly SnapshotFormat[],
  platforms: ["win32"] as const,
  mutatesHost: true,
};

const NOT_IMPLEMENTED_REASON =
  "Windows UIA transport is a declared stub in v0.214";
const CONTRIBUTE_HINT =
  "Contribute a PR — see contributing/transport.md for the UIA backend recipe";

export class DesktopUiaTransport implements TransportAdapter {
  readonly kind: TransportKind = "desktop-uia";
  readonly capability: Capability = UIA_CAPABILITY;

  async open(_ctx: TransportContext): Promise<void> {
    // Accept the context so capability queries route through the bus, but
    // don't spawn anything — we can't even attempt UIA without a backend.
  }

  async snapshot(_opts?: { format?: SnapshotFormat }): Promise<Snapshot> {
    return {
      format: "json",
      data: JSON.stringify({
        transport: "desktop-uia",
        ok: false,
        reason: NOT_IMPLEMENTED_REASON,
      }),
    };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    return err({
      transport: "desktop-uia",
      step: 0,
      action: req.kind,
      reason: NOT_IMPLEMENTED_REASON,
      suggestion: CONTRIBUTE_HINT,
      minimum_capability: `desktop-uia.${req.kind === "open" ? "open" : req.kind}`,
      exit_code: exitCodeFor("service_unavailable"),
    });
  }

  async close(): Promise<void> {
    // Idempotent no-op — nothing to release.
  }
}
