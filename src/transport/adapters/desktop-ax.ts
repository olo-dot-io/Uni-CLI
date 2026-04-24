/**
 * DesktopAxTransport — macOS Accessibility (AX) + AppleScript transport.
 *
 * Uses `osascript` and `pbcopy`/`pbpaste` shelled out via
 * `child_process.execFile` for focused-window / menu-select / clipboard /
 * app-launch primitives. On non-darwin hosts, `open()` resolves (so
 * capability queries still work) but `action()` always returns a
 * `service_unavailable` envelope with `minimum_capability: "desktop-ax.*"`
 * so self-repair can suggest a platform-native transport.
 *
 * Design contract:
 *  - `action()` NEVER throws
 *  - every platform-gated call emits a `69` (EX_UNAVAILABLE) envelope on
 *    Linux/Windows — the agent sees `minimum_capability: "desktop-ax.<v>"`
 *    and knows to route to desktop-uia / desktop-atspi / cua
 *  - the `execFile`-backed runner is replaceable via constructor injection
 *    so unit tests can mock it without spawning real osascript
 */

import { spawn } from "node:child_process";

import { err, exitCodeFor, ok } from "../../core/envelope.js";
import type { Envelope } from "../../core/envelope.js";
import {
  buildAxFocusedReadScript,
  buildAxPressScript,
  buildAxSetValueScript,
  buildAxSnapshotScript,
  buildElectronAxWarmupScript,
  hasAxElementMatcher,
  type AxPressScriptOptions,
  type AxSetValueScriptOptions,
  type AxWarmupResult,
  type ResolvedAxTarget,
  readAxElementQuery,
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
  "ax_focused_read",
  "ax_set_value",
  "ax_press",
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

/** Minimal shell abstraction so tests can mock `osascript`/`pbcopy` output. */
export interface AxShell {
  run(
    command: string,
    args: readonly string[],
    opts?: { input?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string }>;
}

/**
 * Default shell — spawns with piped stdio so we can feed stdin to
 * `pbcopy` and capture `pbpaste` output. 10s safety timeout.
 */
const defaultShell: AxShell = {
  run(command, args, opts) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: opts?.timeoutMs ?? 10_000,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
      child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
      child.on("error", reject);
      child.on("close", (code) => {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0) {
          reject(
            new Error(
              `${command} exited with code ${code}${stderr ? ": " + stderr.slice(0, 200) : ""}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      });
      if (opts?.input !== undefined) {
        child.stdin?.write(opts.input);
        child.stdin?.end();
      }
    });
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
}

interface CachedAxSession {
  result: AxWarmupResult;
  expiresAt: number;
}

const AX_SESSION_TTL_MS = 30_000;

export class DesktopAxTransport implements TransportAdapter {
  readonly kind: TransportKind = "desktop-ax";
  readonly capability: Capability = AX_CAPABILITY;

  private readonly shell: AxShell;
  private readonly platform: NodeJS.Platform;
  private lastClip: string | undefined;
  private lastAxSnapshot: Record<string, unknown> | undefined;
  private readonly warmSessions = new Map<string, CachedAxSession>();

  constructor(opts: DesktopAxTransportOptions = {}) {
    this.shell = opts.shell ?? defaultShell;
    this.platform = opts.platform ?? process.platform;
  }

  async open(_ctx: TransportContext): Promise<void> {
    // Intentionally non-fatal on non-darwin — capability queries must still
    // work so agents can see why the transport declined the step.
  }

  async snapshot(opts?: { format?: SnapshotFormat }): Promise<Snapshot> {
    const format = opts?.format ?? "os-ax";
    if (format === "text") {
      return { format: "text", data: this.lastClip ?? "" };
    }
    if (this.lastAxSnapshot) {
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
      if (!this.isDarwin()) {
        return err({
          transport: "desktop-ax",
          step: 0,
          action: req.kind,
          reason: `desktop-ax.${req.kind} is not available on ${this.platform}`,
          suggestion:
            this.platform === "win32"
              ? "route to desktop-uia or cua on Windows"
              : this.platform === "linux"
                ? "route to desktop-atspi or cua on Linux"
                : "run on macOS (darwin) for native AX + AppleScript",
          minimum_capability: `desktop-ax.${req.kind}`,
          exit_code: exitCodeFor("service_unavailable"),
        });
      }
      const envelope = await this.dispatch<T>(req);
      envelope.elapsedMs = Date.now() - start;
      return envelope;
    } catch (e) {
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
  ): Promise<Envelope<T> | null> {
    if (!target?.ensureElectronAx) return null;
    const cached = this.getWarmSession(target);
    if (cached?.found && cached.trusted) return null;

    try {
      const result = await this.runElectronAxWarmup(target, opts.waitMs ?? 0);
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
      if (!opts.strict) return null;
      return this.envelopeFromShellError(action, e);
    }
  }

  private async runElectronAxWarmup(
    target: ResolvedAxTarget,
    waitMs: number,
  ): Promise<AxWarmupResult> {
    const { stdout } = await this.shell.run(
      "swift",
      ["-e", buildElectronAxWarmupScript(target, waitMs)],
      { timeoutMs: Math.max(10_000, waitMs + 6_000) },
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
        return this.doAxFocus<T>(req.params);
      case "focus_window":
        return this.doAxFocus<T>(req.params);
      case "ax_menu_select":
        return this.doMenuSelect<T>(req.params);
      case "applescript":
        return this.doApplescript<T>(req.params);
      case "ax_snapshot":
        return this.doAxSnapshot<T>(req.params);
      case "ax_focused_read":
        return this.doAxFocusedRead<T>(req.params);
      case "ax_set_value":
        return this.doAxSetValue<T>(req.params);
      case "ax_press":
        return this.doAxPress<T>(req.params);
      case "clipboard_read":
        return this.doClipboardRead<T>();
      case "clipboard_write":
        return this.doClipboardWrite<T>(req.params);
      case "launch_app":
        return this.doLaunchApp<T>(req.params);
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
  ): Promise<Envelope<T>> {
    const target = resolveAxTarget(params);
    if (!target) return this.missingTargetParam("ax_focus");
    const script = `tell ${target.activationRef} to activate`;
    try {
      await this.shell.run("osascript", ["-e", script]);
      await this.maybeWarmupElectronAx("ax_focus", target, { waitMs: 500 });
      return ok({
        app: target.appName,
        bundleId: target.bundleId ?? null,
      } as unknown as T);
    } catch (e) {
      return this.envelopeFromShellError("ax_focus", e);
    }
  }

  private async doMenuSelect<T>(
    params: Record<string, unknown>,
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

    const warmupError = await this.maybeWarmupElectronAx<T>(
      "ax_menu_select",
      target,
      { strict: true, waitMs: 500 },
    );
    if (warmupError) return warmupError;

    // Build an AppleScript that walks the menu bar by name.
    // e.g. path = ["File", "Export", "Export as PNG"]
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
      await this.shell.run("osascript", ["-e", script]);
      return ok({
        app: target.appName,
        processName: target.uiProcessName,
        path,
      } as unknown as T);
    } catch (e) {
      return this.envelopeFromShellError("ax_menu_select", e);
    }
  }

  private async doApplescript<T>(
    params: Record<string, unknown>,
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
    );
    if (warmupError) return warmupError;

    try {
      const { stdout } = await this.shell.run("osascript", ["-e", script]);
      return ok({ stdout: stdout.trimEnd() } as unknown as T);
    } catch (e) {
      return this.envelopeFromShellError("applescript", e);
    }
  }

  private async doAxSnapshot<T>(
    params: Record<string, unknown>,
  ): Promise<Envelope<T>> {
    const target = resolveAxTarget(params);
    if (!target) return this.missingTargetParam("ax_snapshot");
    const maxDepth = readPositiveInt(params.maxDepth, 3);
    const scope =
      params.scope === "focusedElement" ? "focusedElement" : "focusedWindow";
    return this.runSwiftAxAction<T>(
      "ax_snapshot",
      target,
      buildAxSnapshotScript(target, { maxDepth, scope }),
    );
  }

  private async doAxFocusedRead<T>(
    params: Record<string, unknown>,
  ): Promise<Envelope<T>> {
    const target = resolveAxTarget(params);
    if (!target) return this.missingTargetParam("ax_focused_read");
    return this.runSwiftAxAction<T>(
      "ax_focused_read",
      target,
      buildAxFocusedReadScript(target, readAxElementQuery(params, true)),
    );
  }

  private async doAxSetValue<T>(
    params: Record<string, unknown>,
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
    return this.runSwiftAxAction<T>(
      "ax_set_value",
      target,
      buildAxSetValueScript(target, query),
    );
  }

  private async doAxPress<T>(
    params: Record<string, unknown>,
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
    return this.runSwiftAxAction<T>(
      "ax_press",
      target,
      buildAxPressScript(target, query),
    );
  }

  private async doClipboardRead<T>(): Promise<Envelope<T>> {
    try {
      const { stdout } = await this.shell.run("pbpaste", []);
      this.lastClip = stdout;
      return ok({ text: stdout } as unknown as T);
    } catch (e) {
      return this.envelopeFromShellError("clipboard_read", e);
    }
  }

  private async doClipboardWrite<T>(
    params: Record<string, unknown>,
  ): Promise<Envelope<T>> {
    const text = typeof params.text === "string" ? params.text : undefined;
    if (text === undefined) return this.missingParam("clipboard_write", "text");
    try {
      await this.shell.run("pbcopy", [], { input: text });
      this.lastClip = text;
      return ok({ bytes: Buffer.byteLength(text, "utf8") } as unknown as T);
    } catch (e) {
      return this.envelopeFromShellError("clipboard_write", e);
    }
  }

  private async doLaunchApp<T>(
    params: Record<string, unknown>,
  ): Promise<Envelope<T>> {
    const target = resolveAxTarget(params);
    if (!target) return this.missingTargetParam("launch_app");
    try {
      await this.shell.run("open", [...target.openArgs]);
      await this.maybeWarmupElectronAx("launch_app", target, { waitMs: 2_000 });
      return ok({
        app: target.appName,
        bundleId: target.bundleId ?? null,
      } as unknown as T);
    } catch (e) {
      return this.envelopeFromShellError("launch_app", e);
    }
  }

  private async runSwiftAxAction<T>(
    action: string,
    target: ResolvedAxTarget,
    script: string,
  ): Promise<Envelope<T>> {
    const warmupError = await this.maybeWarmupElectronAx<T>(action, target, {
      strict: true,
      waitMs: 500,
    });
    if (warmupError) return warmupError;

    try {
      const { stdout } = await this.shell.run("swift", ["-e", script], {
        timeoutMs: 10_000,
      });
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
          exit_code: exitCodeFor("service_unavailable"),
        });
      }

      if (result.matched === false) {
        return err({
          transport: "desktop-ax",
          step: 0,
          action,
          reason: `no matching accessibility element found in ${target.appName}`,
          suggestion:
            "focus the target control first, or pass role/title/description filters that match the target element",
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
        this.lastAxSnapshot = result.element;
      }
      return ok(result as unknown as T);
    } catch (e) {
      return this.envelopeFromShellError(action, e);
    }
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
}

/**
 * Escape an AppleScript string literal. Neutralises four distinct hazards:
 *   1. `\`   — backslash: must come first so subsequent replacements don't
 *              double-escape our own injected escapes.
 *   2. `"`   — quote: would otherwise close the string literal early.
 *   3. `\r` / `\n` — CR/LF: AppleScript treats these as statement terminators
 *              inside `-e` arguments. An attacker-controlled `app` name like
 *              `Calculator"\nos_command("rm -rf /")` can smuggle new
 *              commands; fold them to spaces so the statement stays on one line.
 *   4. NUL   — `\0`: osascript aborts parsing at NUL, leaving the tail
 *              unexecuted — trim to avoid surprising partial-execution bugs.
 */
function escapeAs(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]/g, " ")
    .replaceAll("\0", "");
}
