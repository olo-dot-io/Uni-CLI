import { describe, expect, it } from "vitest";

import {
  adaptComputeAction,
  computePhysicalAction,
  planComputeRoute,
} from "../../../src/transport/routing.js";

describe("compute route planner", () => {
  it.each([
    ["darwin", "desktop-ax"],
    ["win32", "desktop-uia"],
    ["linux", "desktop-atspi"],
  ] as const)(
    "selects the platform-native snapshot provider on %s",
    (platform, transport) => {
      expect(
        planComputeRoute(
          { kind: "compute_snapshot", params: { app: "Editor" } },
          platform,
        ),
      ).toMatchObject({
        status: "selected",
        selection: {
          transport,
          operator: "desktop-accessibility",
          explicit: false,
        },
      });
    },
  );

  it("selects browser semantics from an exact CDP target", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_snapshot",
          params: {
            port: 9222,
            targetId: "page-1",
          },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "selected",
      selection: {
        transport: "cdp-browser",
        operator: "browser-semantic",
        target_scope: "browser-renderer",
      },
    });
  });

  it("selects browser semantics when the operation carries a DOM selector", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_click",
          params: { selector: "#submit" },
        },
        "linux",
      ),
    ).toMatchObject({
      status: "selected",
      selection: {
        transport: "cdp-browser",
        reason: "browser selector requires semantic DOM execution",
      },
    });
  });

  it("binds actions to the exact ref owner", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_click",
          params: { stable: "desktop-uia:window-42:Window[0]/Button[0]" },
        },
        "win32",
      ),
    ).toMatchObject({
      status: "selected",
      selection: {
        transport: "desktop-uia",
        reason: "exact ref owner",
      },
    });
  });

  it("never selects visual implicitly", () => {
    const decision = planComputeRoute(
      { kind: "compute_screenshot", params: {} },
      "darwin",
    );
    expect(decision).toMatchObject({
      status: "selected",
      selection: { transport: "desktop-ax" },
    });
    expect(
      decision.candidates.find((candidate) => candidate.transport === "visual"),
    ).toMatchObject({
      automatic: false,
      selected: false,
      reason: "requires explicit visual route",
    });
  });

  it("describes screenshot capture at action granularity", () => {
    expect(
      planComputeRoute(
        { kind: "compute_screenshot", params: { app: "Editor" } },
        "darwin",
      ),
    ).toMatchObject({
      status: "selected",
      selection: {
        transport: "desktop-ax",
        operator: "visual-observation",
        perception: "pixels",
        actuation: "screen-capture",
        verification: "pixel-observation",
      },
    });
  });

  it.each([
    ["native", "desktop-ax", "native-window"],
    ["browser", "cdp-browser", "browser-renderer"],
    ["driver", "cua-driver", "desktop"],
    ["visual", "visual", "desktop"],
  ] as const)(
    "keeps screenshot operator visual-observation through the %s provider",
    (via, transport, targetScope) => {
      const params =
        via === "native"
          ? { via, app: "Editor" }
          : via === "browser"
            ? { via, port: 9222, targetId: "page-1" }
            : { via };
      expect(
        planComputeRoute({ kind: "compute_screenshot", params }, "darwin"),
      ).toMatchObject({
        status: "selected",
        selection: {
          transport,
          operator: "visual-observation",
          target_scope: targetScope,
          perception: "pixels",
          actuation: "screen-capture",
        },
      });
    },
  );

  it("describes an untargeted native screenshot as desktop-scoped", () => {
    expect(
      planComputeRoute({ kind: "compute_screenshot", params: {} }, "darwin"),
    ).toMatchObject({
      status: "selected",
      selection: {
        operator: "visual-observation",
        target_scope: "desktop",
      },
    });
  });

  it("describes a global Linux key path without claiming native-window scope", () => {
    expect(
      planComputeRoute(
        { kind: "compute_press", params: { combo: "ctrl+l" } },
        "linux",
      ),
    ).toMatchObject({
      status: "selected",
      selection: {
        transport: "desktop-atspi",
        actuation: "desktop-input",
        target_scope: "desktop",
        interaction_impact: "foreground",
      },
    });
  });

  it("allows explicit pixels after fresh accessibility perception", () => {
    const decision = planComputeRoute(
      {
        kind: "compute_click",
        params: {
          stable: "desktop-ax:window-7:AXWindow[0]/AXButton[0]",
          x: 100,
          y: 50,
          via: "visual",
        },
      },
      "darwin",
    );
    expect(decision).toMatchObject({
      status: "selected",
      selection: {
        transport: "visual",
        perception: "pixels",
        actuation: "coordinate-action",
        evidence_transport: "desktop-ax",
        explicit: true,
      },
    });
  });

  it("rejects a cross-provider ref route without a declared evidence bridge", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_type",
          params: {
            stable: "desktop-ax:window-7:AXWindow[0]/AXTextField[0]",
            text: "hello",
            via: "visual",
          },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "ref owner desktop-ax conflicts with requested provider visual",
    });
  });

  it("rejects a native route carrying browser-only target evidence", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_click",
          params: {
            selector: "#submit",
            port: 9222,
            via: "native",
          },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "unavailable",
      reason:
        "browser target evidence conflicts with requested provider desktop-ax",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          transport: "desktop-ax",
          feasible: false,
        }),
        expect.objectContaining({
          transport: "cdp-browser",
          feasible: true,
        }),
      ]),
    });
  });

  it("rejects a browser route that would ignore native window identity", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_screenshot",
          params: {
            app: "Figma",
            windowId: 42,
            via: "browser",
          },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "unavailable",
      reason:
        "native pid/window target evidence conflicts with the browser renderer provider",
    });
  });

  it("requires an exact CDP binding when a browser action names an app", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_screenshot",
          params: {
            app: "Figma",
            via: "browser",
          },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "unavailable",
      reason:
        'app target "Figma" does not identify a CDP renderer for compute_screenshot',
    });
  });

  it("allows an Electron app name for the intrinsic CDP attach operation", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_cdp_attach",
          params: { app: "Code" },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "selected",
      selection: {
        transport: "cdp-browser",
        physical_action: "cdp_attach",
      },
    });
  });

  it("rejects visual routing that would silently ignore an app target", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_screenshot",
          params: { app: "Figma", via: "visual" },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "unavailable",
      reason:
        "the visual provider is desktop-scoped and cannot honor an app, window, or renderer target",
    });
  });

  it("does not mislabel a pixel screenshot as an accessibility snapshot", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_snapshot",
          params: { via: "visual" },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "unavailable",
      requested_via: "visual",
      reason: "provider visual does not implement compute_snapshot on darwin",
    });
  });

  it("rejects contradictory implicit browser and native-window evidence", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_snapshot",
          params: { port: 9222, windowId: 42 },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "unavailable",
      reason:
        "native pid/window target evidence conflicts with the browser renderer provider",
    });
  });

  it("treats launch as a process operation and does not include recovery order", () => {
    expect(
      planComputeRoute(
        { kind: "compute_launch", params: { app: "Editor" } },
        "linux",
      ),
    ).toMatchObject({
      status: "selected",
      selection: {
        transport: "subprocess",
        operator: "native-cli",
        reason: "launch is a process operation",
      },
    });
  });

  it("does not misclassify app launch as accessibility actuation", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_launch",
          params: { app: "Editor", via: "native" },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "provider desktop-ax does not implement compute_launch on darwin",
    });
  });

  it("adapts the logical action and removes route-only parameters", () => {
    const decision = planComputeRoute(
      {
        kind: "compute_click",
        params: { ref: "@e1", via: "native" },
      },
      "darwin",
    );
    expect(decision.status).toBe("selected");
    if (decision.status !== "selected") return;
    expect(
      adaptComputeAction(
        {
          kind: "compute_click",
          params: { ref: "@e1", via: "native" },
        },
        decision.selection,
      ),
    ).toEqual({
      kind: "ax_press",
      params: { ref: "@e1" },
    });
  });

  it("uses compiled O(1) physical-action lookup", () => {
    expect(computePhysicalAction("desktop-atspi", "compute_click")).toBe(
      "atspi_invoke",
    );
    expect(computePhysicalAction("subprocess", "compute_screenshot")).toBe(
      undefined,
    );
  });

  it("requires an explicit provider for an absolute point action", () => {
    const decision = planComputeRoute(
      { kind: "compute_point_click", params: { x: 10, y: 20 } },
      "darwin",
    );
    expect(decision).toMatchObject({
      status: "unavailable",
      reason: "no implicit provider is defined for compute_point_click",
    });
    expect(decision.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transport: "cua-driver",
          automatic: false,
          selected: false,
        }),
        expect.objectContaining({
          transport: "visual",
          automatic: false,
          selected: false,
        }),
      ]),
    );
  });

  it("selects Cua Driver only when the coordinate route is explicit", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_point_click",
          params: { x: 10, y: 20, via: "driver" },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "selected",
      selection: {
        transport: "cua-driver",
        route: "driver",
        operator: "visual-coordinate",
        target_scope: "desktop",
        physical_action: "cua_click",
        verification: "provider-effect",
        interaction_impact: "foreground",
        explicit: true,
      },
    });
  });

  it("treats Cua Driver screenshot capture as background observation", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_screenshot",
          params: { via: "driver" },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "selected",
      selection: {
        transport: "cua-driver",
        physical_action: "cua_get_desktop_state",
        verification: "pixel-observation",
        interaction_impact: "background",
      },
    });
  });

  it("does not send an element ref to the desktop-scoped driver", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_click",
          params: {
            ref: "desktop-ax:window-42:Window[0]/Button[0]",
            via: "driver",
          },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "provider cua-driver does not implement compute_click on darwin",
    });
  });

  it("treats driver session lifecycle as explicit by command identity", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_session_start",
          params: { session: "agent-run", captureScope: "auto" },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "selected",
      requested_via: "driver",
      selection: {
        transport: "cua-driver",
        physical_action: "cua_start_session",
        operator: "local-runtime",
        perception: "local-state",
        actuation: "protocol-call",
        target_scope: "local-runtime",
        verification: "local-result",
        interaction_impact: "background",
        explicit: true,
      },
    });
  });

  it("routes driver reads and presentation controls by explicit command identity", () => {
    expect(
      planComputeRoute({ kind: "compute_screen_size", params: {} }, "darwin"),
    ).toMatchObject({
      status: "selected",
      requested_via: "driver",
      selection: {
        physical_action: "cua_get_screen_size",
        actuation: "none",
        interaction_impact: "background",
      },
    });
    expect(
      planComputeRoute(
        {
          kind: "compute_agent_cursor_theme",
          params: { session: "run-7", themeId: "high-contrast" },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "selected",
      requested_via: "driver",
      selection: {
        physical_action: "cua_set_agent_cursor_theme",
        operator: "local-runtime",
        actuation: "protocol-call",
        interaction_impact: "background",
      },
    });
  });

  it("refuses a visual screenshot path instead of ignoring the file contract", () => {
    expect(
      planComputeRoute(
        {
          kind: "compute_screenshot",
          params: { path: "/tmp/frame.png", via: "visual" },
        },
        "darwin",
      ),
    ).toMatchObject({
      status: "unavailable",
      reason: "the visual backend does not implement screenshot file writes",
    });
  });
});
