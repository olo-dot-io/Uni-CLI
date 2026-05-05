/**
 * CdpBrowserTransport — wraps the existing `BrowserPage` (an IPage impl)
 * behind the TransportAdapter interface.
 *
 * The underlying `src/browser/page.ts` is the canonical CDP client; this
 * wrapper exposes the same methods through the uniform envelope contract
 * so the bus-driven dispatch routes browser steps without duplicating
 * the CDP client logic.
 *
 * Page acquisition is pluggable via the constructor `pageFactory` for
 * testability. The default factory tries an already-running browser on
 * the configured CDP port and falls back to auto-launch.
 */

import { err, exitCodeFor, ok } from "../../core/envelope.js";
import { spawn } from "node:child_process";
import { findElectronApp, type ElectronAppEntry } from "../../electron-apps.js";
import type { Envelope } from "../../core/envelope.js";
import type { IPage } from "../../types.js";
import { RefAllocator } from "../refs.js";
import {
  encodeSnapshot,
  type RawAxNode,
  type SnapshotEncoding,
} from "../snapshot-encoder.js";
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
  "cdp_attach",
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
  pageConnector?: (port: number, wsUrl?: string) => Promise<IPage>;
  cdpProbe?: (port: number) => Promise<CdpDebuggerInfo | null>;
  appLauncher?: (request: CdpAppLaunchRequest) => Promise<void>;
}

export interface CdpAppLaunchRequest {
  app: string;
  port: number;
  processName: string;
  bundleId?: string;
  displayName?: string;
  executableNames?: readonly string[];
  extraArgs?: readonly string[];
  relaunchLosesSession?: boolean;
}

export interface CdpTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface CdpDebuggerInfo {
  port: number;
  webSocketDebuggerUrl: string;
  targets: CdpTargetInfo[];
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
    // Poll up to 20 attempts at 500ms each while the launched Chrome warms up.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
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

async function defaultPageConnector(port: number): Promise<IPage> {
  const { BrowserPage } = await import("../../browser/page.js");
  return BrowserPage.connect(port);
}

async function defaultCdpProbe(port: number): Promise<CdpDebuggerInfo | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!resp.ok) return null;
    const targets = (await resp.json()) as CdpTargetInfo[];
    const selected = selectTarget(targets);
    if (!selected) return null;
    return {
      port,
      webSocketDebuggerUrl: selected.webSocketDebuggerUrl,
      targets,
    };
  } catch {
    return null;
  }
}

async function defaultAppLauncher(request: CdpAppLaunchRequest): Promise<void> {
  const debugArg = `--remote-debugging-port=${request.port}`;
  const extraArgs = [...(request.extraArgs ?? []), debugArg];
  if (process.platform === "darwin") {
    const args = request.bundleId
      ? ["-b", request.bundleId, "--args", ...extraArgs]
      : ["-a", request.processName, "--args", ...extraArgs];
    await runProcess("open", args);
    return;
  }

  const command = request.executableNames?.[0] ?? request.processName;
  const child = spawn(command, extraArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function runProcess(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

/**
 * CdpBrowserTransport wraps IPage to expose CDP browser primitives via
 * the uniform TransportAdapter contract.
 */
export class CdpBrowserTransport implements TransportAdapter {
  readonly kind: TransportKind = "cdp-browser";
  readonly capability: Capability = CDP_CAPABILITY;

  private readonly pageFactory: () => Promise<IPage>;
  private readonly pageConnector: (
    port: number,
    wsUrl?: string,
  ) => Promise<IPage>;
  private readonly cdpProbe: (port: number) => Promise<CdpDebuggerInfo | null>;
  private readonly appLauncher: (request: CdpAppLaunchRequest) => Promise<void>;
  private readonly eagerOpen: boolean;
  private refs: TransportContext["refs"] | undefined;
  private page: IPage | undefined;
  private closed = false;

  constructor(opts: CdpBrowserTransportOptions = {}) {
    this.pageFactory = opts.pageFactory ?? defaultPageFactory;
    this.pageConnector = opts.pageConnector ?? defaultPageConnector;
    this.cdpProbe = opts.cdpProbe ?? defaultCdpProbe;
    this.appLauncher = opts.appLauncher ?? defaultAppLauncher;
    this.eagerOpen =
      opts.pageFactory !== undefined &&
      opts.pageConnector === undefined &&
      opts.cdpProbe === undefined;
  }

  async open(ctx: TransportContext): Promise<void> {
    this.refs = ctx.refs ?? ctx.bus.refs;
    this.closed = false;
    if (this.eagerOpen && !this.page) {
      this.page = await this.pageFactory();
    }
  }

  async snapshot(opts?: {
    format?: SnapshotFormat | SnapshotEncoding;
    fresh?: boolean;
  }): Promise<Snapshot> {
    const page = await this.ensurePage();
    const format = opts?.format ?? "dom-ax";
    if (format === "screenshot") {
      const buf = await page.screenshot();
      return { format: "screenshot", data: buf };
    }
    if (format === "compact" || format === "tree" || format === "json") {
      const raw = await this.captureDomSnapshot(page);
      if (format === "json") {
        return {
          format: "json",
          encoding: "json",
          data: JSON.stringify(raw),
        };
      }
      const alloc = new RefAllocator();
      const { encoded, refCount } = encodeSnapshot(raw, {
        format,
        transport: this.kind,
        alloc,
      });
      this.refs?.put(alloc.freeze(this.kind, raw.scope));
      return {
        format: "text",
        encoding: format,
        data: encoded,
        refs: { count: refCount, scope: raw.scope },
      };
    }
    const dom = await page.snapshot();
    return { format: "dom-ax", data: dom };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    const start = Date.now();
    try {
      const page =
        req.kind === "cdp_attach"
          ? undefined
          : await this.ensurePage(req.params);
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
    page: IPage | undefined,
    req: ActionRequest,
  ): Promise<Envelope<T>> {
    const p = req.params as Record<string, unknown>;
    switch (req.kind) {
      case "cdp_attach":
        return this.attach(p) as Promise<Envelope<T>>;
      case "navigate": {
        if (!page) return notOpened("navigate");
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
        if (!page) return notOpened("evaluate");
        const script = typeof p.script === "string" ? p.script : undefined;
        if (!script) return missingParam("cdp-browser", "evaluate", "script");
        const data = await page.evaluate(script);
        return ok(data as T);
      }
      case "click": {
        if (!page) return notOpened("click");
        const selector =
          typeof p.selector === "string"
            ? p.selector
            : readSelectorFromStable(p.stable);
        if (!selector) return missingParam("cdp-browser", "click", "selector");
        await page.click(selector);
        return ok(undefined as T);
      }
      case "type": {
        if (!page) return notOpened("type");
        const selector =
          typeof p.selector === "string"
            ? p.selector
            : readSelectorFromStable(p.stable);
        const text = typeof p.text === "string" ? p.text : undefined;
        if (!selector) return missingParam("cdp-browser", "type", "selector");
        if (text === undefined)
          return missingParam("cdp-browser", "type", "text");
        await page.type(selector, text);
        return ok(undefined as T);
      }
      case "press": {
        if (!page) return notOpened("press");
        const key = typeof p.key === "string" ? p.key : undefined;
        if (!key) return missingParam("cdp-browser", "press", "key");
        const modifiers = Array.isArray(p.modifiers)
          ? (p.modifiers as string[])
          : undefined;
        await page.press(key, modifiers);
        return ok(undefined as T);
      }
      case "scroll": {
        if (!page) return notOpened("scroll");
        const direction =
          typeof p.direction === "string" ? p.direction : "down";
        await page.scroll(direction as "up" | "down" | "top" | "bottom");
        return ok(undefined as T);
      }
      case "wait": {
        if (!page) return notOpened("wait");
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
        if (!page) return notOpened("snapshot");
        const dom = await page.snapshot();
        return ok(dom as T);
      }
      case "screenshot": {
        if (!page) return notOpened("screenshot");
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

  async attach(params: Record<string, unknown>): Promise<Envelope<unknown>> {
    const explicitPort =
      typeof params.port === "number"
        ? Math.trunc(params.port)
        : typeof params.debugPort === "number"
          ? Math.trunc(params.debugPort)
          : undefined;
    const app = typeof params.app === "string" ? params.app : undefined;
    const appEntry = app ? findElectronApp(app) : null;
    const port = explicitPort ?? appEntry?.port;
    if (!port) {
      return missingParam("cdp-browser", "cdp_attach", "port | app");
    }

    let info = await this.cdpProbe(port);
    let relaunched = false;
    if (!info && app && appEntry && params.relaunch !== false) {
      if (
        appEntry.relaunchLosesSession === true &&
        params.confirmRelaunch !== true
      ) {
        return err({
          transport: "cdp-browser",
          step: 0,
          action: "cdp_attach",
          reason: `relaunching ${app} may lose session state; retry with --confirm-relaunch to allow it`,
          suggestion:
            "retry with --confirm-relaunch only if relaunching this app is acceptable",
          minimum_capability: "cdp-browser.cdp_attach.confirm_relaunch",
          retryable: false,
          exit_code: exitCodeFor("auth_required"),
        });
      }
      await this.appLauncher(toLaunchRequest(app, port, appEntry));
      relaunched = true;
      info = await this.probeAfterLaunch(port);
    }
    if (!info) {
      return err({
        transport: "cdp-browser",
        step: 0,
        action: "cdp_attach",
        reason: `no CDP endpoint available on port ${String(port)}`,
        suggestion:
          "launch the Electron app with --remote-debugging-port or pass a reachable --port",
        minimum_capability: "cdp-browser.cdp_attach",
        exit_code: exitCodeFor("service_unavailable"),
      });
    }

    this.page = await this.pageConnector(port, info.webSocketDebuggerUrl);
    return ok({
      port,
      webSocketDebuggerUrl: info.webSocketDebuggerUrl,
      targets: info.targets,
      relaunched,
      ...(app ? { app } : {}),
    });
  }

  private async probeAfterLaunch(
    port: number,
  ): Promise<CdpDebuggerInfo | null> {
    let info: CdpDebuggerInfo | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      info = await this.cdpProbe(port);
      if (info) return info;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  private async ensurePage(
    params: Record<string, unknown> = {},
  ): Promise<IPage> {
    if (!this.page) {
      const port =
        typeof params.port === "number" && Number.isFinite(params.port)
          ? Math.trunc(params.port)
          : undefined;
      const wsUrl =
        typeof params.webSocketDebuggerUrl === "string"
          ? params.webSocketDebuggerUrl
          : undefined;
      this.page = port
        ? await this.pageConnector(port, wsUrl)
        : await this.pageFactory();
    }
    return this.page;
  }

  private async captureDomSnapshot(page: IPage): Promise<RawAxNode> {
    const raw = await page.evaluate(CDP_DOM_SNAPSHOT_SCRIPT);
    if (isRawAxNode(raw)) return raw;
    throw new Error("CDP DOM snapshot script returned an invalid tree");
  }
}

const CDP_DOM_SNAPSHOT_SCRIPT = `(() => {
  const scope = "renderer";
  const roleFor = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "input" || tag === "textarea") return "text";
    if (tag === "select") return "combo_box";
    if (tag === "option") return "menu_item";
    if (tag === "img") return "image";
    return tag;
  };
  const nameFor = (el) =>
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    el.getAttribute("alt") ||
    el.value ||
    (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120) ||
    undefined;
  const selectorFor = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && cur !== document.documentElement) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) break;
      const index = Array.from(parent.children).filter((child) => child.tagName === cur.tagName).indexOf(cur) + 1;
      parts.unshift(tag + ":nth-of-type(" + index + ")");
      cur = parent;
    }
    return parts.length ? parts.join(" > ") : el.tagName.toLowerCase();
  };
  const boundsFor = (el) => {
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
  };
  const statesFor = (el) => {
    const states = [];
    if (!el.disabled && el.getAttribute("aria-disabled") !== "true") states.push("enabled");
    if (el.matches("button,a,input,textarea,select,[contenteditable='true'],[tabindex]")) states.push("focusable");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") states.push("disabled");
    return states;
  };
  const candidates = Array.from(document.querySelectorAll("button,a,input,textarea,select,option,[role],[aria-label],[title],[contenteditable='true'],[tabindex]"))
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && nameFor(el);
    })
    .slice(0, 250)
    .map((el) => ({
      role: roleFor(el),
      name: nameFor(el),
      value: typeof el.value === "string" && el.value ? el.value : undefined,
      bounds: boundsFor(el),
      states: statesFor(el),
      path: selectorFor(el),
      scope
    }));
  return {
    role: "document",
    name: document.title || location.href,
    bounds: { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight },
    states: ["enabled"],
    path: "document[0]",
    scope,
    children: candidates
  };
})()`;

function toLaunchRequest(
  app: string,
  port: number,
  entry: ElectronAppEntry,
): CdpAppLaunchRequest {
  return {
    app,
    port,
    processName: entry.processName,
    ...(entry.bundleId ? { bundleId: entry.bundleId } : {}),
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
    ...(entry.executableNames
      ? { executableNames: entry.executableNames }
      : {}),
    ...(entry.extraArgs ? { extraArgs: entry.extraArgs } : {}),
    ...(entry.relaunchLosesSession !== undefined
      ? { relaunchLosesSession: entry.relaunchLosesSession }
      : {}),
  };
}

function selectTarget(targets: CdpTargetInfo[]): CdpTargetInfo | undefined {
  return targets
    .filter(
      (target) =>
        !target.url.startsWith("devtools://") &&
        target.type !== "service_worker" &&
        target.webSocketDebuggerUrl,
    )
    .sort((a, b) => targetScore(b) - targetScore(a))[0];
}

function targetScore(target: CdpTargetInfo): number {
  return (
    (target.type === "app" ? 120 : target.type === "page" ? 80 : 60) +
    (target.url.startsWith("http") ? 10 : 0)
  );
}

function notOpened<T>(action: string): Envelope<T> {
  return err({
    transport: "cdp-browser",
    step: 0,
    action,
    reason: "transport not opened — call open() before action()",
    suggestion: "invoke `transport.open(ctx)` before dispatching actions",
    retryable: false,
    exit_code: exitCodeFor("usage_error"),
  });
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

function readSelectorFromStable(stable: unknown): string | undefined {
  if (typeof stable !== "string") return undefined;
  const prefix = "cdp-browser:";
  if (!stable.startsWith(prefix)) return undefined;
  const rest = stable.slice(prefix.length);
  const separator = rest.indexOf(":");
  if (separator < 0) return undefined;
  const selector = rest.slice(separator + 1);
  return selector || undefined;
}

function isRawAxNode(value: unknown): value is RawAxNode {
  if (!isRecord(value)) return false;
  return (
    typeof value.role === "string" &&
    typeof value.path === "string" &&
    typeof value.scope === "string" &&
    (value.children === undefined ||
      (Array.isArray(value.children) && value.children.every(isRawAxNode)))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
