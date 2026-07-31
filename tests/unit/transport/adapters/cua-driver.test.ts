import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createTransportBus } from "../../../../src/transport/bus.js";
import {
  CuaDriverTransport,
  type CuaDriverInvocation,
} from "../../../../src/transport/adapters/cua-driver.js";
import {
  CUA_DRIVER_OPERATION_SPECS,
  probeCuaDriverFeatures,
} from "../../../../src/transport/adapters/cua-driver-contract.js";

function completed(
  value: Record<string, unknown>,
  exitCode = 0,
): {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: null;
} {
  return {
    stdout: JSON.stringify(value),
    stderr: exitCode === 0 ? "" : "provider failed",
    exitCode,
    signal: null,
  };
}

function desktopState(
  image: Buffer | { path: string },
): Record<string, unknown> {
  return {
    platform: "macos",
    display: "main",
    screenshot_width: 1,
    screenshot_height: 1,
    screen_width: 1,
    screen_height: 1,
    scale_factor: 1,
    screenshot_mime_type: "image/png",
    ...(Buffer.isBuffer(image)
      ? { screenshot_png_b64: image.toString("base64") }
      : { screenshot_file_path: image.path }),
  };
}

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

const CUA_INPUTS: Record<string, { properties: string[]; required: string[] }> =
  {
    click: {
      properties: ["x", "y", "button", "count", "scope", "session"],
      required: ["x", "y", "scope"],
    },
    drag: {
      properties: [
        "from_x",
        "from_y",
        "to_x",
        "to_y",
        "button",
        "duration_ms",
        "modifier",
        "steps",
        "scope",
        "session",
      ],
      required: ["from_x", "from_y", "to_x", "to_y", "scope"],
    },
    type_text: {
      properties: ["text", "scope", "session"],
      required: ["text", "scope"],
    },
    press_key: {
      properties: ["key", "modifiers", "scope", "session"],
      required: ["key", "scope"],
    },
    hotkey: {
      properties: ["keys", "scope", "session"],
      required: ["keys", "scope"],
    },
    scroll: {
      properties: ["x", "y", "direction", "amount", "by", "scope", "session"],
      required: ["x", "y", "direction", "scope"],
    },
    get_desktop_state: {
      properties: ["screenshot_out_file", "session"],
      required: [],
    },
    get_screen_size: {
      properties: ["session"],
      required: [],
    },
    get_cursor_position: {
      properties: ["session"],
      required: [],
    },
    move_cursor: {
      properties: ["x", "y", "scope", "session"],
      required: ["x", "y", "scope"],
    },
    start_session: {
      properties: ["session", "capture_scope", "cursor_theme"],
      required: ["session"],
    },
    get_session_state: {
      properties: ["session"],
      required: ["session"],
    },
    escalate_session: {
      properties: ["session", "reason", "detail"],
      required: ["session", "reason"],
    },
    end_session: {
      properties: ["session"],
      required: ["session"],
    },
    get_agent_cursor_state: {
      properties: ["session"],
      required: ["session"],
    },
    set_agent_cursor_enabled: {
      properties: ["session", "enabled"],
      required: ["session", "enabled"],
    },
    set_agent_cursor_motion: {
      properties: [
        "session",
        "start_handle",
        "end_handle",
        "arc_size",
        "arc_flow",
        "spring",
        "glide_duration_ms",
        "dwell_after_click_ms",
        "idle_hide_ms",
        "turn_radius",
      ],
      required: ["session"],
    },
    set_agent_cursor_theme: {
      properties: ["session", "theme_id", "reduced_motion"],
      required: ["session", "theme_id"],
    },
  };

function cuaDocs(): Record<string, unknown> {
  return {
    version: "0.14.1",
    tools: Object.entries(CUA_INPUTS).map(([name, fields]) => ({
      name,
      input_schema: {
        type: "object",
        properties: Object.fromEntries(
          fields.properties.map((field) => [field, {}]),
        ),
        required: fields.required,
      },
    })),
  };
}

describe("CuaDriverTransport", () => {
  const primaryManifestPath = resolve(
    "ref/agent-control-plane/cua/libs/cua-driver/contract/manifest.json",
  );

  it.runIf(existsSync(primaryManifestPath))(
    "matches the checked-out primary Cua manifest tool, property, capability, and nullable-motion surface",
    () => {
      const manifest = JSON.parse(
        readFileSync(primaryManifestPath, "utf8"),
      ) as {
        contract_version: string;
        tools: Array<{
          name: string;
          capabilities: string[];
          input_schema: {
            properties: Record<string, { type?: unknown }>;
          };
        }>;
      };
      const upstream = new Map(manifest.tools.map((tool) => [tool.name, tool]));

      expect(manifest.contract_version).toBe("0.2.0");
      expect([...upstream.keys()].sort()).toEqual(
        Object.keys(CUA_DRIVER_OPERATION_SPECS).sort(),
      );
      for (const [name, spec] of Object.entries(CUA_DRIVER_OPERATION_SPECS)) {
        const tool = upstream.get(name);
        expect(tool, name).toBeDefined();
        expect(Object.keys(tool!.input_schema.properties).sort()).toEqual(
          [...spec.input.properties].sort(),
        );
        expect(tool!.capabilities).toEqual(spec.capabilities);
      }
      for (const field of [
        "start_handle",
        "end_handle",
        "arc_size",
        "arc_flow",
        "spring",
        "glide_duration_ms",
        "dwell_after_click_ms",
        "idle_hide_ms",
        "turn_radius",
      ]) {
        expect(
          upstream.get("set_agent_cursor_motion")!.input_schema.properties[
            field
          ]?.type,
        ).toEqual(["number", "null"]);
      }
    },
  );

  it("feature-probes the live provider schemas used by Uni-CLI", () => {
    const compatible = probeCuaDriverFeatures(cuaDocs());
    const missingScope = cuaDocs();
    const tools = missingScope.tools as Array<Record<string, unknown>>;
    const click = tools.find((tool) => tool.name === "click")!;
    const schema = click.input_schema as Record<string, unknown>;
    delete (schema.properties as Record<string, unknown>).scope;
    const incompatible = probeCuaDriverFeatures(missingScope);

    expect(compatible).toMatchObject({
      ok: true,
      providerVersion: "0.14.1",
      observedToolCount: 18,
      requiredToolCount: 18,
    });
    expect(incompatible).toMatchObject({
      ok: false,
      incompatibleInputs: [
        { tool: "click", field: "scope", reason: "missing_property" },
      ],
    });

    const wrongScope = cuaDocs();
    const wrongTools = wrongScope.tools as Array<Record<string, unknown>>;
    const wrongClick = wrongTools.find((tool) => tool.name === "click")!;
    const wrongSchema = wrongClick.input_schema as Record<string, unknown>;
    (wrongSchema.properties as Record<string, unknown>).scope = {
      const: "window",
    };
    expect(probeCuaDriverFeatures(wrongScope)).toMatchObject({
      ok: false,
      incompatibleInputs: [
        { tool: "click", field: "$sample", reason: "schema_rejected" },
      ],
    });

    for (const [toolName, forcedField] of [
      ["click", "session"],
      ["get_desktop_state", "screenshot_out_file"],
      ["escalate_session", "detail"],
    ] as const) {
      const restrictive = cuaDocs();
      const restrictiveTools = restrictive.tools as Array<
        Record<string, unknown>
      >;
      const tool = restrictiveTools.find(
        (candidate) => candidate.name === toolName,
      )!;
      const inputSchema = tool.input_schema as Record<string, unknown>;
      inputSchema.required = [
        ...((inputSchema.required as string[]) ?? []),
        forcedField,
      ];
      expect(probeCuaDriverFeatures(restrictive)).toMatchObject({
        ok: false,
        incompatibleInputs: expect.arrayContaining([
          {
            tool: toolName,
            field: "$sample",
            reason: "schema_rejected",
          },
        ]),
      });
    }
  });

  it("maps an explicit point click to portable desktop contract 0.2.0", async () => {
    // REASON: the external Cua daemon boundary is replaced; argument compilation and the real transport shell remain under test.
    const runner = vi
      .fn<
        (
          invocation: CuaDriverInvocation,
        ) => Promise<ReturnType<typeof completed>>
      >()
      .mockResolvedValue(
        completed({ x: 12, y: 34, scope: "desktop", verified: true }),
      );
    const adapter = new CuaDriverTransport({
      command: "/opt/bin/cua-driver",
      argsPrefix: ["--socket", "/tmp/cua.sock"],
      runner,
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const result = await adapter.action<Record<string, unknown>>({
      kind: "cua_click",
      params: {
        x: 12,
        y: 34,
        button: "middle",
        count: 3,
        session: "run-7",
      },
      canMutate: false,
    });

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "/opt/bin/cua-driver",
        canMutate: true,
        args: [
          "--socket",
          "/tmp/cua.sock",
          "call",
          "click",
          '{"x":12,"y":34,"button":"middle","count":3,"scope":"desktop","session":"run-7"}',
        ],
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        provider: "cua-driver",
        minimum_contract_version: "0.2.0",
        tool: "click",
        verified: true,
      },
      effect_verdict: {
        status: "confirmed",
        evidence: "postcondition_observation",
      },
    });
  });

  it("uses press_key for one key and hotkey for a chord", async () => {
    const invocations: CuaDriverInvocation[] = [];
    const adapter = new CuaDriverTransport({
      // REASON: the external daemon is replaced to make the portable tool selection deterministic.
      runner: async (invocation) => {
        invocations.push(invocation);
        return completed({ verified: true });
      },
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    await adapter.action({
      kind: "cua_press",
      params: { combo: "Return", modifiers: ["Shift"] },
      canMutate: true,
    });
    await adapter.action({
      kind: "cua_press",
      params: { combo: "cmd+shift+p" },
      canMutate: true,
    });

    expect(invocations.map((invocation) => invocation.args[1])).toEqual([
      "press_key",
      "hotkey",
    ]);
    expect(JSON.parse(invocations[1]!.args[2]!)).toEqual({
      keys: ["cmd", "shift", "p"],
      scope: "desktop",
    });
    expect(JSON.parse(invocations[0]!.args[2]!)).toEqual({
      key: "Return",
      modifiers: ["Shift"],
      scope: "desktop",
    });
  });

  it("preserves the full portable drag parameter surface", async () => {
    const invocations: CuaDriverInvocation[] = [];
    const adapter = new CuaDriverTransport({
      // REASON: deterministic external daemon replacement exposes the compiled portable drag request.
      runner: async (invocation) => {
        invocations.push(invocation);
        return completed({ effect: "unverifiable", scope: "desktop" });
      },
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const result = await adapter.action({
      kind: "cua_drag",
      params: {
        fromX: 1,
        fromY: 2,
        toX: 3,
        toY: 4,
        button: "middle",
        durationMs: 500,
        modifier: ["Shift"],
        steps: 20,
      },
      canMutate: false,
    });

    expect(result.ok).toBe(true);
    expect(invocations[0]?.canMutate).toBe(true);
    expect(JSON.parse(invocations[0]!.args[2]!)).toEqual({
      from_x: 1,
      from_y: 2,
      to_x: 3,
      to_y: 4,
      button: "middle",
      duration_ms: 500,
      modifier: ["Shift"],
      steps: 20,
      scope: "desktop",
    });
  });

  it("maps every remaining portable 0.2.0 tool including presentation cursor controls", async () => {
    const invocations: CuaDriverInvocation[] = [];
    const motion = {
      start_handle: 1,
      end_handle: 2,
      arc_size: 3,
      arc_flow: 4,
      spring: 5,
      glide_duration_ms: 6,
      dwell_after_click_ms: 7,
      idle_hide_ms: 8,
      turn_radius: 9,
    };
    const theme = {
      id: "high-contrast",
      version: "1",
      profile: "default",
      reduced_motion: "on",
      fallback: null,
    };
    const adapter = new CuaDriverTransport({
      // REASON: all 0.2.0 physical tool boundaries are replaced so request compilation and output settlement can be checked in one deterministic matrix.
      runner: async (invocation) => {
        invocations.push(invocation);
        const tool = invocation.args[1];
        if (tool === "get_screen_size") {
          return completed({ width: 1920, height: 1080, scale_factor: 2 });
        }
        if (tool === "get_cursor_position") {
          return completed({ x: 10, y: 20, available: true, source: "hid" });
        }
        if (tool === "move_cursor") {
          return completed({ x: 30, y: 40, scope: "desktop" });
        }
        if (tool === "get_agent_cursor_state") {
          return completed({
            session: "run-7",
            enabled: true,
            position: { x: 30, y: 40 },
            theme,
            visual_state: {
              requested_action: "idle",
              resolved_action: "idle",
              modifiers: [],
              phase: "settled",
              frame: 1,
              preempted_count: 0,
            },
            motion,
          });
        }
        if (tool === "set_agent_cursor_enabled") {
          return completed({ session: "run-7", enabled: false });
        }
        if (tool === "set_agent_cursor_motion") {
          return completed({ session: "run-7", motion });
        }
        return completed({ session: "run-7", theme });
      },
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const requests = [
      {
        kind: "cua_get_screen_size",
        params: { session: "run-7" },
        canMutate: false,
      },
      {
        kind: "cua_get_cursor_position",
        params: { session: "run-7" },
        canMutate: false,
      },
      {
        kind: "cua_move_cursor",
        params: { x: 30, y: 40, session: "run-7" },
        canMutate: false,
      },
      {
        kind: "cua_get_agent_cursor_state",
        params: { session: "run-7" },
        canMutate: false,
      },
      {
        kind: "cua_set_agent_cursor_enabled",
        params: { session: "run-7", enabled: false },
        canMutate: false,
      },
      {
        kind: "cua_set_agent_cursor_motion",
        params: { session: "run-7", spring: 5 },
        canMutate: false,
      },
      {
        kind: "cua_set_agent_cursor_theme",
        params: {
          session: "run-7",
          themeId: "high-contrast",
          reducedMotion: "on",
        },
        canMutate: false,
      },
    ] as const;
    const results = [];
    for (const request of requests) {
      results.push(await adapter.action(request));
    }

    expect(results.every((result) => result.ok)).toBe(true);
    expect(invocations.map((invocation) => invocation.args[1])).toEqual([
      "get_screen_size",
      "get_cursor_position",
      "move_cursor",
      "get_agent_cursor_state",
      "set_agent_cursor_enabled",
      "set_agent_cursor_motion",
      "set_agent_cursor_theme",
    ]);
    expect(invocations.map((invocation) => invocation.canMutate)).toEqual([
      false,
      false,
      true,
      false,
      true,
      true,
      true,
    ]);
    expect(JSON.parse(invocations[5]!.args[2]!)).toEqual({
      session: "run-7",
      spring: 5,
    });
    expect(JSON.parse(invocations[6]!.args[2]!)).toEqual({
      session: "run-7",
      theme_id: "high-contrast",
      reduced_motion: "on",
    });
  });

  it("rejects malformed coordinate input before the provider is invoked", async () => {
    const runner = vi.fn();
    const adapter = new CuaDriverTransport({ runner });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const result = await adapter.action({
      kind: "cua_click",
      params: { x: Number.NaN, y: 2 },
      canMutate: true,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: {
        transport: "cua-driver",
        exit_code: 2,
      },
      effect_verdict: {
        status: "suspected_noop",
        evidence: "pre_dispatch_rejection",
      },
    });
  });

  it("fails closed when an installed provider violates structured output", async () => {
    const adapter = new CuaDriverTransport({
      // REASON: provider stdout is the external contract boundary being malformed deliberately.
      runner: async () => ({
        stdout: "click complete",
        stderr: "",
        exitCode: 0,
        signal: null,
      }),
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const result = await adapter.action({
      kind: "cua_click",
      params: { x: 1, y: 2 },
      canMutate: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        minimum_capability: "cua-driver.contract.0.2.0",
        retryable: false,
      },
      effect_verdict: {
        status: "unverifiable",
      },
    });
  });

  it("keeps an unverified provider success distinct from a suspected no-op", async () => {
    const adapter = new CuaDriverTransport({
      // REASON: deterministic external verification response.
      runner: async () => completed({ verified: false, scope: "desktop" }),
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const result = await adapter.action({
      kind: "cua_type_text",
      params: { text: "hello" },
      canMutate: true,
    });

    expect(result).toMatchObject({
      ok: true,
      effect_verdict: {
        status: "unverifiable",
        evidence: "dispatch_receipt",
      },
    });
  });

  it.each(["drag", "type_text", "press_key", "hotkey", "scroll"])(
    "accepts official macOS %s HID receipts without a verified field",
    async (tool) => {
      const adapter = new CuaDriverTransport({
        // REASON: official portable 0.2.0 action fields are optional, and macOS HID receipts omit verified.
        runner: async () =>
          completed({
            scope: "desktop",
            path: "hid",
            effect: "unverifiable",
          }),
      });
      const bus = createTransportBus();
      await adapter.open({ vars: {}, bus });
      const requestByTool = {
        drag: {
          kind: "cua_drag",
          params: { fromX: 1, fromY: 2, toX: 3, toY: 4 },
        },
        type_text: { kind: "cua_type_text", params: { text: "hello" } },
        press_key: { kind: "cua_press", params: { key: "Return" } },
        hotkey: { kind: "cua_press", params: { combo: "cmd+p" } },
        scroll: {
          kind: "cua_scroll",
          params: { x: 1, y: 2, direction: "down" },
        },
      } as const;

      const result = await adapter.action({
        ...requestByTool[tool as keyof typeof requestByTool],
        canMutate: true,
      });

      expect(result).toMatchObject({
        ok: true,
        effect_verdict: { status: "unverifiable" },
      });
    },
  );

  it("accepts a portable click receipt without optional coordinate echoes", async () => {
    const adapter = new CuaDriverTransport({
      // REASON: ClickOutput x/y/scope/verified are optional in portable contract 0.2.0.
      runner: async () => completed({ path: "hid" }),
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const result = await adapter.action({
      kind: "cua_click",
      params: { x: 1, y: 2 },
      canMutate: true,
    });

    expect(result).toMatchObject({
      ok: true,
      effect_verdict: { status: "unverifiable" },
    });
  });

  it("preserves the provider's explicit suspected-noop effect", async () => {
    const adapter = new CuaDriverTransport({
      // REASON: deterministic external action-confidence response.
      runner: async () =>
        completed({
          verified: false,
          effect: "suspected_noop",
          scope: "desktop",
        }),
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const result = await adapter.action({
      kind: "cua_type_text",
      params: { text: "hello" },
      canMutate: true,
    });

    expect(result).toMatchObject({
      ok: true,
      effect_verdict: {
        status: "suspected_noop",
        evidence: "provider_noop_signal",
      },
    });
  });

  it("preserves deferred provider settlement as pending", async () => {
    const adapter = new CuaDriverTransport({
      // REASON: deterministic external deferred-effect response.
      runner: async () =>
        completed({
          verified: false,
          effect: "pending",
          scope: "desktop",
        }),
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const result = await adapter.action({
      kind: "cua_type_text",
      params: { text: "hello" },
      canMutate: true,
    });

    expect(result).toMatchObject({
      ok: true,
      effect_verdict: {
        status: "pending",
        evidence: "accepted_deferred_observation",
      },
    });
  });

  it("decodes inline desktop pixels through the snapshot contract", async () => {
    const adapter = new CuaDriverTransport({
      // REASON: deterministic external screenshot response.
      runner: async () => completed(desktopState(PNG_BYTES)),
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const snapshot = await adapter.snapshot();

    expect(snapshot).toMatchObject({
      format: "screenshot",
      width: 1,
      height: 1,
    });
    expect(snapshot.data).toEqual(PNG_BYTES);
  });

  it("treats a desktop-state file artifact as a mutation at the transport boundary", async () => {
    const invocations: CuaDriverInvocation[] = [];
    const adapter = new CuaDriverTransport({
      // REASON: the external daemon is replaced to inspect mutation containment without writing a real file.
      runner: async (invocation) => {
        invocations.push(invocation);
        return completed(desktopState({ path: "/tmp/frame.png" }));
      },
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const result = await adapter.action({
      kind: "cua_get_desktop_state",
      params: { path: "/tmp/frame.png" },
    });

    expect(invocations[0]?.canMutate).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      effect_verdict: {
        status: "unverifiable",
      },
    });
  });

  it.each([
    [
      "invalid verified type",
      { scope: "desktop", verified: "yes", effect: "confirmed" },
    ],
    [
      "explicit unverifiable conflict",
      { scope: "desktop", verified: true, effect: "unverifiable" },
    ],
    ["wrong action scope", { scope: "window", verified: true }],
    ["wrong click echo", { x: 9, y: 2, scope: "desktop" }],
  ])("rejects exit-zero %s as a contract violation", async (_label, output) => {
    const adapter = new CuaDriverTransport({
      // REASON: malformed provider output is the external contract boundary under test.
      runner: async () => completed(output),
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const result = await adapter.action(
      _label === "wrong click echo"
        ? {
            kind: "cua_click",
            params: { x: 1, y: 2 },
            canMutate: true,
          }
        : {
            kind: "cua_type_text",
            params: { text: "hello" },
            canMutate: true,
          },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        minimum_capability: "cua-driver.contract.0.2.0",
        exit_code: 78,
      },
      effect_verdict: { status: "unverifiable" },
    });
  });

  it.each([
    { effect: "refused", verified: false, scope: "desktop" },
    { status: "refused", verified: false, scope: "desktop" },
    {
      refusal: { code: "permission_denied", facility: "accessibility" },
    },
  ])(
    "settles an exit-zero provider refusal as suspected-noop",
    async (output) => {
      const adapter = new CuaDriverTransport({
        // REASON: Cua tool refusals can arrive on exit-zero stdout.
        runner: async () => completed(output),
      });
      const bus = createTransportBus();
      await adapter.open({ vars: {}, bus });

      const result = await adapter.action({
        kind: "cua_type_text",
        params: { text: "hello" },
        canMutate: true,
      });

      expect(result).toMatchObject({
        ok: false,
        error: {
          minimum_capability: "cua-driver.type_text.refused",
        },
        effect_verdict: {
          status: "suspected_noop",
          evidence: "provider_refusal",
        },
      });
    },
  );

  it("confirms an exact authoritative session lifecycle receipt", async () => {
    const invocations: CuaDriverInvocation[] = [];
    const adapter = new CuaDriverTransport({
      // REASON: deterministic external session-state response.
      runner: async (invocation) => {
        invocations.push(invocation);
        return completed({
          session: "run-7",
          capture_scope: "desktop",
          effective_scope: "desktop",
          desktop_unlocked: true,
          escalation_reason: null,
          escalation_detail: null,
          active: true,
          revived: false,
        });
      },
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const result = await adapter.action({
      kind: "cua_start_session",
      params: {
        session: "run-7",
        captureScope: "desktop",
        cursorThemeId: "high-contrast",
        reducedMotion: "on",
      },
      canMutate: true,
    });

    expect(result).toMatchObject({
      ok: true,
      effect_verdict: {
        status: "confirmed",
        evidence: "authoritative_response",
      },
    });
    expect(JSON.parse(invocations[0]!.args[2]!)).toEqual({
      session: "run-7",
      capture_scope: "desktop",
      cursor_theme: {
        theme_id: "high-contrast",
        reduced_motion: "on",
      },
    });
  });

  it.each([
    {
      label: "start capture scope",
      request: {
        kind: "cua_start_session",
        params: { session: "run-7", captureScope: "desktop" },
      },
      output: {
        session: "run-7",
        capture_scope: "auto",
        effective_scope: "window",
        desktop_unlocked: false,
        escalation_reason: null,
        escalation_detail: null,
        active: true,
        revived: false,
      },
    },
    {
      label: "escalation reason",
      request: {
        kind: "cua_escalate_session",
        params: {
          session: "run-7",
          reason: "foreground_ineffective",
          detail: "expected",
        },
      },
      output: {
        session: "run-7",
        capture_scope: "auto",
        effective_scope: "desktop",
        desktop_unlocked: true,
        escalation_reason: "other",
        escalation_detail: "different",
      },
    },
    {
      label: "absent escalation detail",
      request: {
        kind: "cua_escalate_session",
        params: { session: "run-7", reason: "other" },
      },
      output: {
        session: "run-7",
        capture_scope: "auto",
        effective_scope: "desktop",
        desktop_unlocked: true,
        escalation_reason: "other",
        escalation_detail: "unexpected",
      },
    },
  ])("rejects lifecycle receipts that do not bind $label", async (fixture) => {
    const adapter = new CuaDriverTransport({
      // REASON: authoritative session receipts must bind the requested lifecycle transition.
      runner: async () => completed(fixture.output),
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    const result = await adapter.action({
      ...fixture.request,
      canMutate: true,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        minimum_capability: "cua-driver.contract.0.2.0",
      },
    });
  });

  it("rejects invalid inline screenshot bytes before returning a snapshot", async () => {
    const adapter = new CuaDriverTransport({
      // REASON: invalid provider image bytes exercise screenshot contract validation.
      runner: async () =>
        completed({
          ...desktopState(PNG_BYTES),
          screenshot_png_b64: "%%%%",
        }),
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    await expect(adapter.snapshot()).rejects.toMatchObject({
      minimum_capability: "cua-driver.contract.0.2.0",
    });
  });

  it("rejects PNG metadata that disagrees with the encoded IHDR dimensions", async () => {
    const adapter = new CuaDriverTransport({
      // REASON: coordinate safety depends on provider dimensions matching the actual screenshot frame.
      runner: async () =>
        completed({
          ...desktopState(PNG_BYTES),
          screenshot_width: 640,
          screenshot_height: 480,
        }),
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    await expect(adapter.snapshot()).rejects.toMatchObject({
      minimum_capability: "cua-driver.contract.0.2.0",
    });
  });

  it("rejects a PNG container with no image-data chunk", async () => {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write("IHDR", 4, "ascii");
    ihdr.writeUInt32BE(1, 8);
    ihdr.writeUInt32BE(1, 12);
    const iend = Buffer.alloc(12);
    iend.write("IEND", 4, "ascii");
    const noImageData = Buffer.concat([signature, ihdr, iend]);
    const adapter = new CuaDriverTransport({
      // REASON: a signature/IHDR/IEND shell without IDAT is not a decodable screenshot.
      runner: async () => completed(desktopState(noImageData)),
    });
    const bus = createTransportBus();
    await adapter.open({ vars: {}, bus });

    await expect(adapter.snapshot()).rejects.toMatchObject({
      minimum_capability: "cua-driver.contract.0.2.0",
    });
  });
});
