/**
 * DesktopAxTransport adapter tests.
 *
 * Exercises platform gating, AppleScript composition, and the mockable
 * shell abstraction. No real osascript/pbcopy is ever spawned — every
 * test injects a `FakeShell` that records the commands instead.
 */

import { describe, it, expect } from "vitest";
import {
  DesktopAxTransport,
  type AxShell,
} from "../../../../src/transport/adapters/desktop-ax.js";
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
  private throws: Record<string, Error> = {};

  respond(key: string, stdout: string) {
    this.responses[key] = stdout;
  }

  throwOn(key: string, err: Error) {
    this.throws[key] = err;
  }

  async run(
    command: string,
    args: readonly string[],
    opts?: { input?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ command, args, input: opts?.input });
    const key = `${command}:${args.join("|")}`;
    if (this.throws[key]) throw this.throws[key];
    if (this.responses[key]) {
      return { stdout: this.responses[key]!, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
}

describe("DesktopAxTransport", () => {
  it("declares kind = desktop-ax and darwin platform gate", () => {
    const t = new DesktopAxTransport({
      shell: new FakeShell(),
      platform: "darwin",
    });
    expect(t.kind).toBe("desktop-ax");
    expect(t.capability.platforms).toContain("darwin");
    expect(t.capability.steps).toContain("applescript");
    expect(t.capability.steps).toContain("ax_menu_select");
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
