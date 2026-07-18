/**
 * @owner       src::transport::adapters::desktop-ax
 * @does        Execute macOS Accessibility, AppleScript, clipboard, launch, and screenshot actions through request-contained native processes.
 * @needs       Swift AX generators, app control policy, cancellable shell, transactional file publication
 * @feeds       compute cascade and direct desktop-ax transport callers
 * @breaks      Returning cancellation before native children exit, losing post-dispatch ambiguity, or overwriting fulfilled native mutations permits unsafe replay.
 * @invariants  Native mutation settlement is authoritative; cancellation-caused rejection after dispatch is outcome-ambiguous; app-targeted screenshots bind one AX window to one exact CoreGraphics window id instead of sampling an occluded screen region; screenshot destinations change only at atomic commit.
 * @side-effects Can focus apps, mutate accessibility elements, post input, use the clipboard, launch apps, and create screenshot artifacts.
 * @perf        Swift compilation is content-addressed and cached; each action uses at most one native child after warmup.
 * @concurrency AbortSignal is request-local; detached process groups prevent descendants from escaping cancellation.
 * @test        tests/unit/transport/adapters/desktop-ax.test.ts and native compute cancellation blackboxes
 * @stability   stable
 * @since       2026-07-15
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { err, exitCodeFor, ok } from "../../core/envelope.js";
import { publishFileTransactionally } from "../../engine/transactional-file.js";
import { resolveAppControlPolicy } from "../../electron-apps.js";
import type { Envelope } from "../../core/envelope.js";
import { settleDispatchedAction } from "../action-settlement.js";
import {
  isOperationOutcomeAmbiguousError,
  runContainedProcess,
} from "../contained-process.js";
import { RefAllocator } from "../refs.js";
import { encodeSnapshot, type SnapshotEncoding } from "../snapshot-encoder.js";
import {
  runAxBackgroundClick,
  runAxBackgroundPress,
  runAxBackgroundType,
} from "./desktop-ax-background-input.js";
import {
  ensureSwiftScriptBinary,
  escapeAs,
  launchOpenArgs,
  normalizeAxSnapshot,
  readAxWindowsFilter,
  readStringParam,
} from "./desktop-ax-helpers.js";
import {
  buildAxAppsScript,
  buildAxFocusedReadScript,
  buildAxPressScript,
  buildAxScrollScript,
  buildAxSetValueScript,
  buildAxSnapshotScript,
  buildAxWindowsScript,
  buildElectronAxWarmupScript,
  hasAxElementMatcher,
  type AxPressScriptOptions,
  type AxScrollScriptOptions,
  type AxSetValueScriptOptions,
  type AxWarmupResult,
  type ResolvedAxTarget,
  readAxElementQuery,
  readAxWindowId,
  readPositiveInt,
  resolveAxTarget,
} from "./desktop-ax-swift.js";
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

const AX_STEPS = [
  "ax_focus",
  "ax_menu_select",
  "applescript",
  "ax_snapshot",
  "ax_apps",
  "ax_windows",
  "ax_focused_read",
  "ax_set_value",
  "ax_press",
  "ax_scroll",
  "ax_screenshot",
  "ax_background_click",
  "ax_background_type",
  "ax_background_press",
  "clipboard_read",
  "clipboard_write",
  "launch_app",
  "focus_window",
] as const;

const AX_CAPABILITY: Capability = {
  steps: AX_STEPS,
  snapshotFormats: ["os-ax", "text"] as readonly SnapshotFormat[],
  platforms: ["darwin"] as const,
  mutatesHost: true,
};

const AX_READ_ONLY_ACTIONS = new Set([
  "ax_snapshot",
  "ax_apps",
  "ax_windows",
  "ax_focused_read",
  "ax_screenshot",
  "clipboard_read",
]);

/** Minimal shell abstraction so tests can mock `osascript`/`pbcopy` output. */
export interface AxShell {
  run(
    command: string,
    args: readonly string[],
    opts?: {
      input?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      cancellationDelivery?: "contained" | "outcome-ambiguous";
    },
  ): Promise<{ stdout: string; stderr: string }>;
}

/**
 * Default shell — spawns with piped stdio so we can feed stdin to
 * `pbcopy` and capture `pbpaste` output. 10s safety timeout.
 */
const defaultShell: AxShell = {
  async run(command, args, opts) {
    const result = await runContainedProcess(command, args, {
      ...(opts?.input === undefined ? {} : { input: opts.input }),
      timeoutMs: opts?.timeoutMs ?? 10_000,
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.cancellationDelivery
        ? { cancellationDelivery: opts.cancellationDelivery }
        : {}),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `${command} exited with code ${String(result.exitCode)}${result.stderr ? ": " + result.stderr.slice(0, 200) : ""}`,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  },
};

export interface DesktopAxTransportOptions {
  shell?: AxShell;
  /** Overridden in tests — defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

interface AxElementCommandResult {
  found: boolean;
  matched?: boolean;
  mode?: string;
  scope?: string;
  bundleId?: string | null;
  localizedName?: string | null;
  attribute?: string;
  action?: string;
  result?: number;
  element?: Record<string, unknown>;
  failure?:
    | "window_not_found"
    | "window_ambiguous"
    | "stale_path"
    | "element_not_found";
}

interface CachedAxSession {
  result: AxWarmupResult;
  expiresAt: number;
}

const AX_SESSION_TTL_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class DesktopAxTransport implements TransportAdapter {
  readonly kind: TransportKind = "desktop-ax";
  readonly capability: Capability = AX_CAPABILITY;

  private readonly shell: AxShell;
  private readonly platform: NodeJS.Platform;
  private lastClip: string | undefined;
  private lastAxSnapshot: Record<string, unknown> | undefined;
  private refs: TransportContext["refs"] | undefined;
  private readonly warmSessions = new Map<string, CachedAxSession>();

  constructor(opts: DesktopAxTransportOptions = {}) {
    this.shell = opts.shell ?? defaultShell;
    this.platform = opts.platform ?? process.platform;
  }

  async open(ctx: TransportContext): Promise<void> {
    this.refs = ctx.refs ?? ctx.bus.refs;
    // Intentionally non-fatal on non-darwin — capability queries must still
    // work so agents can see why the transport declined the step.
  }

  async snapshot(opts?: {
    format?: SnapshotFormat | SnapshotEncoding;
    signal?: AbortSignal;
  }): Promise<Snapshot> {
    opts?.signal?.throwIfAborted();
    const format = opts?.format ?? "os-ax";
    if (format === "text") {
      return { format: "text", data: this.lastClip ?? "" };
    }
    if (this.lastAxSnapshot) {
      if (format === "compact" || format === "tree" || format === "json") {
        const raw = normalizeAxSnapshot(this.lastAxSnapshot);
        const alloc = new RefAllocator();
        const { encoded, refCount } = encodeSnapshot(raw, {
          format,
          transport: this.kind,
          alloc,
        });
        this.refs?.put(alloc.freeze(this.kind, raw.scope));
        if (format === "json") {
          return {
            format: "json",
            encoding: "json",
            data: encoded,
            refs: { count: refCount, scope: raw.scope },
          };
        }
        return {
          format: "text",
          encoding: format,
          data: encoded,
          refs: { count: refCount, scope: raw.scope },
        };
      }
      return {
        format: "json",
        data: JSON.stringify(this.lastAxSnapshot),
      };
    }
    return {
      format: "json",
      data: JSON.stringify({
        platform: this.platform,
        available: this.isDarwin(),
      }),
    };
  }

  async action<T = unknown>(req: ActionRequest): Promise<ActionResult<T>> {
    const start = Date.now();
    try {
      req.signal?.throwIfAborted();
      if (!this.isDarwin()) {
        return err({
          transport: "desktop-ax",
          step: 0,
          action: req.kind,
          reason: `desktop-ax.${req.kind} is not available on ${this.platform}`,
          suggestion:
            this.platform === "win32"
              ? "route to desktop-uia or visual on Windows"
              : this.platform === "linux"
                ? "route to desktop-atspi or visual on Linux"
                : "run on macOS (darwin) for native AX + AppleScript",
          minimum_capability: `desktop-ax.${req.kind}`,
          exit_code: exitCodeFor("service_unavailable"),
        });
      }
      if (
        req.params.windowId !== undefined &&
        readAxWindowId(req.params.windowId) === undefined
      ) {
        return err({
          transport: "desktop-ax",
          step: 0,
          action: req.kind,
          reason:
            "windowId must be a positive decimal CoreGraphics window id no greater than 4294967295",
          suggestion:
            "pass the numeric windowId reported by `unicli compute windows --app <app>`",
          minimum_capability: `desktop-ax.${req.kind}.invalid_input`,
          exit_code: exitCodeFor("usage_error"),
        });
      }
      const envelope = await settleDispatchedAction(
        req.kind,
        req.canMutate ?? !AX_READ_ONLY_ACTIONS.has(req.kind),
        req.signal,
        () => this.dispatch<T>(req),
      );
      envelope.elapsedMs = Date.now() - start;
      return envelope;
    } catch (e) {
      if (isOperationOutcomeAmbiguousError(e)) throw e;
      req.signal?.throwIfAborted();
      const msg = e instanceof Error ? e.message : String(e);
      return err({
        transport: "desktop-ax",
        step: 0,
        action: req.kind,
        reason: `unexpected error in desktop-ax.${req.kind}: ${msg}`,
        suggestion: "inspect AppleScript syntax or app availability",
        retryable: false,
      });
    }
  }

  async close(): Promise<void> {
    this.lastClip = undefined;
    this.lastAxSnapshot = undefined;
    this.warmSessions.clear();
  }

  // ── internals ────────────────────────────────────────────────────────

  private isDarwin(): boolean {
    return this.platform === "darwin";
  }

  private missingTargetParam<T>(action: string): Envelope<T> {
    return err({
      transport: "desktop-ax",
      step: 0,
      action,
      reason: "missing target app (`app`, `bundleId`, or `processName`)",
      suggestion:
        "pass params.app, or supply params.bundleId / params.processName for localized Electron apps",
      exit_code: exitCodeFor("usage_error"),
    });
  }

  private warmSessionKey(target: ResolvedAxTarget): string {
    return target.bundleId || target.processName;
  }

  private getWarmSession(target: ResolvedAxTarget): AxWarmupResult | null {
    const key = this.warmSessionKey(target);
    const cached = this.warmSessions.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.warmSessions.delete(key);
      return null;
    }
    return cached.result;
  }

  private rememberWarmSession(
    target: ResolvedAxTarget,
    result: AxWarmupResult,
  ): void {
    this.warmSessions.set(this.warmSessionKey(target), {
      result,
      expiresAt: Date.now() + AX_SESSION_TTL_MS,
    });
  }

  private async maybeWarmupElectronAx<T>(
    action: string,
    target: ResolvedAxTarget | null,
    opts: { strict?: boolean; waitMs?: number } = {},
    signal?: AbortSignal,
  ): Promise<Envelope<T> | null> {
    signal?.throwIfAborted();
    if (!target?.ensureElectronAx) return null;
    const cached = this.getWarmSession(target);
    if (cached?.found && cached.trusted) return null;

    try {
      const result = await this.runElectronAxWarmup(
        target,
        opts.waitMs ?? 0,
        signal,
      );
      if (result.found && result.trusted) {
        this.rememberWarmSession(target, result);
      }
      if (result.found && result.trusted) return null;
      if (!opts.strict) return null;

      if (!result.trusted) {
        return err({
          transport: "desktop-ax",
          step: 0,
          action,
          reason:
            `Electron/Chromium AX warmup requires macOS Accessibility access ` +
            `before driving ${target.appName}`,
          suggestion:
            "grant Accessibility to the host app (Terminal, Codex, Claude Code, etc.) in " +
            "System Settings → Privacy & Security → Accessibility, then retry",
          exit_code: exitCodeFor("service_unavailable"),
        });
      }

      return err({
        transport: "desktop-ax",
        step: 0,
        action,
        reason: `target app is not running: ${target.appName}`,
        suggestion: target.bundleId
          ? `launch the app first, or run open -b ${target.bundleId}`
          : `launch the app first, or run open -a "${target.appName}"`,
        exit_code: exitCodeFor("service_unavailable"),
      });
    } catch (e) {
      signal?.throwIfAborted();
      if (!opts.strict) return null;
      return this.envelopeFromShellError(action, e);
    }
  }

  private async runElectronAxWarmup(
    target: ResolvedAxTarget,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<AxWarmupResult> {
    const { stdout } = await this.runSwiftScript(
      buildElectronAxWarmupScript(target, waitMs),
      Math.max(10_000, waitMs + 6_000),
      signal,
    );
    const raw = stdout.trim();
    if (!raw) {
      throw new Error("swift AX warmup produced no output");
    }
    return JSON.parse(raw) as AxWarmupResult;
  }

  private async dispatch<T>(req: ActionRequest): Promise<Envelope<T>> {
    switch (req.kind) {
      case "ax_focus":
        return this.doAxFocus<T>(req.params, req.signal);
      case "focus_window":
        return this.doAxFocus<T>(req.params, req.signal);
      case "ax_menu_select":
        return this.doMenuSelect<T>(req.params, req.signal);
      case "applescript":
        return this.doApplescript<T>(req.params, req.signal);
      case "ax_snapshot":
        return this.doAxSnapshot<T>(req.params, req.signal);
      case "ax_apps":
        return this.doAxApps<T>(req.signal);
      case "ax_windows":
        return this.doAxWindows<T>(req.params, req.signal);
      case "ax_focused_read":
        return this.doAxFocusedRead<T>(req.params, req.signal);
      case "ax_set_value":
        return this.doAxSetValue<T>(req.params, req.signal);
      case "ax_press":
        return this.doAxPress<T>(req.params, req.signal);
      case "ax_scroll":
        return this.doAxScroll<T>(req.params, req.signal);
      case "ax_screenshot":
        return this.doAxScreenshot<T>(req.params, req.signal);
      case "ax_background_click":
        return this.doAxBackgroundClick<T>(req.params, req.signal);
      case "ax_background_type":
        return this.doAxBackgroundType<T>(req.params, req.signal);
      case "ax_background_press":
        return this.doAxBackgroundPress<T>(req.params, req.signal);
      case "clipboard_read":
        return this.doClipboardRead<T>(req.signal);
      case "clipboard_write":
        return this.doClipboardWrite<T>(req.params, req.signal);
      case "launch_app":
        return this.doLaunchApp<T>(req.params, req.signal);
      default:
        return err({
          transport: "desktop-ax",
          step: 0,
          action: req.kind,
          reason: `unsupported action "${req.kind}" for desktop-ax transport`,
          suggestion: `desktop-ax transport supports: ${AX_STEPS.join(", ")}`,
          minimum_capability: `desktop-ax.${req.kind}`,
          exit_code: exitCodeFor("usage_error"),
        });
    }
  }

  private missingParam<T>(action: string, paramName: string): Envelope<T> {
    return err({
      transport: "desktop-ax",
      step: 0,
      action,
      reason: `missing required param \`${paramName}\``,
      suggestion: `pass params.${paramName} to the ${action} action`,
      exit_code: exitCodeFor("usage_error"),
    });
  }

  private async doAxFocus<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const target = resolveAxTarget(params);
    if (!target) return this.missingTargetParam("ax_focus");
    const script = `tell ${target.activationRef} to activate`;
    try {
      await this.shell.run("osascript", ["-e", script], {
        signal,
        cancellationDelivery: "outcome-ambiguous",
      });
      if (!signal?.aborted) {
        await this.maybeWarmupElectronAx(
          "ax_focus",
          target,
          { waitMs: 500 },
          signal,
        );
      }
      return ok({
        app: target.appName,
        bundleId: target.bundleId ?? null,
      } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromShellError("ax_focus", e);
    }
  }

  private async doMenuSelect<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const target = resolveAxTarget(params);
    const path = Array.isArray(params.path)
      ? (params.path as unknown[]).map(String)
      : typeof params.path === "string"
        ? params.path.split(/\s*>\s*|\s*→\s*/).filter(Boolean)
        : undefined;
    if (!target) return this.missingTargetParam("ax_menu_select");
    if (!path || path.length === 0)
      return this.missingParam("ax_menu_select", "path");

    const policy = resolveAppControlPolicy(
      target.bundleId ?? target.processName,
    );
    const shouldWarmup =
      params.ensureElectronAx === true ||
      (target.ensureElectronAx &&
        (policy.inspectionOrder[0] === "cdp-dom" ||
          policy.backgroundClick.enabled));
    if (shouldWarmup) {
      const warmupError = await this.maybeWarmupElectronAx<T>(
        "ax_menu_select",
        target,
        { strict: true, waitMs: 500 },
        signal,
      );
      if (warmupError) return warmupError;
    }

    const items = path.map((s) => `"${escapeAs(s)}"`).join(", ");
    const script = [
      `tell application "System Events"`,
      `  tell process "${escapeAs(target.uiProcessName)}"`,
      `    set menuPath to {${items}}`,
      `    set theMenuBar to menu bar 1`,
      `    set currentItem to menu bar item (item 1 of menuPath) of theMenuBar`,
      `    click currentItem`,
      `    repeat with i from 2 to count of menuPath`,
      `      set currentItem to menu item (item i of menuPath) of menu 1 of currentItem`,
      `      click currentItem`,
      `    end repeat`,
      `  end tell`,
      `end tell`,
    ].join("\n");
    try {
      await this.shell.run("osascript", ["-e", script], {
        signal,
        cancellationDelivery: "outcome-ambiguous",
      });
      return ok({
        app: target.appName,
        processName: target.uiProcessName,
        path,
      } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromShellError("ax_menu_select", e);
    }
  }

  private async doApplescript<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const script =
      typeof params.script === "string"
        ? params.script
        : typeof params.source === "string"
          ? params.source
          : undefined;
    if (!script) return this.missingParam("applescript", "script");

    const target = resolveAxTarget(params);
    const warmupError = await this.maybeWarmupElectronAx<T>(
      "applescript",
      target,
      { strict: true, waitMs: 500 },
      signal,
    );
    if (warmupError) return warmupError;

    try {
      const { stdout } = await this.shell.run("osascript", ["-e", script], {
        signal,
        cancellationDelivery: "outcome-ambiguous",
      });
      return ok({ stdout: stdout.trimEnd() } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromShellError("applescript", e);
    }
  }

  private async doAxSnapshot<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const target = resolveAxTarget(params);
    if (!target) return this.missingTargetParam("ax_snapshot");
    const maxDepth = readPositiveInt(params.maxDepth, 3);
    const scope =
      params.scope === "focusedElement" ? "focusedElement" : "focusedWindow";
    return this.runSwiftAxAction<T>(
      "ax_snapshot",
      target,
      buildAxSnapshotScript(target, {
        maxDepth,
        scope,
        windowId: readAxWindowId(params.windowId),
      }),
      signal,
    );
  }

  private async doAxApps<T>(signal?: AbortSignal): Promise<Envelope<T>> {
    return this.runSwiftJsonAction<T>("ax_apps", buildAxAppsScript(), signal);
  }

  private async doAxWindows<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    return this.runSwiftJsonAction<T>(
      "ax_windows",
      buildAxWindowsScript(readAxWindowsFilter(params)),
      signal,
    );
  }

  private async doAxFocusedRead<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const target = resolveAxTarget(params);
    if (!target) return this.missingTargetParam("ax_focused_read");
    return this.runSwiftAxAction<T>(
      "ax_focused_read",
      target,
      buildAxFocusedReadScript(target, readAxElementQuery(params, true)),
      signal,
    );
  }

  private async doAxSetValue<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const target = resolveAxTarget(params);
    if (!target) return this.missingTargetParam("ax_set_value");
    const value =
      typeof params.value === "string"
        ? params.value
        : typeof params.text === "string"
          ? params.text
          : undefined;
    if (value === undefined) return this.missingParam("ax_set_value", "value");
    const query: AxSetValueScriptOptions = {
      ...readAxElementQuery(params, true),
      attribute:
        typeof params.attribute === "string" && params.attribute.trim()
          ? params.attribute.trim()
          : "AXValue",
      value,
    };
    const semantic = await this.runSwiftAxAction<T>(
      "ax_set_value",
      target,
      buildAxSetValueScript(target, query),
      signal,
    );
    if (
      semantic.ok ||
      params.focus === true ||
      (typeof params.text !== "string" && typeof params.value !== "string") ||
      typeof params.x !== "number" ||
      typeof params.y !== "number"
    ) {
      return semantic;
    }
    return this.backgroundFallback<T>(
      semantic,
      await this.doAxBackgroundType<T>({ ...params, text: value }, signal),
      "ax_set_value",
    );
  }

  private async doAxPress<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const target = resolveAxTarget(params);
    if (!target) return this.missingTargetParam("ax_press");
    const hasMatcher = hasAxElementMatcher(params);
    const query: AxPressScriptOptions = {
      ...readAxElementQuery(params, !hasMatcher),
      actionName:
        typeof params.action === "string" && params.action.trim()
          ? params.action.trim()
          : "AXPress",
    };
    const keyCombo =
      typeof params.combo === "string"
        ? params.combo
        : typeof params.key === "string"
          ? params.key
          : undefined;
    if (
      keyCombo &&
      !hasMatcher &&
      params.action === undefined &&
      params.focus !== true
    ) {
      return this.doAxBackgroundPress<T>({ ...params, key: keyCombo }, signal);
    }

    const semantic = await this.runSwiftAxAction<T>(
      "ax_press",
      target,
      buildAxPressScript(target, query),
      signal,
    );
    if (
      semantic.ok ||
      params.focus === true ||
      typeof params.x !== "number" ||
      typeof params.y !== "number"
    ) {
      return semantic;
    }
    return this.backgroundFallback<T>(
      semantic,
      await this.doAxBackgroundClick<T>(params, signal),
      "ax_press",
    );
  }

  private async doAxScroll<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const target = resolveAxTarget(params);
    if (!target) return this.missingTargetParam("ax_scroll");
    const hasMatcher = hasAxElementMatcher(params);
    const query: AxScrollScriptOptions = {
      ...readAxElementQuery(params, !hasMatcher),
      actionName:
        typeof params.action === "string" && params.action.trim()
          ? params.action.trim()
          : "AXScrollToVisible",
    };
    return this.runSwiftAxAction<T>(
      "ax_scroll",
      target,
      buildAxScrollScript(target, query),
      signal,
    );
  }

  private async doAxScreenshot<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const target = resolveAxTarget(params);
    let bounds = readScreenshotBounds(params);
    let windowId = readAxWindowId(params.windowId);
    if (target) {
      const observed = await this.doAxSnapshot<AxElementCommandResult>(
        { ...params, maxDepth: 1 },
        signal,
      );
      if (!observed.ok) return observed as Envelope<T>;
      bounds = this.lastAxSnapshot
        ? normalizeAxSnapshot(this.lastAxSnapshot).bounds
        : undefined;
      windowId = this.lastAxSnapshot
        ? readAxWindowId(this.lastAxSnapshot.windowId)
        : undefined;
      if (windowId === undefined) {
        return err({
          transport: "desktop-ax",
          step: 0,
          action: "ax_screenshot",
          reason: `an exact on-screen window id is unavailable for ${target.appName}`,
          suggestion:
            "restore the target window and retry after it appears in `unicli compute windows --app <name>`",
          minimum_capability: "desktop-ax.ax_screenshot.target_window",
          exit_code: exitCodeFor("service_unavailable"),
        });
      }
    }
    const captureArgs = (path: string): string[] => [
      "-x",
      "-t",
      "png",
      ...(windowId !== undefined
        ? ["-o", `-l${String(windowId)}`]
        : bounds
          ? [
              `-R${String(Math.trunc(bounds.x))},${String(Math.trunc(bounds.y))},${String(Math.trunc(bounds.w))},${String(Math.trunc(bounds.h))}`,
            ]
          : []),
      path,
    ];
    const path = readStringParam(params.path);
    if (path) {
      try {
        await publishFileTransactionally(
          path,
          async (temporaryPath) => {
            await this.shell.run("screencapture", captureArgs(temporaryPath), {
              timeoutMs: 10_000,
              signal,
            });
          },
          { signal },
        );
        return ok({
          path,
          mime: "image/png",
          ...(windowId !== undefined
            ? { scope: "window", windowId, ...(bounds ? { bounds } : {}) }
            : bounds
              ? { scope: "window_bounds", bounds }
              : {}),
        } as unknown as T);
      } catch (e) {
        signal?.throwIfAborted();
        return this.envelopeFromShellError("ax_screenshot", e);
      }
    }

    const dir = await mkdtemp(join(tmpdir(), "unicli-ax-screenshot-"));
    const file = join(dir, "capture.png");
    try {
      await this.shell.run("screencapture", captureArgs(file), {
        timeoutMs: 10_000,
        signal,
      });
      signal?.throwIfAborted();
      const buffer = await readFile(file, signal ? { signal } : undefined);
      signal?.throwIfAborted();
      return ok({
        base64: buffer.toString("base64"),
        mime: "image/png",
        bytes: buffer.length,
        ...(windowId !== undefined
          ? { scope: "window", windowId, ...(bounds ? { bounds } : {}) }
          : bounds
            ? { scope: "window_bounds", bounds }
            : {}),
      } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromShellError("ax_screenshot", e);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async doAxBackgroundClick<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    return runAxBackgroundClick<T>(this.shell, params, signal);
  }

  private async doAxBackgroundType<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    return runAxBackgroundType<T>(this.shell, params, signal);
  }

  private async doAxBackgroundPress<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    return runAxBackgroundPress<T>(this.shell, params, signal);
  }

  private async doClipboardRead<T>(signal?: AbortSignal): Promise<Envelope<T>> {
    try {
      const { stdout } = await this.shell.run("pbpaste", [], { signal });
      this.lastClip = stdout;
      return ok({ text: stdout } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromShellError("clipboard_read", e);
    }
  }

  private async doClipboardWrite<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const text = typeof params.text === "string" ? params.text : undefined;
    if (text === undefined) return this.missingParam("clipboard_write", "text");
    try {
      await this.shell.run("pbcopy", [], {
        input: text,
        signal,
        cancellationDelivery: "outcome-ambiguous",
      });
      this.lastClip = text;
      return ok({ bytes: Buffer.byteLength(text, "utf8") } as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromShellError("clipboard_write", e);
    }
  }

  private async doLaunchApp<T>(
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const target = resolveAxTarget(params);
    if (!target) return this.missingTargetParam("launch_app");
    try {
      await this.shell.run("open", launchOpenArgs(target, params), {
        signal,
        cancellationDelivery: "outcome-ambiguous",
      });
      if (!signal?.aborted) {
        await this.maybeWarmupElectronAx(
          "launch_app",
          target,
          { waitMs: 2_000 },
          signal,
        );
      }
      return ok({
        app: target.appName,
        bundleId: target.bundleId ?? null,
      } as unknown as T);
    } catch (e) {
      if (isOperationOutcomeAmbiguousError(e)) throw e;
      signal?.throwIfAborted();
      return this.envelopeFromShellError("launch_app", e);
    }
  }

  private async runSwiftAxAction<T>(
    action: string,
    target: ResolvedAxTarget,
    script: string,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    const warmupError = await this.maybeWarmupElectronAx<T>(
      action,
      target,
      {
        strict: true,
        waitMs: 500,
      },
      signal,
    );
    if (warmupError) return warmupError;

    try {
      const { stdout } = await this.runSwiftScript(
        script,
        10_000,
        signal,
        "outcome-ambiguous",
      );
      const raw = stdout.trim();
      if (!raw) {
        throw new Error("swift AX action produced no output");
      }
      const result = JSON.parse(raw) as AxElementCommandResult;

      if (!result.found) {
        this.warmSessions.delete(this.warmSessionKey(target));
        return err({
          transport: "desktop-ax",
          step: 0,
          action,
          reason: `target app is not running: ${target.appName}`,
          suggestion: target.bundleId
            ? `launch the app first, or run open -b ${target.bundleId}`
            : `launch the app first, or run open -a "${target.appName}"`,
          minimum_capability: `desktop-ax.${action}.target_not_found`,
          exit_code: exitCodeFor("service_unavailable"),
        });
      }

      if (result.matched === false) {
        const exactFailure = axMatchFailure(
          action,
          target.appName,
          result.failure,
        );
        if (exactFailure) return exactFailure as Envelope<T>;
        return err({
          transport: "desktop-ax",
          step: 0,
          action,
          reason: `no matching accessibility element found in ${target.appName}`,
          suggestion:
            "focus the target control first, or pass role/title/description filters that match the target element",
          minimum_capability: `desktop-ax.${action}.no_element`,
          exit_code: exitCodeFor("service_unavailable"),
        });
      }

      if (typeof result.result === "number" && result.result !== 0) {
        return err({
          transport: "desktop-ax",
          step: 0,
          action,
          reason: `${action} failed with AXError code ${result.result}`,
          suggestion:
            "verify the target element exposes the requested AX attribute/action and that the app is Accessibility-enabled",
          exit_code: exitCodeFor("service_unavailable"),
        });
      }

      if (result.element) {
        this.lastAxSnapshot = {
          ...result.element,
          app:
            typeof result.element.app === "string"
              ? result.element.app
              : target.appName,
          ...(target.bundleId ? { bundleId: target.bundleId } : {}),
        };
      }
      return ok(result as unknown as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromShellError(action, e);
    }
  }

  private async runSwiftJsonAction<T>(
    action: string,
    script: string,
    signal?: AbortSignal,
  ): Promise<Envelope<T>> {
    try {
      const { stdout } = await this.runSwiftScript(script, 10_000, signal);
      const raw = stdout.trim();
      if (!raw) {
        throw new Error("swift AX action produced no output");
      }
      return ok(JSON.parse(raw) as T);
    } catch (e) {
      signal?.throwIfAborted();
      return this.envelopeFromShellError(action, e);
    }
  }

  private backgroundFallback<T>(
    semantic: Envelope<T>,
    fallback: Envelope<T>,
    semanticAction: string,
  ): Envelope<T> {
    if (semantic.ok || !fallback.ok || !isRecord(fallback.data)) {
      return fallback;
    }
    return ok({
      ...fallback.data,
      semanticFallback: semanticAction,
      semanticError: semantic.error.reason,
    } as unknown as T);
  }

  private envelopeFromShellError<T>(action: string, e: unknown): Envelope<T> {
    const msg = e instanceof Error ? e.message : String(e);
    const timeout = /timeout|timed out|ETIMEDOUT/i.test(msg);
    return err({
      transport: "desktop-ax",
      step: 0,
      action,
      reason: msg,
      suggestion:
        "check app name, AppleScript permissions (System Settings → Privacy & Security → Automation), and that the app is installed",
      retryable: timeout,
      exit_code: timeout
        ? exitCodeFor("temp_failure")
        : exitCodeFor("service_unavailable"),
    });
  }

  private async runSwiftScript(
    script: string,
    timeoutMs: number,
    signal?: AbortSignal,
    cancellationDelivery?: "contained" | "outcome-ambiguous",
  ): Promise<{ stdout: string; stderr: string }> {
    signal?.throwIfAborted();
    if (signal || !this.shouldUseSwiftScriptCache()) {
      return this.shell.run("swift", ["-e", script], {
        timeoutMs,
        signal,
        cancellationDelivery,
      });
    }

    const binary = await ensureSwiftScriptBinary(script, this.shell);
    return await this.shell.run(binary, [], {
      timeoutMs,
      signal,
      cancellationDelivery,
    });
  }

  private shouldUseSwiftScriptCache(): boolean {
    return (
      this.shell === defaultShell &&
      this.isDarwin() &&
      process.env.UNICLI_AX_SWIFT_CACHE !== "0"
    );
  }
}

function axMatchFailure(
  action: string,
  appName: string,
  failure: AxElementCommandResult["failure"],
): Envelope<never> | undefined {
  if (failure === "window_not_found") {
    return err({
      transport: "desktop-ax",
      step: 0,
      action,
      reason: `the exact accessibility window is no longer available in ${appName}`,
      suggestion:
        "run `unicli compute windows --app <app>` and bind the current windowId",
      minimum_capability: `desktop-ax.${action}.target_window_not_found`,
      exit_code: exitCodeFor("empty_result"),
    });
  }
  if (failure === "window_ambiguous") {
    return err({
      transport: "desktop-ax",
      step: 0,
      action,
      reason: `the exact accessibility window identity is ambiguous in ${appName}`,
      suggestion:
        "refresh the window inventory; do not retry against an ambiguous native id",
      minimum_capability: `desktop-ax.${action}.target_window_ambiguous`,
      exit_code: exitCodeFor("service_unavailable"),
    });
  }
  if (failure === "stale_path") {
    return err({
      transport: "desktop-ax",
      step: 0,
      action,
      reason: `the accessibility traversal path is stale in ${appName}`,
      suggestion: "take a fresh snapshot and use the replacement stable ref",
      minimum_capability: `desktop-ax.${action}.stale_ref`,
      exit_code: exitCodeFor("empty_result"),
    });
  }
  return undefined;
}

function readScreenshotBounds(
  params: Record<string, unknown>,
): { x: number; y: number; w: number; h: number } | undefined {
  if (!isRecord(params.bounds)) return undefined;
  const { x, y, w, h } = params.bounds;
  return typeof x === "number" &&
    Number.isFinite(x) &&
    typeof y === "number" &&
    Number.isFinite(y) &&
    typeof w === "number" &&
    Number.isFinite(w) &&
    w > 0 &&
    typeof h === "number" &&
    Number.isFinite(h) &&
    h > 0
    ? { x, y, w, h }
    : undefined;
}
