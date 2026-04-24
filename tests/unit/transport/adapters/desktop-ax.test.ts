/**
 * DesktopAxTransport adapter tests.
 *
 * Exercises platform gating, AppleScript composition, and the mockable
 * shell abstraction. No real osascript/pbcopy is ever spawned — every
 * test injects a `FakeShell` that records the commands instead.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DesktopAxTransport,
  type AxShell,
} from "../../../../src/transport/adapters/desktop-ax.js";
import {
  buildAxBackgroundClickScript,
  buildAxPressScript,
  buildAxSetValueScript,
  buildAxSnapshotScript,
  buildElectronAxWarmupScript,
  readAxElementQuery,
  resolveAxTarget,
} from "../../../../src/transport/adapters/desktop-ax-swift.js";
import {
  findElectronApp,
  resolveAppControlPolicy,
} from "../../../../src/electron-apps.js";
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
      "cua",
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

  it("generates background-click Swift with postToPid field writes and command flag", () => {
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
    expect(script).toContain("CGEventSetWindowLocation");
    expect(script).toContain("CGEventField(rawValue: 3)");
    expect(script).toContain("CGEventField(rawValue: 7)");
    expect(script).toContain("CGEventField(rawValue: 91)");
    expect(script).toContain("CGEventField(rawValue: 92)");
    expect(script).toContain("CGEventFlags.maskCommand");
    expect(script).not.toContain("activateIgnoringOtherApps");
    expect(script).not.toContain("kAXFrontmostAttribute");
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
      backgroundClick: buildAxBackgroundClickScript(target!, {
        x: 120,
        y: 80,
        coordinateSpace: "window",
        button: 0,
        clickCount: 1,
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
    expect(t.capability.steps).toContain("ax_background_click");
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
    }
  });

  it("ax_background_click posts a background click through Swift", async () => {
    const shell = new FakeShell();
    shell.respondMatch(
      "swift",
      `let commandMode = "background_click"`,
      JSON.stringify({
        found: true,
        posted: true,
        pid: 48133,
        windowNumber: 42,
        commandFlagApplied: true,
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
    expect(script).toContain(`let commandMode = "background_click"`);
    expect(script).toContain("postToPid");
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
