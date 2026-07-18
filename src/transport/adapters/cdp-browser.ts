/**
 * @owner   src/transport/adapters/cdp-browser.ts
 * @does    Expose broker-owned browser operations and explicit Electron/CDP attachments behind the transport adapter envelope contract.
 * @needs   browser bridge/page/invocation scope, transactional file publication, Electron app launcher, refs/snapshot encoder/types
 * @feeds   bus-driven browser steps, adapter execution, tests/unit/transport adapters
 * @breaks  CDP attach, app launch, and ordinary browser action failures return structured envelopes; outcome-ambiguous delivery throws unchanged and retires an unusable page.
 * @invariants Default page acquisition requires a trusted invocation scope and delegates process/target ownership to the browser broker; target-aware snapshots attach to their exact renderer WebSocket, probing a port-only target before ref allocation; endpoint-bound ref scopes are renderer-unique and contain no raw endpoint material; contradictory port/WebSocket targets fail closed; only explicit port/app attachment uses direct CDP; a directly launched app remains pending-owned until CDP readiness and is contained on failure/cancellation; one explicit endpoint is cached per Agent turn/provider/profile identity and endpoint changes replace rather than silently reuse it; request cancellation reaches CDP discovery/connection; any structural outcome_ambiguous error escapes the envelope/cascade path without fallback replay.
 * @side-effects May launch explicitly requested Electron apps, mutate broker-owned or explicitly attached pages, and atomically publish requested screenshots; never implicitly launches Chrome.
 * @perf    CDP target probing and post-launch polling are bounded.
 * @concurrency Browser profile/target concurrency is broker-owned; explicit attachment caches are isolated per ambient Agent scope and released by its turn finalizer even on the process-shared transport bus.
 * @test    tests/unit/transport/adapters/cdp-browser.test.ts
 * @stability experimental
 * @since   2026-06-29
 */

import { createHash } from "node:crypto";

import { err, exitCodeFor, ok } from "../../core/envelope.js";
import { writeFileTransactionally } from "../../engine/transactional-file.js";
import { BrowserBridge } from "../../browser/bridge.js";
import {
  currentBrowserInvocationScope,
  registerBrowserTurnFinalizer,
} from "../../browser/invocation-scope.js";
import { findElectronApp, type ElectronAppEntry } from "../../electron-apps.js";
import type { Envelope } from "../../core/envelope.js";
import type { IPage } from "../../types.js";
import { settleDispatchedAction } from "../action-settlement.js";
import {
  findOperationOutcomeAmbiguousError,
  ProcessContainmentAmbiguousError,
} from "../contained-process.js";
import {
  launchCdpApp,
  type CdpAppLauncher,
  type CdpAppLaunchReceipt,
  type CdpAppLaunchRequest,
} from "../cdp-app-launcher.js";
import { RefAllocator } from "../refs.js";
import { encodeSnapshot, type RawAxNode } from "../snapshot-encoder.js";
import {
  cdpEndpointValidationError,
  readCdpEndpoint,
  type CdpEndpoint,
} from "../cdp-endpoint.js";
import type {
  ActionRequest,
  ActionResult,
  Capability,
  Snapshot,
  SnapshotFormat,
  SnapshotRequest,
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

const CDP_READ_ONLY_ACTIONS = new Set(["snapshot", "screenshot", "wait"]);

const CDP_CAPABILITY: Capability = {
  steps: CDP_STEPS,
  snapshotFormats: ["dom-ax", "screenshot"] as readonly SnapshotFormat[],
  mutatesHost: true,
};

export interface CdpBrowserTransportOptions {
  /**
   * Optional factory for an `IPage`. When omitted, the transport acquires a
   * broker-owned page from the trusted ambient invocation. Tests inject a
   * mock here.
   */
  pageFactory?: () => Promise<IPage>;
  pageConnector?: (
    port: number,
    wsUrl?: string,
    signal?: AbortSignal,
  ) => Promise<IPage>;
  cdpProbe?: (
    port: number,
    signal?: AbortSignal,
  ) => Promise<CdpDebuggerInfo | null>;
  appLauncher?: CdpAppLauncher;
}

export type { CdpAppLaunchRequest } from "../cdp-app-launcher.js";

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

/** Default factory — acquire only through the broker-owned ambient scope. */
async function defaultPageFactory(): Promise<IPage> {
  if (!currentBrowserInvocationScope()) {
    throw new Error(
      "Default browser compute actions require a trusted browser invocation scope",
    );
  }
  return new BrowserBridge().connect();
}

async function defaultPageConnector(
  port: number,
  wsUrl?: string,
  signal?: AbortSignal,
): Promise<IPage> {
  const { BrowserPage } = await import("../../browser/page.js");
  return wsUrl
    ? BrowserPage.connectWebSocket(wsUrl, signal)
    : BrowserPage.connect(port);
}

async function defaultCdpProbe(
  port: number,
  signal?: AbortSignal,
): Promise<CdpDebuggerInfo | null> {
  try {
    signal?.throwIfAborted();
    const resp = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(1500)])
        : AbortSignal.timeout(1500),
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
    signal?.throwIfAborted();
    return null;
  }
}

function pageScopeKey(): string {
  const scope = currentBrowserInvocationScope();
  if (!scope) return "unscoped";
  return JSON.stringify([
    scope.context.agent_session_id,
    scope.context.turn_id,
    scope.provider,
    scope.visibility,
    scope.profilePartitionId,
    scope.isolated,
    scope.ephemeral,
    scope.profileId ?? null,
  ]);
}

type CdpAttachmentEndpoint = CdpEndpoint;

interface CachedPage {
  page: IPage;
  endpoint?: CdpAttachmentEndpoint;
}

let nextTransportInstanceId = 1;

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
    signal?: AbortSignal,
  ) => Promise<IPage>;
  private readonly cdpProbe: (
    port: number,
    signal?: AbortSignal,
  ) => Promise<CdpDebuggerInfo | null>;
  private readonly appLauncher: CdpAppLauncher;
  private readonly eagerOpen: boolean;
  private readonly cacheFactoryPage: boolean;
  private readonly instanceId = nextTransportInstanceId++;
  private refs: TransportContext["refs"] | undefined;
  private readonly pages = new Map<string, CachedPage>();
  private closed = false;

  constructor(opts: CdpBrowserTransportOptions = {}) {
    this.pageFactory = opts.pageFactory ?? defaultPageFactory;
    this.pageConnector = opts.pageConnector ?? defaultPageConnector;
    this.cdpProbe = opts.cdpProbe ?? defaultCdpProbe;
    this.appLauncher = opts.appLauncher ?? launchCdpApp;
    this.cacheFactoryPage = opts.pageFactory !== undefined;
    this.eagerOpen =
      opts.pageFactory !== undefined &&
      opts.pageConnector === undefined &&
      opts.cdpProbe === undefined;
  }

  async open(ctx: TransportContext): Promise<void> {
    this.refs = ctx.refs ?? ctx.bus.refs;
    this.closed = false;
    if (this.eagerOpen && !this.cachedPage()) {
      await this.replaceCachedPage(await this.pageFactory());
    }
  }

  async snapshot(opts?: SnapshotRequest): Promise<Snapshot> {
    opts?.signal?.throwIfAborted();
    const endpointError = cdpEndpointValidationError(opts?.params ?? {});
    if (endpointError) throw new CdpEndpointInputError(endpointError);
    const page = await this.ensurePage(opts?.params, opts?.signal);
    const endpoint = this.endpointForPage(page);
    const format = opts?.format ?? "dom-ax";
    if (format === "screenshot") {
      const buf = opts?.signal
        ? await page.screenshot(undefined, opts.signal)
        : await page.screenshot();
      return { format: "screenshot", data: buf };
    }
    if (format === "compact" || format === "tree" || format === "json") {
      const raw = await this.captureDomSnapshot(page, endpoint, opts?.signal);
      const alloc = new RefAllocator();
      const { encoded, refCount } = encodeSnapshot(raw, {
        format,
        transport: this.kind,
        alloc,
        ...(endpoint?.webSocketDebuggerUrl ? { cdpEndpoint: endpoint } : {}),
      });
      this.refs?.put(alloc.freeze(this.kind, raw.scope));
      return {
        format: format === "json" ? "json" : "text",
        encoding: format,
        data: encoded,
        refs: {
          count: refCount,
          scope: raw.scope,
          durability: endpoint?.webSocketDebuggerUrl
            ? "cross-process"
            : "invocation",
          reusable: Boolean(endpoint?.webSocketDebuggerUrl),
        },
      };
    }
    const dom = opts?.signal
      ? await page.snapshot(undefined, opts.signal)
      : await page.snapshot();
    return { format: "dom-ax", data: dom };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    const start = Date.now();
    let page: IPage | undefined;
    try {
      req.signal?.throwIfAborted();
      const endpointError = cdpEndpointValidationError(req.params);
      if (endpointError) {
        return invalidParameter(
          "cdp-browser",
          req.kind,
          endpointError,
        ) as ActionResult<T>;
      }
      page =
        req.kind === "cdp_attach"
          ? undefined
          : await this.ensurePage(req.params, req.signal);
      const envelope = await settleDispatchedAction(
        req.kind,
        req.canMutate ?? !CDP_READ_ONLY_ACTIONS.has(req.kind),
        req.signal,
        () => this.dispatch<T>(page, req),
      );
      envelope.elapsedMs = Date.now() - start;
      return envelope;
    } catch (e) {
      const ambiguity = findOperationOutcomeAmbiguousError(e);
      if (ambiguity) {
        if (page && ambiguity.target_unusable === true) {
          await this.retireUnusablePage(
            page,
            e instanceof Error ? e : ambiguity,
          );
        }
        throw e;
      }
      req.signal?.throwIfAborted();
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
    const pages = [
      ...new Set([...this.pages.values()].map(({ page }) => page)),
    ];
    this.pages.clear();
    const errors: unknown[] = [];
    for (const page of pages) {
      try {
        await page.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "CDP transport page cleanup failed");
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
        return this.attach(p, req.signal) as Promise<Envelope<T>>;
      case "navigate": {
        if (!page) return notOpened("navigate");
        const url = typeof p.url === "string" ? p.url : undefined;
        if (!url) return missingParam("cdp-browser", "navigate", "url");
        const settleMs =
          typeof p.settleMs === "number" ? p.settleMs : undefined;
        const waitUntil =
          typeof p.waitUntil === "string" ? p.waitUntil : undefined;
        const options = {
          ...(settleMs !== undefined ? { settleMs } : {}),
          ...(waitUntil ? { waitUntil } : {}),
        };
        if (req.signal) await page.goto(url, options, req.signal);
        else await page.goto(url, options);
        return ok(undefined as T);
      }
      case "evaluate": {
        if (!page) return notOpened("evaluate");
        const script = typeof p.script === "string" ? p.script : undefined;
        if (!script) return missingParam("cdp-browser", "evaluate", "script");
        const data = req.signal
          ? await page.evaluate(script, req.signal)
          : await page.evaluate(script);
        return ok(data as T);
      }
      case "click": {
        if (!page) return notOpened("click");
        const selector =
          typeof p.selector === "string"
            ? p.selector
            : readSelectorFromStable(p.stable);
        if (!selector) return missingParam("cdp-browser", "click", "selector");
        if (req.signal) await page.click(selector, req.signal);
        else await page.click(selector);
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
        if (req.signal) await page.type(selector, text, req.signal);
        else await page.type(selector, text);
        return ok(undefined as T);
      }
      case "press": {
        if (!page) return notOpened("press");
        const key = typeof p.key === "string" ? p.key : undefined;
        if (!key) return missingParam("cdp-browser", "press", "key");
        const modifiers = Array.isArray(p.modifiers)
          ? (p.modifiers as string[])
          : undefined;
        if (req.signal) await page.press(key, modifiers, req.signal);
        else await page.press(key, modifiers);
        return ok(undefined as T);
      }
      case "scroll": {
        if (!page) return notOpened("scroll");
        const direction =
          typeof p.direction === "string" ? p.direction : "down";
        const scrollDirection = direction as "up" | "down" | "top" | "bottom";
        if (req.signal) await page.scroll(scrollDirection, req.signal);
        else await page.scroll(scrollDirection);
        return ok(undefined as T);
      }
      case "wait": {
        if (!page) return notOpened("wait");
        if (typeof p.seconds === "number") {
          if (req.signal) await page.wait(p.seconds, req.signal);
          else await page.wait(p.seconds);
        } else if (typeof p.selector === "string") {
          const timeout = typeof p.timeout === "number" ? p.timeout : undefined;
          if (req.signal) {
            await page.waitForSelector(p.selector, timeout, req.signal);
          } else {
            await page.waitForSelector(p.selector, timeout);
          }
        } else if (typeof p.condition === "string") {
          const timeout = typeof p.timeout === "number" ? p.timeout : undefined;
          if (req.signal) {
            await page.waitFor(p.condition, timeout, req.signal);
          } else {
            await page.waitFor(p.condition, timeout);
          }
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
        const dom = req.signal
          ? await page.snapshot(undefined, req.signal)
          : await page.snapshot();
        return ok(dom as T);
      }
      case "screenshot": {
        if (!page) return notOpened("screenshot");
        const path = readOptionalPath(p.path);
        if (p.path !== undefined && !path) {
          return invalidParameter(
            "cdp-browser",
            "screenshot",
            "path must be a non-empty string",
          );
        }
        const buf = req.signal
          ? await page.screenshot(undefined, req.signal)
          : await page.screenshot();
        if (path) {
          await writeFileTransactionally(path, buf, {
            mode: 0o600,
            ...(req.signal ? { signal: req.signal } : {}),
          });
        }
        return ok(
          (path ? { path, mime: "image/png", bytes: buf.length } : buf) as T,
        );
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

  async attach(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<unknown>> {
    signal?.throwIfAborted();
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

    let info = await this.cdpProbe(port, signal);
    signal?.throwIfAborted();
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
      let launchReceipt: CdpAppLaunchReceipt | undefined;
      try {
        launchReceipt =
          (await this.appLauncher({
            ...toLaunchRequest(app, port, appEntry),
            ...(signal ? { signal } : {}),
          })) ?? undefined;
        signal?.throwIfAborted();
        relaunched = true;
        info = await this.probeAfterLaunch(port, signal);
        if (info) launchReceipt?.release();
        else await launchReceipt?.contain();
      } catch (error) {
        if (launchReceipt) {
          try {
            await launchReceipt.contain();
          } catch (containmentError) {
            throw new ProcessContainmentAmbiguousError(
              "cdp_attach",
              signal?.reason ?? error,
              error,
              containmentError,
            );
          }
        }
        throw error;
      }
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

    const requestedTargetId =
      typeof params.targetId === "string" ? params.targetId.trim() : undefined;
    const selectedTarget = requestedTargetId
      ? info.targets.find((target) => target.id === requestedTargetId)
      : selectTarget(info.targets);
    const selectedWebSocketDebuggerUrl =
      selectedTarget?.webSocketDebuggerUrl ??
      (requestedTargetId ? undefined : info.webSocketDebuggerUrl);
    if (!selectedWebSocketDebuggerUrl) {
      return err({
        transport: "cdp-browser",
        step: 0,
        action: "cdp_attach",
        reason: requestedTargetId
          ? `CDP target ${requestedTargetId} is not available on port ${String(port)}`
          : `no controllable CDP renderer is available on port ${String(port)}`,
        suggestion:
          "inspect the returned CDP target inventory and retry with its exact targetId",
        minimum_capability: "cdp-browser.cdp_attach.target_not_found",
        exit_code: exitCodeFor("empty_result"),
      });
    }

    const endpoint: CdpEndpoint = {
      port,
      webSocketDebuggerUrl: selectedWebSocketDebuggerUrl,
      ...(selectedTarget ? { targetId: selectedTarget.id } : {}),
    };

    await this.replaceCachedPage(
      await this.connectPage(endpoint, signal),
      endpoint,
    );
    return ok({
      port,
      webSocketDebuggerUrl: selectedWebSocketDebuggerUrl,
      ...(selectedTarget ? { targetId: selectedTarget.id } : {}),
      targets: info.targets,
      relaunched,
      ...(app ? { app } : {}),
    });
  }

  private async probeAfterLaunch(
    port: number,
    signal?: AbortSignal,
  ): Promise<CdpDebuggerInfo | null> {
    let info: CdpDebuggerInfo | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      signal?.throwIfAborted();
      info = await this.cdpProbe(port, signal);
      signal?.throwIfAborted();
      if (info) return info;
      await cancellableDelay(500, signal);
    }
    return null;
  }

  private async ensurePage(
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<IPage> {
    let endpoint = readCdpEndpoint(params);
    const existing = this.cachedPage(endpoint);
    if (existing) return existing;
    if (endpoint) {
      if (!endpoint.webSocketDebuggerUrl || endpoint.targetId) {
        const requestedTargetId = endpoint.targetId;
        const info = await this.cdpProbe(endpoint.port, signal);
        signal?.throwIfAborted();
        if (!info) {
          throw new Error(
            `no exact CDP page target is available on port ${String(endpoint.port)}`,
          );
        }
        const selectedTarget = requestedTargetId
          ? info.targets.find((target) => target.id === requestedTargetId)
          : selectTarget(info.targets);
        const selectedWebSocketDebuggerUrl =
          selectedTarget?.webSocketDebuggerUrl ??
          (requestedTargetId ? undefined : info.webSocketDebuggerUrl);
        if (!selectedWebSocketDebuggerUrl) {
          throw new Error(
            requestedTargetId
              ? `CDP target ${requestedTargetId} is not available on port ${String(endpoint.port)}`
              : `no controllable CDP renderer is available on port ${String(endpoint.port)}`,
          );
        }
        if (
          endpoint.webSocketDebuggerUrl &&
          endpoint.webSocketDebuggerUrl !== selectedWebSocketDebuggerUrl
        ) {
          throw new Error(
            `targetId ${requestedTargetId ?? "<default>"} and webSocketDebuggerUrl identify different CDP renderers`,
          );
        }
        endpoint = {
          port: info.port,
          webSocketDebuggerUrl: selectedWebSocketDebuggerUrl,
          ...(selectedTarget ? { targetId: selectedTarget.id } : {}),
        };
      }
      const page = await this.connectPage(endpoint, signal);
      await this.replaceCachedPage(page, endpoint);
      return page;
    }
    const page = await this.pageFactory();
    if (this.cacheFactoryPage) await this.replaceCachedPage(page);
    return page;
  }

  private endpointForPage(page: IPage): CdpEndpoint | undefined {
    for (const cached of this.pages.values()) {
      if (cached.page === page) return cached.endpoint;
    }
    return undefined;
  }

  private async connectPage(
    endpoint: CdpAttachmentEndpoint,
    signal?: AbortSignal,
  ): Promise<IPage> {
    signal?.throwIfAborted();
    const connection = signal
      ? this.pageConnector(endpoint.port, endpoint.webSocketDebuggerUrl, signal)
      : this.pageConnector(endpoint.port, endpoint.webSocketDebuggerUrl);
    return signal ? settleCdpConnection(connection, signal) : connection;
  }

  private cachedPage(endpoint?: CdpAttachmentEndpoint): IPage | undefined {
    const cached = this.pages.get(pageScopeKey());
    if (!cached) return undefined;
    if (!endpoint) return cached.page;
    if (!cached.endpoint || cached.endpoint.port !== endpoint.port) {
      return undefined;
    }
    if (
      endpoint.webSocketDebuggerUrl &&
      cached.endpoint.webSocketDebuggerUrl !== endpoint.webSocketDebuggerUrl
    ) {
      return undefined;
    }
    if (endpoint.targetId && cached.endpoint.targetId !== endpoint.targetId) {
      return undefined;
    }
    return cached.page;
  }

  private async replaceCachedPage(
    page: IPage,
    endpoint?: CdpAttachmentEndpoint,
  ): Promise<void> {
    const key = pageScopeKey();
    const previous = this.pages.get(key)?.page;
    if (previous && previous !== page) {
      this.pages.delete(key);
      try {
        await previous.close();
      } catch (previousError) {
        try {
          await page.close();
        } catch (replacementError) {
          throw new AggregateError(
            [previousError, replacementError],
            "Previous and replacement CDP pages both failed cleanup",
          );
        }
        throw previousError;
      }
    }
    this.pages.set(key, { page, ...(endpoint ? { endpoint } : {}) });
    registerBrowserTurnFinalizer(
      `cdp-browser:${String(this.instanceId)}:${key}`,
      async () => {
        const current = this.pages.get(key);
        if (current?.page !== page) return;
        this.pages.delete(key);
        await page.close();
      },
    );
  }

  private async retireUnusablePage(
    page: IPage,
    ambiguousError: Error,
  ): Promise<void> {
    for (const [key, cached] of this.pages) {
      if (cached.page === page) this.pages.delete(key);
    }
    try {
      await page.close();
    } catch (cleanupError) {
      throw new CdpAmbiguousCleanupError(ambiguousError, cleanupError);
    }
  }

  private async captureDomSnapshot(
    page: IPage,
    endpoint?: CdpEndpoint,
    signal?: AbortSignal,
  ): Promise<RawAxNode> {
    const raw = signal
      ? await page.evaluate(CDP_DOM_SNAPSHOT_SCRIPT, signal)
      : await page.evaluate(CDP_DOM_SNAPSHOT_SCRIPT);
    if (isRawAxNode(raw)) {
      return bindRawAxScope(raw, rendererScope(endpoint));
    }
    throw new Error("CDP DOM snapshot script returned an invalid tree");
  }
}

class CdpAmbiguousCleanupError extends Error {
  readonly outcome_ambiguous = true;
  readonly target_unusable = true;
  readonly retryable = false;

  constructor(ambiguousError: Error, cleanupError: unknown) {
    super(
      `CDP outcome is ambiguous and its unusable page failed cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      {
        cause: new AggregateError(
          [ambiguousError, cleanupError],
          "CDP delivery and target cleanup both failed",
        ),
      },
    );
    this.name = "CdpAmbiguousCleanupError";
  }
}

class CdpEndpointInputError extends Error {
  readonly minimum_capability = "cdp-browser.invalid_target";
  readonly exit_code = exitCodeFor("usage_error");

  constructor(reason: string) {
    super(reason);
    this.name = "CdpEndpointInputError";
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
    if (document.activeElement === el) states.push("focused");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") states.push("disabled");
    const ariaChecked = el.getAttribute("aria-checked");
    if (ariaChecked === "true" || ((el.type === "checkbox" || el.type === "radio") && el.checked === true)) states.push("checked");
    if (ariaChecked === "mixed") states.push("mixed");
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

function cancellableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

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

function invalidParameter<T>(
  transport: TransportKind,
  action: string,
  reason: string,
): Envelope<T> {
  return err({
    transport,
    step: 0,
    action,
    reason,
    suggestion: `inspect the ${action} input schema and retry`,
    retryable: false,
    exit_code: exitCodeFor("usage_error"),
  });
}

function readOptionalPath(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readSelectorFromStable(stable: unknown): string | undefined {
  if (typeof stable !== "string") return undefined;
  const prefix = stable.startsWith("cdp-browser:")
    ? "cdp-browser:"
    : stable.startsWith("cdp:")
      ? "cdp:"
      : undefined;
  if (!prefix) return undefined;
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

function rendererScope(endpoint?: CdpEndpoint): string {
  if (!endpoint?.webSocketDebuggerUrl) return "renderer";
  const digest = createHash("sha256")
    .update(endpoint.webSocketDebuggerUrl)
    .digest("hex")
    .slice(0, 16);
  return `renderer-${digest}`;
}

function bindRawAxScope(node: RawAxNode, scope: string): RawAxNode {
  return {
    ...node,
    scope,
    ...(node.children
      ? { children: node.children.map((child) => bindRawAxScope(child, scope)) }
      : {}),
  };
}

function settleCdpConnection(
  connection: Promise<IPage>,
  signal: AbortSignal,
): Promise<IPage> {
  signal.throwIfAborted();
  return new Promise<IPage>((resolve, reject) => {
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    connection.then(
      (page) => {
        if (settled) {
          void page.close().catch((error: unknown) => {
            process.emitWarning(
              `Late cancelled CDP connection cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              { code: "UNICLI_CDP_CANCEL_CLEANUP" },
            );
          });
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(page);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
