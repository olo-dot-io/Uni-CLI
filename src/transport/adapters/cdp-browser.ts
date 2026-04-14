/**
 * CdpBrowserTransport — wraps the existing `BrowserPage` (an IPage impl)
 * behind the TransportAdapter interface.
 *
 * The underlying `src/browser/page.ts` continues to serve the legacy
 * yaml-runner paths; this wrapper exposes the same methods through the
 * uniform envelope contract so the new bus-driven dispatch routes
 * browser steps without duplicating the CDP client logic.
 *
 * Page acquisition is pluggable via the constructor `pageFactory` for
 * testability. The default factory mirrors the yaml-runner strategy:
 * try an already-running browser on CDP port, else auto-launch.
 */

import { err, exitCodeFor, ok } from "../../core/envelope.js";
import type { Envelope } from "../../core/envelope.js";
import type { IPage } from "../../types.js";
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

const CDP_STEPS = [
  "navigate",
  "evaluate",
  "click",
  "type",
  "press",
  "scroll",
  "wait",
  "snapshot",
  "screenshot",
] as const;

const CDP_CAPABILITY: Capability = {
  steps: CDP_STEPS,
  snapshotFormats: ["dom-ax", "screenshot"] as readonly SnapshotFormat[],
  mutatesHost: true,
};

export interface CdpBrowserTransportOptions {
  /**
   * Optional factory for an `IPage`. When omitted, the transport defers
   * page acquisition to the existing launcher bridge in
   * `src/browser/page.ts`. Tests inject a mock here.
   */
  pageFactory?: () => Promise<IPage>;
}

/** Default factory — connect or auto-launch Chrome via the existing launcher. */
async function defaultPageFactory(): Promise<IPage> {
  const port = Number(process.env.CHROME_DEBUG_PORT ?? 9222);
  const { BrowserPage } = await import("../../browser/page.js");
  try {
    const page = await BrowserPage.connect(port);
    return page;
  } catch {
    const { launchChrome } = await import("../../browser/launcher.js");
    await launchChrome(port);
    // Poll (5 attempts) — mirrors yaml-runner behavior.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await BrowserPage.connect(port);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("failed to connect to Chrome");
  }
}

/**
 * CdpBrowserTransport wraps IPage to expose CDP browser primitives via
 * the uniform TransportAdapter contract.
 */
export class CdpBrowserTransport implements TransportAdapter {
  readonly kind: TransportKind = "cdp-browser";
  readonly capability: Capability = CDP_CAPABILITY;

  private readonly pageFactory: () => Promise<IPage>;
  private page: IPage | undefined;
  private closed = false;

  constructor(opts: CdpBrowserTransportOptions = {}) {
    this.pageFactory = opts.pageFactory ?? defaultPageFactory;
  }

  async open(_ctx: TransportContext): Promise<void> {
    this.closed = false;
    if (!this.page) {
      this.page = await this.pageFactory();
    }
  }

  async snapshot(opts?: {
    format?: SnapshotFormat;
    fresh?: boolean;
  }): Promise<Snapshot> {
    if (!this.page) {
      return { format: "text", data: "" };
    }
    const format = opts?.format ?? "dom-ax";
    if (format === "screenshot") {
      const buf = await this.page.screenshot();
      return { format: "screenshot", data: buf };
    }
    const dom = await this.page.snapshot();
    return { format: "dom-ax", data: dom };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    const start = Date.now();
    const page = this.page;
    if (!page) {
      return err({
        transport: "cdp-browser",
        step: 0,
        action: req.kind,
        reason: "transport not opened — call open() before action()",
        suggestion: "invoke `transport.open(ctx)` before dispatching actions",
        retryable: false,
        exit_code: exitCodeFor("usage_error"),
      });
    }
    try {
      const envelope = await this.dispatch<T>(page, req);
      envelope.elapsedMs = Date.now() - start;
      return envelope;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err({
        transport: "cdp-browser",
        step: 0,
        action: req.kind,
        reason: msg,
        suggestion:
          "verify Chrome is reachable via CDP and the selector is valid",
        retryable: /timeout|disconnected|ws /i.test(msg),
        exit_code: exitCodeFor("generic_error"),
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.page) {
      const p = this.page;
      this.page = undefined;
      try {
        await p.close();
      } catch {
        // Best-effort — close must be idempotent and non-throwing.
      }
    }
  }

  // ── dispatch ─────────────────────────────────────────────────────

  private async dispatch<T>(
    page: IPage,
    req: ActionRequest,
  ): Promise<Envelope<T>> {
    const p = req.params as Record<string, unknown>;
    switch (req.kind) {
      case "navigate": {
        const url = typeof p.url === "string" ? p.url : undefined;
        if (!url) return missingParam("cdp-browser", "navigate", "url");
        const settleMs =
          typeof p.settleMs === "number" ? p.settleMs : undefined;
        const waitUntil =
          typeof p.waitUntil === "string" ? p.waitUntil : undefined;
        await page.goto(url, {
          ...(settleMs !== undefined ? { settleMs } : {}),
          ...(waitUntil ? { waitUntil } : {}),
        });
        return ok(undefined as T);
      }
      case "evaluate": {
        const script = typeof p.script === "string" ? p.script : undefined;
        if (!script) return missingParam("cdp-browser", "evaluate", "script");
        const data = await page.evaluate(script);
        return ok(data as T);
      }
      case "click": {
        const selector =
          typeof p.selector === "string" ? p.selector : undefined;
        if (!selector) return missingParam("cdp-browser", "click", "selector");
        await page.click(selector);
        return ok(undefined as T);
      }
      case "type": {
        const selector =
          typeof p.selector === "string" ? p.selector : undefined;
        const text = typeof p.text === "string" ? p.text : undefined;
        if (!selector) return missingParam("cdp-browser", "type", "selector");
        if (text === undefined)
          return missingParam("cdp-browser", "type", "text");
        await page.type(selector, text);
        return ok(undefined as T);
      }
      case "press": {
        const key = typeof p.key === "string" ? p.key : undefined;
        if (!key) return missingParam("cdp-browser", "press", "key");
        const modifiers = Array.isArray(p.modifiers)
          ? (p.modifiers as string[])
          : undefined;
        await page.press(key, modifiers);
        return ok(undefined as T);
      }
      case "scroll": {
        const direction =
          typeof p.direction === "string" ? p.direction : "down";
        await page.scroll(direction as "up" | "down" | "top" | "bottom");
        return ok(undefined as T);
      }
      case "wait": {
        if (typeof p.seconds === "number") {
          await page.wait(p.seconds);
        } else if (typeof p.selector === "string") {
          const timeout = typeof p.timeout === "number" ? p.timeout : undefined;
          await page.waitForSelector(p.selector, timeout);
        } else if (typeof p.condition === "string") {
          const timeout = typeof p.timeout === "number" ? p.timeout : undefined;
          await page.waitFor(p.condition, timeout);
        } else {
          return missingParam(
            "cdp-browser",
            "wait",
            "seconds | selector | condition",
          );
        }
        return ok(undefined as T);
      }
      case "snapshot": {
        const dom = await page.snapshot();
        return ok(dom as T);
      }
      case "screenshot": {
        const buf = await page.screenshot();
        return ok(buf as T);
      }
      default:
        return err({
          transport: "cdp-browser",
          step: 0,
          action: req.kind,
          reason: `unsupported action "${req.kind}" for cdp-browser transport`,
          suggestion: `cdp-browser transport supports: ${CDP_STEPS.join(", ")}`,
          minimum_capability: `cdp-browser.${req.kind}`,
          exit_code: exitCodeFor("usage_error"),
        });
    }
  }
}

function missingParam<T>(
  transport: TransportKind,
  action: string,
  param: string,
): Envelope<T> {
  return err({
    transport,
    step: 0,
    action,
    reason: `missing required param \`${param}\``,
    suggestion: `pass params.${param} to the ${action} action`,
    retryable: false,
    exit_code: exitCodeFor("usage_error"),
  });
}
