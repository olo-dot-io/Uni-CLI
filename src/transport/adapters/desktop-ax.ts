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

export class DesktopAxTransport implements TransportAdapter {
  readonly kind: TransportKind = "desktop-ax";
  readonly capability: Capability = AX_CAPABILITY;

  private readonly shell: AxShell;
  private readonly platform: NodeJS.Platform;
  private lastClip: string | undefined;

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
    // AX tree capture is out of scope for v0.212 — return the last clipboard
    // or the platform gate info so callers always get a uniform shape.
    if (format === "text") {
      return { format: "text", data: this.lastClip ?? "" };
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
  }

  // ── internals ────────────────────────────────────────────────────────

  private isDarwin(): boolean {
    return this.platform === "darwin";
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
    const app = typeof params.app === "string" ? params.app : undefined;
    if (!app) return this.missingParam("ax_focus", "app");
    const script = `tell application "${escapeAs(app)}" to activate`;
    try {
      await this.shell.run("osascript", ["-e", script]);
      return ok({ app } as unknown as T);
    } catch (e) {
      return this.envelopeFromShellError("ax_focus", e);
    }
  }

  private async doMenuSelect<T>(
    params: Record<string, unknown>,
  ): Promise<Envelope<T>> {
    const app = typeof params.app === "string" ? params.app : undefined;
    const path = Array.isArray(params.path)
      ? (params.path as unknown[]).map(String)
      : typeof params.path === "string"
        ? params.path.split(/\s*>\s*|\s*→\s*/).filter(Boolean)
        : undefined;
    if (!app) return this.missingParam("ax_menu_select", "app");
    if (!path || path.length === 0)
      return this.missingParam("ax_menu_select", "path");

    // Build an AppleScript that walks the menu bar by name.
    // e.g. path = ["File", "Export", "Export as PNG"]
    const items = path.map((s) => `"${escapeAs(s)}"`).join(", ");
    const script = [
      `tell application "System Events"`,
      `  tell process "${escapeAs(app)}"`,
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
      return ok({ app, path } as unknown as T);
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
    try {
      const { stdout } = await this.shell.run("osascript", ["-e", script]);
      return ok({ stdout: stdout.trimEnd() } as unknown as T);
    } catch (e) {
      return this.envelopeFromShellError("applescript", e);
    }
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
    const app = typeof params.app === "string" ? params.app : undefined;
    if (!app) return this.missingParam("launch_app", "app");
    try {
      await this.shell.run("open", ["-a", app]);
      return ok({ app } as unknown as T);
    } catch (e) {
      return this.envelopeFromShellError("launch_app", e);
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
    .replace(/\u0000/g, "");
}
