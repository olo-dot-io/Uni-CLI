import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeAgentPresenceCommand,
  renderAgentPresence,
} from "../../../extension/src/agent-presence.js";

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("foreground Chrome agent presence", () => {
  it("dispatches explicit show and cursor updates through an isolated world", async () => {
    const executeScript = vi
      .fn()
      .mockResolvedValueOnce([
        {
          frameId: 0,
          result: result("visible", false),
        },
      ])
      .mockResolvedValueOnce([
        {
          frameId: 0,
          result: { ...result("visible", true), x: 40, y: 60 },
        },
      ]);
    vi.stubGlobal("chrome", { scripting: { executeScript } });

    await expect(
      executeAgentPresenceCommand(10, {
        method: "agent_presence",
        visible: true,
        label: "Reviewing checkout",
      }),
    ).resolves.toMatchObject({ status: "visible", cursor_visible: false });
    await expect(
      executeAgentPresenceCommand(10, {
        method: "agent_cursor",
        x: 40,
        y: 60,
      }),
    ).resolves.toMatchObject({
      status: "visible",
      cursor_visible: true,
      x: 40,
      y: 60,
    });
    expect(executeScript).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: { tabId: 10 },
        world: "ISOLATED",
        func: renderAgentPresence,
        args: [{ kind: "show", label: "Reviewing checkout" }],
      }),
    );
    expect(executeScript).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        args: [{ kind: "move", x: 40, y: 60, cursor_visible: true }],
      }),
    );
  });

  it("refuses cursor movement before presence is visible", async () => {
    vi.stubGlobal("chrome", {
      scripting: {
        executeScript: vi
          .fn()
          .mockResolvedValue([
            { frameId: 0, result: result("inactive", false) },
          ]),
      },
    });

    await expect(
      executeAgentPresenceCommand(10, {
        method: "agent_cursor",
        x: 1,
        y: 2,
      }),
    ).rejects.toMatchObject({ code: "chrome_agent_presence_inactive" });
  });

  it("reports viewport bounds instead of clamping cursor coordinates", async () => {
    vi.stubGlobal("chrome", {
      scripting: {
        executeScript: vi.fn().mockResolvedValue([
          {
            frameId: 0,
            result: { ...result("out_of_bounds", false), x: 900, y: 700 },
          },
        ]),
      },
    });

    await expect(
      executeAgentPresenceCommand(10, {
        method: "agent_cursor",
        x: 900,
        y: 700,
      }),
    ).rejects.toMatchObject({
      code: "chrome_agent_cursor_out_of_bounds",
      message: expect.stringContaining("800x600"),
    });
  });

  it("contains no idle loop, infinite animation, or transition-all path", () => {
    const source = renderAgentPresence.toString();
    expect(source).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
    expect(source).not.toMatch(/animation\s*:|infinite|transition\s*:\s*all/i);
    expect(source).toContain("prefers-reduced-motion");
    expect(source).toContain("pointer-events");
    expect(source).toContain("aria-hidden");
    expect(source).toContain("attachShadow");
    expect(source).toContain("translate3d");
  });

  it.each([
    { status: "visible" },
    { ...result("hidden", true) },
    { ...result("visible", true) },
    { ...result("visible", false), x: 900, y: 10 },
    { ...result("out_of_bounds", false), x: 400, y: 300 },
  ])("marks malformed post-mutation result %# ambiguous", async (invalid) => {
    vi.stubGlobal("chrome", {
      scripting: {
        executeScript: vi
          .fn()
          .mockResolvedValue([{ frameId: 0, result: invalid }]),
      },
    });

    await expect(
      executeAgentPresenceCommand(10, {
        method: "agent_presence",
        visible: true,
      }),
    ).rejects.toMatchObject({
      code: "chrome_agent_presence_invalid",
      outcomeAmbiguous: true,
    });
  });
});

function result(
  status: "visible" | "hidden" | "inactive" | "out_of_bounds",
  cursorVisible: boolean,
) {
  return {
    status,
    cursor_visible: cursorVisible,
    viewport_width: 800,
    viewport_height: 600,
  };
}
