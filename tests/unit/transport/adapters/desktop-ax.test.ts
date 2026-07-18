/**
 * DesktopAxTransport adapter tests.
 *
 * Exercises platform gating, AppleScript composition, and the mockable
 * shell abstraction. No real osascript/pbcopy is ever spawned — every
 * test injects a `FakeShell` that records the commands instead.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  DesktopAxTransport,
  type AxShell,
} from "../../../../src/transport/adapters/desktop-ax.js";
import {
  buildAxBackgroundClickScript,
  buildAxBackgroundInputScript,
  buildAxPressScript,
  buildAxScrollScript,
  buildAxSetValueScript,
  buildAxSnapshotScript,
  buildElectronAxWarmupScript,
  readAxWindowId,
  readAxElementQuery,
  resolveAxTarget,
} from "../../../../src/transport/adapters/desktop-ax-swift.js";
import {
  findElectronApp,
  resolveAppControlPolicy,
} from "../../../../src/electron-apps.js";
import { normalizeAxSnapshot } from "../../../../src/transport/adapters/desktop-ax-helpers.js";
import { createTransportBus } from "../../../../src/transport/bus.js";
import type { TransportContext } from "../../../../src/transport/types.js";

function makeCtx(): TransportContext {
  return { vars: {}, bus: createTransportBus() };
}

class FakeShell implements AxShell {
  readonly calls: Array<{
    command: string;
    args: readonly string[];
    input?: string;
  }> = [];
  private responses: Record<string, string> = {};
  private commandResponses: Record<string, string> = {};
  private matchResponses: Array<{
    command: string;
    contains: string;
    stdout: string;
  }> = [];
  private throws: Record<string, Error> = {};
  private commandThrows: Record<string, Error> = {};

  respond(key: string, stdout: string) {
    this.responses[key] = stdout;
  }

  respondCommand(command: string, stdout: string) {
    this.commandResponses[command] = stdout;
  }

  respondMatch(command: string, contains: string, stdout: string) {
    this.matchResponses.push({ command, contains, stdout });
  }

  throwOn(key: string, err: Error) {
    this.throws[key] = err;
  }

  throwOnCommand(command: string, err: Error) {
    this.commandThrows[command] = err;
  }

  async run(
    command: string,
    args: readonly string[],
    opts?: { input?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ command, args, input: opts?.input });
    const key = `${command}:${args.join("|")}`;
    if (this.throws[key]) throw this.throws[key];
    if (this.commandThrows[command]) throw this.commandThrows[command];
    if (command === "screencapture") {
      writeFileSync(String(args.at(-1)), "png bytes");
    }
    if (this.responses[key]) {
      return { stdout: this.responses[key]!, stderr: "" };
    }
    for (const match of this.matchResponses) {
      if (
        match.command === command &&
        args.join("|").includes(match.contains)
      ) {
        return { stdout: match.stdout, stderr: "" };
      }
    }
    if (this.commandResponses[command]) {
      return { stdout: this.commandResponses[command]!, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
}

describe("DesktopAxTransport", () => {
  it("parses only positive 32-bit decimal CoreGraphics window ids", () => {
    expect(readAxWindowId(42)).toBe(42);
    expect(readAxWindowId("42")).toBe(42);
    for (const invalid of [-1, 0, "-1", "0", "window-name", 0x1_0000_0000]) {
      expect(readAxWindowId(invalid)).toBeUndefined();
    }
  });

  it.each([-1, "-1", "window-name", 0x1_0000_0000])(
    "fails closed before AX dispatch for invalid window id %s",
    async (windowId) => {
      const shell = new FakeShell();
      const transport = new DesktopAxTransport({ shell, platform: "darwin" });
      await transport.open(makeCtx());

      const result = await transport.action({
        kind: "ax_snapshot",
        params: { app: "Ghostty", windowId },
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          minimum_capability: "desktop-ax.ax_snapshot.invalid_input",
          exit_code: 2,
        },
      });
      expect(shell.calls).toHaveLength(0);
    },
  );

  it("resolves natural app aliases for NetEase desktop control", () => {
    expect(findElectronApp("netease music app")?.bundleId).toBe(
      "com.netease.163music",
    );
    expect(findElectronApp("网易云")?.processName).toBe("NeteaseMusic");
  });

  it("declares NetEase as a CDP-first app when AX exposes an empty tree", () => {
    const policy = resolveAppControlPolicy("网易云");
    expect(policy.inspectionOrder).toEqual([
      "cdp-dom",
      "desktop-ax",
      "background-click",
      "visual",
    ]);
    expect(policy.axEmptyTreeFallback).toBe("cdp-dom");
    expect(policy.backgroundClick.enabled).toBe(true);
    expect(policy.backgroundClick.flagsWhenBackgrounded).toBe("command");
  });

  it("generates Swift AX scripts without untyped empty sets or conditional AX casts", () => {
    const target = resolveAxTarget({ app: "netease-music" });
    expect(target).not.toBeNull();
    const query = readAxElementQuery({ role: "AXButton" }, false);
    const scripts = [
      buildAxSnapshotScript(target!, {
        maxDepth: 1,
        scope: "focusedWindow",
      }),
      buildAxSetValueScript(target!, {
        ...query,
        attribute: "AXValue",
        value: "hello",
      }),
      buildAxPressScript(target!, { ...query, actionName: "AXPress" }),
      buildAxScrollScript(target!, {
        ...query,
        actionName: "AXScrollToVisible",
      }),
      buildAxBackgroundClickScript(target!, {
        x: 120,
        y: 80,
        coordinateSpace: "window",
        button: 0,
        clickCount: 1,
      }),
    ];

    for (const script of scripts) {
      expect(script).not.toContain("Set([])");
      expect(script).not.toContain("as? AXUIElement");
    }
  });

  it("binds ref actions to an exact window and AX traversal path", () => {
    const target = resolveAxTarget({ app: "Calculator" });
    expect(target).not.toBeNull();
    const query = readAxElementQuery(
      {
        stable: "desktop-ax:focusedWindow:AXWindow[0]/AXGroup[1]/AXButton[2]",
        windowId: 4242,
        role: "AXButton",
        name: "Equals",
      },
      false,
    );
    const script = buildAxPressScript(target!, {
      ...query,
      actionName: "AXPress",
    });

    expect(query.windowId).toBe(4242);
    expect(query.path).toEqual([
      { role: "AXWindow", index: 0 },
      { role: "AXGroup", index: 1 },
      { role: "AXButton", index: 2 },
    ]);
    expect(script).toContain("let queryWindowId = 4242");
    expect(script).toContain(
      'let queryPathRoles: [String] = ["AXWindow", "AXGroup", "AXButton"]',
    );
    expect(script).toContain("exactWindowId($0");
    expect(script).toContain("elementAtQueryPath(window)");
    expect(script).not.toContain("activateIgnoringOtherApps");
  });

  it("generates background-click Swift with activation primer, event taps, and window field writes", () => {
    const target = resolveAxTarget({ app: "netease music app" });
    expect(target).not.toBeNull();
    const script = buildAxBackgroundClickScript(target!, {
      x: 120,
      y: 80,
      coordinateSpace: "window",
      button: 0,
      clickCount: 1,
    });

    expect(script).toContain("postToPid");
    expect(script).toContain(".appKitDefined");
    expect(script).toContain("tapCreateForPid");
    expect(script).toContain("if !wasFrontmost {");
    expect(script).toContain("ScopedWindowActivationSession.activateWindow");
    expect(script).toContain("NSEvent.mouseEvent(");
    expect(script).toContain("nextSyntheticMouseEventNumber");
    expect(script).toContain("? [] : [.command]");
    expect(script).toContain("CGEventSetWindowLocation");
    expect(script).toContain(".mouseEventButtonNumber");
    expect(script).toContain("CGEventField(rawValue: 7)");
    expect(script).toContain("CGEventField(rawValue: 51)");
    expect(script).toContain("CGEventField(rawValue: 58)");
    expect(script).toContain(".mouseEventWindowUnderMousePointer");
    expect(script).toContain(
      ".mouseEventWindowUnderMousePointerThatCanHandleThisEvent",
    );
    expect(script).not.toContain("activateIgnoringOtherApps");
    expect(script).not.toContain("kAXFrontmostAttribute");
  });

  it("generates background type and press Swift through the shared input session", () => {
    const target = resolveAxTarget({ app: "TextEdit" });
    expect(target).not.toBeNull();

    const typeScript = buildAxBackgroundInputScript(target!, {
      action: "type_text",
      x: 20,
      y: 30,
      coordinateSpace: "window",
      button: 0,
      clickCount: 1,
      text: "hello",
    });
    const pressScript = buildAxBackgroundInputScript(target!, {
      action: "press_key",
      coordinateSpace: "window",
      button: 0,
      clickCount: 1,
      key: "cmd+s",
    });

    expect(typeScript).toContain(`let requestedAction = "type_text"`);
    expect(typeScript).toContain("keyboardSetUnicodeString");
    expect(pressScript).toContain(`let requestedAction = "press_key"`);
    expect(pressScript).toContain("KeyCombination.parse");
  });

  it("generated AX snapshots include bounds and screen index metadata", () => {
    const target = resolveAxTarget({ app: "Calculator" });
    expect(target).not.toBeNull();
    const script = buildAxSnapshotScript(target!, {
      maxDepth: 1,
      scope: "focusedWindow",
    });

    expect(script).toContain("AXPosition");
    expect(script).toContain("AXSize");
    expect(script).toContain("screenIndex");
    expect(script).toContain("NSScreen.screens");
    expect(script).toContain("kAXFocusedAttribute");
    expect(script).toContain("kAXMinimizedAttribute");
    expect(script).toContain("CGWindowListCopyWindowInfo");
    expect(script).toContain("kCGWindowIsOnscreen");
    expect(script).toContain("minimized ? !isOnscreen : isOnscreen");
    expect(script).not.toContain(
      "if titled.count == 1 { return windowNumber(titled[0]) }",
    );
    expect(script).not.toContain("return exactBounds.count == 1");
    expect(script).toContain('describedRoot["windowId"]');
    expect(script).toContain('describedRoot["scope"] = "window-\\(windowId)"');
  });

  it("generates target-scoped snapshots for an exact CoreGraphics window", () => {
    const target = resolveAxTarget({ app: "Calculator" });
    expect(target).not.toBeNull();
    const script = buildAxSnapshotScript(target!, {
      maxDepth: 2,
      scope: "focusedWindow",
      windowId: 4242,
    });

    expect(script).toContain("let snapshotWindowId = 4242");
    expect(script).toContain("matches.count == 1");
    expect(script).toContain("selectedWindow = matches[0]");
    expect(script).toContain('"matched": false');
    expect(script).toContain(
      '"failure": matches.isEmpty ? "window_not_found" : "window_ambiguous"',
    );
  });

  it("normalizes native AX booleans into actionable ref states", () => {
    const snapshot = normalizeAxSnapshot({
      role: "AXWindow",
      title: "Editor",
      enabled: true,
      focused: true,
      children: [
        { role: "AXButton", title: "Run", enabled: false, minimized: true },
      ],
    });

    expect(snapshot.states).toEqual(["enabled", "focused"]);
    expect(snapshot.children?.[0]?.states).toEqual(["disabled", "minimized"]);
  });

  it("typechecks generated Swift AX scripts when swiftc is available", () => {
    if (process.platform !== "darwin") return;
    try {
      execFileSync("swiftc", ["--version"], { stdio: "pipe" });
    } catch {
      return;
    }

    const target = resolveAxTarget({ app: "netease music app" });
    expect(target).not.toBeNull();
    const query = readAxElementQuery({ role: "AXButton" }, false);
    const scripts = {
      warmup: buildElectronAxWarmupScript(target!, 0),
      snapshot: buildAxSnapshotScript(target!, {
        maxDepth: 1,
        scope: "focusedWindow",
      }),
      set: buildAxSetValueScript(target!, {
        ...query,
        attribute: "AXValue",
        value: "hello",
      }),
      press: buildAxPressScript(target!, { ...query, actionName: "AXPress" }),
      scroll: buildAxScrollScript(target!, {
        ...query,
        actionName: "AXScrollToVisible",
      }),
      backgroundClick: buildAxBackgroundClickScript(target!, {
        x: 120,
        y: 80,
        coordinateSpace: "window",
        button: 0,
        clickCount: 1,
      }),
      backgroundType: buildAxBackgroundInputScript(target!, {
        action: "type_text",
        x: 120,
        y: 80,
        coordinateSpace: "window",
        button: 0,
        clickCount: 1,
        text: "hello",
      }),
      backgroundPress: buildAxBackgroundInputScript(target!, {
        action: "press_key",
        coordinateSpace: "window",
        button: 0,
        clickCount: 1,
        key: "cmd+s",
      }),
    };
    const dir = mkdtempSync(join(tmpdir(), "unicli-ax-"));
    for (const [name, script] of Object.entries(scripts)) {
      const path = join(dir, `${name}.swift`);
      writeFileSync(path, script, "utf-8");
      execFileSync("swiftc", ["-typecheck", path], { stdio: "pipe" });
    }
  }, 30_000);

  it("declares kind = desktop-ax and darwin platform gate", () => {
    const t = new DesktopAxTransport({
      shell: new FakeShell(),
      platform: "darwin",
    });
    expect(t.kind).toBe("desktop-ax");
    expect(t.capability.platforms).toContain("darwin");
    expect(t.capability.steps).toContain("applescript");
    expect(t.capability.steps).toContain("ax_menu_select");
    expect(t.capability.steps).toContain("ax_snapshot");
    expect(t.capability.steps).toContain("ax_set_value");
    expect(t.capability.steps).toContain("ax_scroll");
    expect(t.capability.steps).toContain("ax_screenshot");
    expect(t.capability.steps).toContain("ax_background_click");
    expect(t.capability.steps).toContain("ax_background_type");
    expect(t.capability.steps).toContain("ax_background_press");
    expect(t.capability.steps).toContain("ax_apps");
    expect(t.capability.steps).toContain("ax_windows");
  });

  it("returns service_unavailable envelope on linux", async () => {
    const t = new DesktopAxTransport({
      shell: new FakeShell(),
      platform: "linux",
    });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "applescript",
      params: { script: 'tell app "Finder" to activate' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.transport).toBe("desktop-ax");
      expect(res.error.exit_code).toBe(69);
      expect(res.error.minimum_capability).toBe("desktop-ax.applescript");
      expect(res.error.suggestion).toMatch(/atspi|linux/i);
    }
  });

  it("returns service_unavailable envelope on win32", async () => {
    const t = new DesktopAxTransport({
      shell: new FakeShell(),
      platform: "win32",
    });
    await t.open(makeCtx());
    const res = await t.action({ kind: "ax_focus", params: { app: "Figma" } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.exit_code).toBe(69);
      expect(res.error.suggestion).toMatch(/uia|windows/i);
    }
  });

  it("applescript runs osascript on darwin and returns stdout", async () => {
    const shell = new FakeShell();
    shell.respond(
      `osascript:-e|tell application "Finder" to activate`,
      "finder ok",
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action<{ stdout: string }>({
      kind: "applescript",
      params: { script: `tell application "Finder" to activate` },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.stdout).toBe("finder ok");
    expect(shell.calls[0]?.command).toBe("osascript");
  });

  it("launch_app shells open -a", async () => {
    const shell = new FakeShell();
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "launch_app",
      params: { app: "Music" },
    });
    expect(res.ok).toBe(true);
    expect(shell.calls[0]).toEqual({
      command: "open",
      args: ["-a", "Music"],
      input: undefined,
    });
  });

  it("launch_app forwards debugPort to open --args", async () => {
    const shell = new FakeShell();
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "launch_app",
      params: { app: "Visual Studio Code", debugPort: 9230 },
    });
    expect(res.ok).toBe(true);
    expect(shell.calls[0]).toEqual({
      command: "open",
      args: [
        "-a",
        "Visual Studio Code",
        "--args",
        "--remote-debugging-port=9230",
      ],
      input: undefined,
    });
  });

  it("ax_screenshot shells screencapture to the requested path", async () => {
    const root = mkdtempSync(join(tmpdir(), "unicli-ax-transaction-"));
    const destination = join(root, "shot.png");
    const shell = new FakeShell();
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());

    try {
      const res = await t.action({
        kind: "ax_screenshot",
        params: { path: destination },
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data).toEqual({ path: destination, mime: "image/png" });
      }
      expect(shell.calls[0]?.command).toBe("screencapture");
      const stagingPath = String(shell.calls[0]?.args.at(-1));
      expect(stagingPath).not.toBe(destination);
      expect(dirname(dirname(stagingPath))).toBe(root);
      expect(basename(dirname(stagingPath))).toMatch(/^\.shot\./);
      expect(stagingPath).toMatch(/\.tmp\.png$/);
      expect(readFileSync(destination, "utf8")).toBe("png bytes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ax_screenshot scopes an explicit app to its observed window bounds", async () => {
    const root = mkdtempSync(join(tmpdir(), "unicli-ax-window-shot-"));
    const destination = join(root, "shot.png");
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let commandMode = "snapshot"`,
      JSON.stringify({
        found: true,
        matched: true,
        mode: "snapshot",
        scope: "focusedWindow",
        element: {
          role: "AXWindow",
          title: "Calculator",
          bounds: { x: 10, y: 20, w: 640, h: 480 },
          windowId: 42,
        },
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());

    try {
      const res = await t.action({
        kind: "ax_screenshot",
        params: { app: "Calculator", path: destination },
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data).toMatchObject({
          path: destination,
          mime: "image/png",
          scope: "window",
          windowId: 42,
          bounds: { x: 10, y: 20, w: 640, h: 480 },
        });
      }
      const capture = shell.calls.find(
        (call) => call.command === "screencapture",
      );
      expect(capture?.args).toContain("-l42");
      expect(capture?.args).toContain("-o");
      expect(capture?.args).not.toContain("-R10,20,640,480");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an app window cannot be bound to CoreGraphics", async () => {
    const root = mkdtempSync(join(tmpdir(), "unicli-ax-window-shot-"));
    const destination = join(root, "shot.png");
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let commandMode = "snapshot"`,
      JSON.stringify({
        found: true,
        matched: true,
        mode: "snapshot",
        scope: "focusedWindow",
        element: {
          role: "AXWindow",
          title: "Calculator",
          bounds: { x: 10, y: 20, w: 640, h: 480 },
        },
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());

    try {
      const res = await t.action({
        kind: "ax_screenshot",
        params: { app: "Calculator", path: destination },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.minimum_capability).toBe(
          "desktop-ax.ax_screenshot.target_window",
        );
      }
      expect(shell.calls.some((call) => call.command === "screencapture")).toBe(
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("launch_app resolves known Electron apps by bundle id", async () => {
    const shell = new FakeShell();
    shell.respondCommand(
      "swift",
      JSON.stringify({ trusted: true, found: true, pid: 48133 }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "launch_app",
      params: { app: "netease-music" },
    });
    expect(res.ok).toBe(true);
    expect(shell.calls[0]).toEqual({
      command: "open",
      args: ["-b", "com.netease.163music"],
      input: undefined,
    });
    expect(shell.calls[1]?.command).toBe("swift");
    expect(shell.calls[1]?.args[1]).toContain(`com.netease.163music`);
    expect(shell.calls[1]?.args[1]).toContain(`NeteaseMusic`);
  });

  it("clipboard_write pipes text through pbcopy stdin", async () => {
    const shell = new FakeShell();
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "clipboard_write",
      params: { text: "hello clipboard" },
    });
    expect(res.ok).toBe(true);
    expect(shell.calls[0]?.command).toBe("pbcopy");
    expect(shell.calls[0]?.input).toBe("hello clipboard");
  });

  it("clipboard_read returns pbpaste stdout", async () => {
    const shell = new FakeShell();
    shell.respond("pbpaste:", "clipboard-contents");
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action<{ text: string }>({
      kind: "clipboard_read",
      params: {},
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.text).toBe("clipboard-contents");
  });

  it("ax_apps lists regular running apps through Swift", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let commandMode = "apps"`,
      JSON.stringify({
        count: 1,
        apps: [
          {
            name: "Calculator",
            bundleId: "com.apple.calculator",
            processName: "Calculator",
            pid: 4242,
            active: true,
            hidden: false,
          },
        ],
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action<{
      count: number;
      apps: Array<{ name: string; bundleId: string; pid: number }>;
    }>({
      kind: "ax_apps",
      params: {},
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.count).toBe(1);
      expect(res.data.apps[0]).toMatchObject({
        name: "Calculator",
        bundleId: "com.apple.calculator",
        pid: 4242,
      });
    }
    expect(shell.calls[0]?.command).toBe("swift");
    expect(shell.calls[0]?.args[1]).toContain(`let commandMode = "apps"`);
  });

  it("ax_windows lists windows scoped to an app through Swift", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let commandMode = "windows"`,
      JSON.stringify({
        count: 1,
        windows: [
          {
            app: "Calculator",
            bundleId: "com.apple.calculator",
            pid: 4242,
            title: "Calculator",
            role: "AXWindow",
            focused: true,
          },
        ],
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action<{
      count: number;
      windows: Array<{ app: string; title: string; focused: boolean }>;
    }>({
      kind: "ax_windows",
      params: { app: "Calculator" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.count).toBe(1);
      expect(res.data.windows[0]).toMatchObject({
        app: "Calculator",
        title: "Calculator",
        focused: true,
      });
    }
    expect(shell.calls[0]?.command).toBe("swift");
    expect(shell.calls[0]?.args[1]).toContain(`let commandMode = "windows"`);
    expect(shell.calls[0]?.args[1]).toContain(
      `let requestedAppName = "Calculator"`,
    );
  });

  it("ax_menu_select builds a path-walk AppleScript", async () => {
    const shell = new FakeShell();
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "ax_menu_select",
      params: { app: "Figma", path: ["File", "Export", "Export as PNG"] },
    });
    expect(res.ok).toBe(true);
    const script = shell.calls[0]?.args[1] ?? "";
    expect(script).toContain(`process "Figma"`);
    expect(script).toContain(`"File"`);
    expect(script).toContain(`"Export"`);
    expect(script).toContain(`"Export as PNG"`);
  });

  it("ax_menu_select prewarms known Electron apps before UI scripting", async () => {
    const shell = new FakeShell();
    shell.respondCommand(
      "swift",
      JSON.stringify({ trusted: true, found: true, pid: 48133 }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "ax_menu_select",
      params: { app: "netease-music", path: ["File", "Preferences"] },
    });
    expect(res.ok).toBe(true);
    expect(shell.calls[0]?.command).toBe("swift");
    expect(shell.calls[1]?.command).toBe("osascript");
    const script = shell.calls[1]?.args[1] ?? "";
    expect(script).toContain(`process "NeteaseMusic"`);
  });

  it("ax_snapshot returns a structured focused-window snapshot", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let commandMode = "snapshot"`,
      JSON.stringify({
        found: true,
        matched: true,
        mode: "snapshot",
        scope: "focusedWindow",
        element: {
          role: "AXWindow",
          title: "ChatGPT",
          childCount: 1,
          children: [{ role: "AXGroup" }],
        },
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action<{ element: { role: string; title: string } }>({
      kind: "ax_snapshot",
      params: {
        app: "ChatGPT",
        scope: "focusedWindow",
        ensureElectronAx: false,
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.element.role).toBe("AXWindow");
      expect(res.data.element.title).toBe("ChatGPT");
    }
    expect(shell.calls[0]?.args[1]).toContain(`let commandMode = "snapshot"`);
  });

  it("ax_focused_read stores the last AX snapshot for snapshot()", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let commandMode = "focused_read"`,
      JSON.stringify({
        found: true,
        matched: true,
        mode: "focused_read",
        element: {
          role: "AXTextArea",
          value: "hello",
          actions: ["AXConfirm"],
        },
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action<{ element: { role: string; value: string } }>({
      kind: "ax_focused_read",
      params: { app: "ChatGPT", ensureElectronAx: false },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.element.value).toBe("hello");

    const snapshot = await t.snapshot();
    expect(snapshot.format).toBe("json");
    expect(String(snapshot.data)).toContain(`"AXTextArea"`);
    expect(String(snapshot.data)).toContain(`"hello"`);
  });

  it("ax_set_value and ax_press reuse a warm Electron AX session", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      "AXManualAccessibility",
      JSON.stringify({ trusted: true, found: true, pid: 48133 }),
    );
    shell.respondMatch(
      "swift",
      `let commandMode = "set_value"`,
      JSON.stringify({
        found: true,
        matched: true,
        mode: "set_value",
        result: 0,
        attribute: "AXValue",
        element: { role: "AXTextArea", value: "你好" },
      }),
    );
    shell.respondMatch(
      "swift",
      `let commandMode = "press"`,
      JSON.stringify({
        found: true,
        matched: true,
        mode: "press",
        result: 0,
        action: "AXPress",
        element: { role: "AXButton", description: "发送" },
      }),
    );

    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());

    const writeRes = await t.action<{ element: { value: string } }>({
      kind: "ax_set_value",
      params: { app: "chatgpt", value: "你好" },
    });
    expect(writeRes.ok).toBe(true);
    if (writeRes.ok) expect(writeRes.data.element.value).toBe("你好");

    const pressRes = await t.action<{ element: { description: string } }>({
      kind: "ax_press",
      params: {
        app: "chatgpt",
        focused: false,
        role: "AXButton",
        description: ["Send", "发送"],
      },
    });
    expect(pressRes.ok).toBe(true);
    if (pressRes.ok) expect(pressRes.data.element.description).toBe("发送");

    const warmupCalls = shell.calls.filter(
      (call) =>
        call.command === "swift" &&
        String(call.args[1] ?? "").includes("AXManualAccessibility"),
    );
    expect(warmupCalls).toHaveLength(1);
  });

  it("ax_press returns a typed envelope when no element matches", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let commandMode = "press"`,
      JSON.stringify({
        found: true,
        matched: false,
        mode: "press",
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "ax_press",
      params: {
        app: "ChatGPT",
        ensureElectronAx: false,
        focused: false,
        role: "AXButton",
        description: "Send",
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.reason).toMatch(/no matching accessibility element/i);
      expect(res.error.suggestion).toMatch(/focus the target control/i);
      expect(res.error.minimum_capability).toBe(
        "desktop-ax.ax_press.no_element",
      );
    }
  });

  it("distinguishes an exact stale window from an element-filter miss", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let commandMode = "press"`,
      JSON.stringify({
        found: true,
        matched: false,
        mode: "press",
        failure: "window_not_found",
      }),
    );
    const transport = new DesktopAxTransport({ shell, platform: "darwin" });
    await transport.open(makeCtx());

    const result = await transport.action({
      kind: "ax_press",
      params: {
        app: "Calculator",
        ensureElectronAx: false,
        windowId: 4242,
        role: "AXButton",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        minimum_capability: "desktop-ax.ax_press.target_window_not_found",
        exit_code: 66,
      },
    });
  });

  it("ax_scroll performs AXScrollToVisible without activating the app", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let commandMode = "scroll"`,
      JSON.stringify({
        found: true,
        matched: true,
        mode: "scroll",
        result: 0,
        action: "AXScrollToVisible",
        element: { role: "AXScrollArea", title: "Results" },
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());

    const res = await t.action<{ action: string }>({
      kind: "ax_scroll",
      params: {
        app: "ChatGPT",
        ensureElectronAx: false,
        focused: false,
        role: "AXScrollArea",
        title: "Results",
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.action).toBe("AXScrollToVisible");
    expect(shell.calls).toHaveLength(1);
    const script = shell.calls[0]?.args[1] ?? "";
    expect(script).toContain(`let commandMode = "scroll"`);
    expect(script).toContain(`AXUIElementPerformAction`);
    expect(script).not.toContain(`activate`);
  });

  it("ax_background_click posts a background click through Swift", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let commandMode = "background_input"`,
      JSON.stringify({
        found: true,
        posted: true,
        action: "click",
        pid: 48133,
        windowNumber: 42,
        backgroundActivated: true,
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action<{ posted: boolean; windowNumber: number }>({
      kind: "ax_background_click",
      params: {
        app: "netease music app",
        x: 120,
        y: 80,
        coordinateSpace: "window",
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.posted).toBe(true);
      expect(res.data.windowNumber).toBe(42);
    }
    const script = shell.calls.at(-1)?.args[1] ?? "";
    expect(script).toContain(`let commandMode = "background_input"`);
    expect(script).toContain(`let requestedAction = "click"`);
    expect(script).toContain("postToPid");
  });

  it("ax_background_type posts text through the background input session", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let requestedAction = "type_text"`,
      JSON.stringify({
        found: true,
        posted: true,
        action: "type_text",
        typedCharacters: 5,
        pid: 48133,
        windowNumber: 42,
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action<{ typedCharacters: number }>({
      kind: "ax_background_type",
      params: {
        app: "TextEdit",
        text: "hello",
        x: 12,
        y: 24,
        coordinateSpace: "window",
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.typedCharacters).toBe(5);
    const script = shell.calls.at(-1)?.args[1] ?? "";
    expect(script).toContain("keyboardSetUnicodeString");
  });

  it("ax_background_press posts a key combo through the background input session", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let requestedAction = "press_key"`,
      JSON.stringify({
        found: true,
        posted: true,
        action: "press_key",
        key: "cmd+s",
        pid: 48133,
        windowNumber: 42,
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action<{ key: string }>({
      kind: "ax_background_press",
      params: {
        app: "TextEdit",
        combo: "cmd+s",
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.key).toBe("cmd+s");
    const script = shell.calls.at(-1)?.args[1] ?? "";
    expect(script).toContain("KeyCombination.parse");
  });

  it("falls back from failed AXValue set to background text when scoped to an app", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let commandMode = "set_value"`,
      JSON.stringify({
        found: true,
        matched: true,
        mode: "set_value",
        result: -25205,
      }),
    );
    shell.respondMatch(
      "swift",
      `let requestedAction = "type_text"`,
      JSON.stringify({
        found: true,
        posted: true,
        action: "type_text",
        typedCharacters: 5,
        pid: 48133,
        windowNumber: 42,
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());

    const res = await t.action<{
      typedCharacters: number;
      semanticFallback: string;
    }>({
      kind: "ax_set_value",
      params: {
        app: "TextEdit",
        role: "AXTextField",
        value: "hello",
        x: 10,
        y: 20,
        coordinateSpace: "screen",
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.typedCharacters).toBe(5);
      expect(res.data.semanticFallback).toBe("ax_set_value");
    }
    expect(shell.calls).toHaveLength(2);
  });

  it("does not background-type after failed AXValue set without coordinates", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let commandMode = "set_value"`,
      JSON.stringify({
        found: true,
        matched: true,
        mode: "set_value",
        result: -25205,
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());

    const res = await t.action({
      kind: "ax_set_value",
      params: {
        app: "TextEdit",
        role: "AXTextField",
        value: "hello",
      },
    });

    expect(res.ok).toBe(false);
    expect(shell.calls).toHaveLength(1);
  });

  it("applescript with an Electron target fails clearly when Accessibility is missing", async () => {
    const shell = new FakeShell();
    shell.respondCommand(
      "swift",
      JSON.stringify({
        trusted: false,
        found: true,
        pid: 48133,
        bundleId: "com.netease.163music",
      }),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "applescript",
      params: {
        app: "netease-music",
        script: `return "ok"`,
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.reason).toMatch(/Accessibility/i);
      expect(res.error.suggestion).toMatch(
        /Privacy & Security → Accessibility/,
      );
    }
    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]?.command).toBe("swift");
  });

  it("applescript without an Electron target skips the Swift warmup", async () => {
    const shell = new FakeShell();
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "applescript",
      params: { script: `return "ok"` },
    });
    expect(res.ok).toBe(true);
    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]?.command).toBe("osascript");
  });

  it("envelopes osascript failure into service_unavailable", async () => {
    const shell = new FakeShell();
    shell.throwOn(
      `osascript:-e|tell application "NoSuchApp" to activate`,
      new Error("osascript: application NoSuchApp not found"),
    );
    const t = new DesktopAxTransport({ shell, platform: "darwin" });
    await t.open(makeCtx());
    const res = await t.action({
      kind: "applescript",
      params: { script: `tell application "NoSuchApp" to activate` },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.exit_code).toBe(69);
      expect(res.error.reason).toMatch(/NoSuchApp/);
    }
  });

  it("missing required param returns usage_error envelope", async () => {
    const t = new DesktopAxTransport({
      shell: new FakeShell(),
      platform: "darwin",
    });
    await t.open(makeCtx());
    const res = await t.action({ kind: "applescript", params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.exit_code).toBe(2);
      expect(res.error.reason).toMatch(/script/);
    }
  });

  it("close is idempotent", async () => {
    const t = new DesktopAxTransport({
      shell: new FakeShell(),
      platform: "darwin",
    });
    await t.open(makeCtx());
    await t.close();
    await t.close();
  });
});
