import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  encodeSnapshot,
  type RawAxNode,
} from "../../src/transport/snapshot-encoder.js";
import { RefAllocator } from "../../src/transport/refs.js";

const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/compute/snapshot");

function loadFixture(name: string): RawAxNode {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"),
  ) as RawAxNode;
}

function slackFixture(): RawAxNode {
  return {
    role: "AXWindow",
    name: "Slack",
    path: "AXWindow[0]",
    scope: "pid-100",
    app: "Slack",
    pid: 100,
    bounds: { x: 0, y: 0, w: 1200, h: 800 },
    states: ["focused"],
    children: [
      {
        role: "AXGroup",
        path: "AXWindow[0]/AXGroup[0]",
        scope: "pid-100",
        children: [
          {
            role: "AXStaticText",
            name: "general",
            path: "AXWindow[0]/AXGroup[0]/AXStaticText[0]",
            scope: "pid-100",
          },
          {
            role: "AXTextArea",
            name: "Message general",
            path: "AXWindow[0]/AXGroup[0]/AXTextArea[0]",
            scope: "pid-100",
            bounds: { x: 40, y: 710, w: 900, h: 44 },
            states: ["focusable", "editable"],
          },
          {
            role: "AXButton",
            name: "Send",
            path: "AXWindow[0]/AXGroup[0]/AXButton[0]",
            scope: "pid-100",
            bounds: { x: 960, y: 710, w: 80, h: 44 },
            states: ["enabled"],
          },
        ],
      },
    ],
  };
}

function largeFixture(count: number): RawAxNode {
  return {
    role: "Window",
    name: "VS Code",
    path: "Window[0]",
    scope: "pid-200",
    children: Array.from({ length: count }, (_, i) => ({
      role: i % 3 === 0 ? "Button" : "Text",
      name: `node-${i}`,
      path: `Window[0]/${i % 3 === 0 ? "Button" : "Text"}[${i}]`,
      scope: "pid-200",
      states: i % 3 === 0 ? ["enabled"] : [],
    })),
  };
}

describe("encodeSnapshot", () => {
  it("loads the six P1 golden fixtures from disk", () => {
    expect(
      [
        "slack-compose",
        "vscode-editor",
        "safari-front-page",
        "notepad-empty",
        "gnome-calc",
        "nested-deep",
      ].map((name) => loadFixture(name).role),
    ).toEqual([
      "AXWindow",
      "Window",
      "AXWindow",
      "Window",
      "frame",
      "AXWindow",
    ]);
  });

  it("encodes compact text with deterministic refs and stable tokens", () => {
    const alloc = new RefAllocator();
    const result = encodeSnapshot(loadFixture("slack-compose"), {
      transport: "desktop-ax",
      alloc,
    });

    expect(result.refCount).toBe(4);
    expect(result.encoded).toContain(
      '@e1 window "Slack" 1200x800@0,0 {focused} app=Slack',
    );
    expect(result.encoded).toContain(
      '@e3 textarea "Message general" 900x44@40,710 {focusable,editable}',
    );
    expect(
      alloc.freeze("desktop-ax", "pid-100").byAlias.get("@e4")?.stable,
    ).toBe("desktop-ax:pid-100:AXWindow[0]/AXGroup[0]/AXButton[0]");
    expect(Buffer.byteLength(result.encoded, "utf8")).toBeLessThanOrEqual(8192);
  });

  it("reports the screen index alongside screen-relative bounds", () => {
    const alloc = new RefAllocator();
    const result = encodeSnapshot(
      {
        role: "AXWindow",
        name: "External Display",
        path: "AXWindow[0]",
        scope: "pid-300",
        bounds: { x: 1600, y: 120, w: 900, h: 700 },
        screenIndex: 1,
      },
      {
        transport: "desktop-ax",
        alloc,
      },
    );

    expect(result.encoded).toContain(
      '@e1 window "External Display" 900x700@1600,120 screen=1',
    );
    expect(
      alloc.freeze("desktop-ax", "pid-300").byAlias.get("@e1"),
    ).toMatchObject({
      bounds: { x: 1600, y: 120, w: 900, h: 700 },
      screenIndex: 1,
    });
  });

  it("preserves tree indentation in tree mode", () => {
    const result = encodeSnapshot(loadFixture("slack-compose"), {
      format: "tree",
      transport: "desktop-ax",
      alloc: new RefAllocator(),
      namedOnly: false,
    });

    expect(result.encoded.split("\n")).toEqual([
      '@e1 window "Slack" 1200x800@0,0 {focused} app=Slack',
      "  @e2 group",
      '    @e3 text "general"',
      '    @e4 textarea "Message general" 900x44@40,710 {focusable,editable}',
      '    @e5 button "Send" 80x44@960,710 {enabled}',
    ]);
  });

  it("returns raw JSON without allocating refs in json mode", () => {
    const result = encodeSnapshot(loadFixture("safari-front-page"), {
      format: "json",
      transport: "desktop-ax",
      alloc: new RefAllocator(),
    });

    expect(JSON.parse(result.encoded).name).toBe("Safari");
    expect(result.refCount).toBe(0);
  });

  it("falls back to lowercase role names for unknown roles", () => {
    const result = encodeSnapshot(
      {
        role: "CustomControl",
        name: "Widget",
        path: "CustomControl[0]",
        scope: "pid-900",
      },
      {
        transport: "desktop-ax",
        alloc: new RefAllocator(),
      },
    );

    expect(result.encoded).toContain('@e1 customcontrol "Widget"');
  });

  it("includes element values in compact output and refs", () => {
    const alloc = new RefAllocator();
    const result = encodeSnapshot(loadFixture("gnome-calc"), {
      transport: "desktop-atspi",
      alloc,
    });

    expect(result.encoded).toContain('@e2 input "Display" value="0"');
    expect(
      alloc.freeze("desktop-atspi", "pid-500").byAlias.get("@e2"),
    ).toMatchObject({
      stable: "desktop-atspi:pid-500:frame[0]/text[0]",
      value: "0",
    });
  });

  it("filters to interactive nodes when requested", () => {
    const result = encodeSnapshot(loadFixture("slack-compose"), {
      interactiveOnly: true,
      transport: "desktop-ax",
      alloc: new RefAllocator(),
    });

    expect(result.encoded).toContain("textarea");
    expect(result.encoded).toContain("button");
    expect(result.encoded).not.toContain("general");
  });

  it("honors namedOnly and maxDepth options", () => {
    const namedOnly = encodeSnapshot(loadFixture("slack-compose"), {
      transport: "desktop-ax",
      alloc: new RefAllocator(),
    });
    const unnamedIncluded = encodeSnapshot(loadFixture("slack-compose"), {
      transport: "desktop-ax",
      alloc: new RefAllocator(),
      namedOnly: false,
    });
    const depthLimited = encodeSnapshot(loadFixture("slack-compose"), {
      transport: "desktop-ax",
      alloc: new RefAllocator(),
      namedOnly: false,
      maxDepth: 1,
    });

    expect(namedOnly.encoded).not.toContain("group");
    expect(unnamedIncluded.encoded).toContain("group");
    expect(depthLimited.encoded).toContain("group");
    expect(depthLimited.encoded).not.toContain("Send");
  });

  it("encodes a 400-node fixture under the latency budget", () => {
    const started = performance.now();
    const result = encodeSnapshot(loadFixture("vscode-editor"), {
      transport: "desktop-uia",
      alloc: new RefAllocator(),
      includeBounds: false,
    });
    const elapsed = performance.now() - started;

    expect(result.refCount).toBe(401);
    expect(elapsed).toBeLessThan(5);
  });
});
