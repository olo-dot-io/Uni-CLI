/**
 * DesktopAtspiTransport — Linux AT-SPI transport stub.
 *
 * v0.214 ships this adapter as a declared-but-unimplemented transport.
 * Registering it with the bus makes capability queries honest (agents
 * can see that `atspi_activate` exists on linux) without pretending the
 * bodies work. Every call returns a structured `service_unavailable`
 * envelope whose `minimum_capability` tells the self-repair loop what
 * to build next.
 *
 * Design contract:
 *  - `open()` NEVER throws
 *  - `action()` always returns an `ok:false` envelope with `exit_code: 69`
 *  - `minimum_capability: "desktop-atspi.<verb>"` so agents can route
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

const ATSPI_STEPS = [
  "atspi_activate",
  "ax_focus",
  "focus_window",
  "launch_app",
  "clipboard_read",
  "clipboard_write",
] as const;

const ATSPI_CAPABILITY: Capability = {
  steps: ATSPI_STEPS,
  snapshotFormats: ["os-ax"] as readonly SnapshotFormat[],
  platforms: ["linux"] as const,
  mutatesHost: true,
};

const NOT_IMPLEMENTED_REASON =
  "Linux AT-SPI transport is a declared stub in v0.214";
const CONTRIBUTE_HINT =
  "Contribute a PR — see contributing/transport.md for the AT-SPI backend recipe";

export class DesktopAtspiTransport implements TransportAdapter {
  readonly kind: TransportKind = "desktop-atspi";
  readonly capability: Capability = ATSPI_CAPABILITY;

  async open(_ctx: TransportContext): Promise<void> {
    // Accept the context so capability queries route through the bus, but
    // don't spawn anything — we can't even attempt AT-SPI without a backend.
  }

  async snapshot(_opts?: { format?: SnapshotFormat }): Promise<Snapshot> {
    return {
      format: "json",
      data: JSON.stringify({
        transport: "desktop-atspi",
        ok: false,
        reason: NOT_IMPLEMENTED_REASON,
      }),
    };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    return err({
      transport: "desktop-atspi",
      step: 0,
      action: req.kind,
      reason: NOT_IMPLEMENTED_REASON,
      suggestion: CONTRIBUTE_HINT,
      minimum_capability: `desktop-atspi.${req.kind === "open" ? "open" : req.kind}`,
      exit_code: exitCodeFor("service_unavailable"),
    });
  }

  async close(): Promise<void> {
    // Idempotent no-op — nothing to release.
  }
}
