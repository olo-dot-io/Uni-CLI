import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ok, err } from "../../../src/core/envelope.js";
import { validateEnvelope } from "../../../src/output/envelope.js";
import { getBus } from "../../../src/transport/bus.js";
import { loadCdpSession } from "../../../src/transport/cdp-session.js";

const dispatchMock = vi.hoisted(() => ({
  dispatchComputeRoute: vi.fn(),
  prepareComputeRequest: vi.fn(),
}));
const actionExecutionMock = vi.hoisted(() => ({
  executeComputeAction: vi.fn(),
}));

vi.mock("../../../src/transport/compute-dispatch.js", () => ({
  dispatchComputeRoute: dispatchMock.dispatchComputeRoute,
  prepareComputeRequest: dispatchMock.prepareComputeRequest,
}));
vi.mock("../../../src/compute/action-execution.js", () => ({
  executeComputeAction: actionExecutionMock.executeComputeAction,
}));

const { registerComputeCommand } =
  await import("../../../src/commands/compute.js");

const originalRulesPath = process.env.UNICLI_PERMISSION_RULES_PATH;
const originalPermissionProfile = process.env.UNICLI_PERMISSION_PROFILE;
const originalApprove = process.env.UNICLI_APPROVE;

function captureConsole(): {
  getStdout: () => string;
  getStderr: () => string;
  restore: () => void;
} {
  let out = "";
  let error = "";
  const origLog = console.log;
  const origError = console.error;
  console.log = ((...args: unknown[]) => {
    out += `${args.map(String).join(" ")}\n`;
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    error += `${args.map(String).join(" ")}\n`;
  }) as typeof console.error;
  return {
    getStdout: () => out,
    getStderr: () => error,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

function newProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("-f, --format <fmt>", "output format");
  program.option("--permission-profile <profile>", "permission profile");
  program.option("--yes", "approve this operation");
  program.option("--remember-approval", "persist this approval");
  registerComputeCommand(program);
  return program;
}

function expectedNativeOverlayProvider():
  | "macos-appkit"
  | "windows-win32"
  | "linux-gtk"
  | undefined {
  if (process.platform === "darwin") return "macos-appkit";
  if (process.platform === "win32") return "windows-win32";
  if (process.platform === "linux") return "linux-gtk";
  return undefined;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("unicli compute", () => {
  beforeEach(() => {
    dispatchMock.dispatchComputeRoute.mockReset();
    dispatchMock.prepareComputeRequest.mockReset();
    dispatchMock.prepareComputeRequest.mockImplementation((_bus, request) => ({
      status: "ready",
      prepared: { request },
    }));
    actionExecutionMock.executeComputeAction.mockReset();
    process.exitCode = undefined;
    delete process.env.UNICLI_COMPUTE_REFS_PATH;
    delete process.env.UNICLI_COMPUTE_CDP_SESSION_PATH;
    delete process.env.UNICLI_APP_SHOTS_ROOT;
    restoreEnvironment("UNICLI_PERMISSION_RULES_PATH", originalRulesPath);
    restoreEnvironment("UNICLI_PERMISSION_PROFILE", originalPermissionProfile);
    restoreEnvironment("UNICLI_APPROVE", originalApprove);
  });

  it("explains one process route without opening a provider", async () => {
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "route",
          "launch",
          "--params",
          '{"app":"Calculator"}',
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute).not.toHaveBeenCalled();
    expect(cap.getStderr()).toBe("");
    const envelope = JSON.parse(cap.getStdout()) as {
      data: {
        schema_version: string;
        route: { selection: Record<string, unknown> };
      };
    };
    expect(envelope.data).toMatchObject({
      schema_version: "compute-route.v1",
      route: {
        status: "selected",
        selection: {
          transport: "subprocess",
          operator: "native-cli",
          target_scope: "host-process",
          physical_action: "launch_app",
        },
      },
    });
  });

  it("plans only the capture parts requested by include", async () => {
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "route",
          "capture",
          "--params",
          '{"include":"screenshot"}',
          "--via",
          "driver",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute).not.toHaveBeenCalled();
    expect(cap.getStderr()).toBe("");
    const envelope = JSON.parse(cap.getStdout()) as {
      data: {
        status: string;
        routes: Array<{
          action: string;
          status: string;
          selection: Record<string, unknown>;
        }>;
      };
    };
    expect(envelope.data).toMatchObject({
      status: "composite",
      routes: [
        {
          action: "compute_screenshot",
          status: "selected",
          selection: {
            transport: "cua-driver",
            physical_action: "cua_get_desktop_state",
            operator: "visual-observation",
          },
        },
      ],
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    delete process.env.UNICLI_COMPUTE_REFS_PATH;
    delete process.env.UNICLI_COMPUTE_CDP_SESSION_PATH;
    delete process.env.UNICLI_APP_SHOTS_ROOT;
    restoreEnvironment("UNICLI_PERMISSION_RULES_PATH", originalRulesPath);
    restoreEnvironment("UNICLI_PERMISSION_PROFILE", originalPermissionProfile);
    restoreEnvironment("UNICLI_APPROVE", originalApprove);
  });

  it("blocks direct CLI computer actions before transport or overlay setup", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-compute-cli-policy-"));
    try {
      const policyPath = join(tmp, "policy.json");
      writeFileSync(
        policyPath,
        JSON.stringify({
          schema_version: "2",
          default: "deny",
          rules: [],
        }),
        "utf-8",
      );
      process.env.UNICLI_PERMISSION_RULES_PATH = policyPath;
      const cap = captureConsole();
      try {
        await newProgram().parseAsync(
          ["-f", "json", "compute", "click", "@e7", "--overlay"],
          { from: "user" },
        );
      } finally {
        cap.restore();
      }

      expect(dispatchMock.dispatchComputeRoute).not.toHaveBeenCalled();
      expect(actionExecutionMock.executeComputeAction).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(77);
      const envelope = JSON.parse(cap.getStderr()) as {
        error?: Record<string, unknown>;
      };
      expect(envelope.error).toMatchObject({
        code: "permission_denied",
        minimum_capability: "permission.denied",
        exit_code: 77,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("snapshot forwards normalized options and emits a desktop envelope", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(
      ok({ text: '@e1 window "Calculator"' }),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "snapshot",
          "--app",
          "Calculator",
          "--format",
          "compact",
          "--interactive-only",
          "--max-depth",
          "3",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute).toHaveBeenCalledTimes(1);
    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_snapshot",
      params: {
        app: "Calculator",
        format: "compact",
        interactiveOnly: true,
        maxDepth: 3,
      },
    });
    expect(cap.getStderr()).toBe("");
    const env = JSON.parse(cap.getStdout()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.command).toBe("compute.snapshot");
    expect((env.meta as { surface?: string }).surface).toBe("desktop");
    expect(env.data).toEqual({ text: '@e1 window "Calculator"' });
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("parses point coordinates without converting them into element refs", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(
      ok({ provider: "cua-driver", verified: true }),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "point-click",
          "12.5",
          "48",
          "--button",
          "right",
          "--session",
          "agent-run",
          "--observation",
          `visual-observation:${"a".repeat(64)}`,
          "--via",
          "driver",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_point_click",
      params: {
        x: 12.5,
        y: 48,
        button: "right",
        count: 1,
        session: "agent-run",
        observation: `visual-observation:${"a".repeat(64)}`,
        via: "driver",
      },
    });
    expect(cap.getStderr()).toBe("");
  });

  it("routes session lifecycle through its dedicated compute contract", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(
      ok({ provider: "cua-driver", capture_scope: "auto" }),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "session-start",
          "agent-run",
          "--capture-scope",
          "auto",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_session_start",
      params: {
        session: "agent-run",
        captureScope: "auto",
        reducedMotion: "auto",
      },
    });
    expect(cap.getStderr()).toBe("");
  });

  it("preserves agent-cursor motion null reset through the CLI channel", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(
      ok({ provider: "cua-driver", session: "agent-run" }),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "agent-cursor-motion",
          "agent-run",
          "--spring",
          "null",
          "--turn-radius",
          "12.5",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_agent_cursor_motion",
      params: {
        session: "agent-run",
        spring: null,
        turn_radius: 12.5,
      },
    });
    expect(cap.getStderr()).toBe("");
  });

  it("surfaces transport cleanup failure instead of printing false success", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(ok({ captured: true }));
    const closeSpy = vi
      .spyOn(getBus().get("visual"), "close")
      .mockRejectedValueOnce(new Error("visual cleanup failed"));
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "snapshot", "--app", "Calculator"],
        { from: "user" },
      );
    } finally {
      cap.restore();
      closeSpy.mockRestore();
    }

    expect(cap.getStdout()).toBe("");
    expect(process.exitCode).toBe(69);
    const envelope = JSON.parse(cap.getStderr()) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "service_unavailable",
        message:
          "compute resource cleanup failed: visual: visual cleanup failed",
        minimum_capability: "compute.cleanup.service_unavailable",
        exit_code: 69,
      },
    });
    validateEnvelope(envelope as Parameters<typeof validateEnvelope>[0]);
  });

  it("preserves an action error while surfacing an adjacent cleanup error", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(
      err({
        transport: "desktop-ax",
        step: 1,
        action: "compute_snapshot",
        reason: "snapshot failed",
        suggestion: "inspect accessibility permission",
        minimum_capability: "desktop-ax.snapshot",
        exit_code: 75,
        retryable: true,
      }),
    );
    const closeSpy = vi
      .spyOn(getBus().get("visual"), "close")
      .mockRejectedValueOnce(new Error("visual cleanup failed"));
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "snapshot", "--app", "Calculator"],
        { from: "user" },
      );
    } finally {
      cap.restore();
      closeSpy.mockRestore();
    }

    expect(cap.getStdout()).toBe("");
    expect(process.exitCode).toBe(75);
    const envelope = JSON.parse(cap.getStderr()) as {
      error?: { message?: string; suggestion?: string; exit_code?: number };
    };
    expect(envelope.error).toMatchObject({
      message:
        "snapshot failed; cleanup also failed: visual: visual cleanup failed",
      suggestion:
        "inspect accessibility permission; inspect the failing compute resource cleanup",
      exit_code: 75,
    });
    validateEnvelope(envelope as Parameters<typeof validateEnvelope>[0]);
  });

  it("wait forwards the app, state, and bounded timeout contract", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(
      ok({ matched: true, state: "disappear", attempts: 2 }),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "wait",
          "--app",
          "Calculator",
          "--text",
          "Busy",
          "--state",
          "disappear",
          "--timeout",
          "250",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_wait",
      params: {
        app: "Calculator",
        text: "Busy",
        state: "disappear",
        timeoutMs: 250,
      },
    });
  });

  it.each([
    ["snapshot max depth", ["compute", "snapshot", "--max-depth", "1junk"]],
    ["capture max depth", ["compute", "capture", "--max-depth", "65"]],
    ["scroll amount", ["compute", "scroll", "@e1", "--amount", "3px"]],
    ["launch debug port", ["compute", "launch", "Code", "--debug-port", "9x"]],
    ["attach port", ["compute", "attach", "--port", "70000"]],
    [
      "observe top-k",
      ["compute", "observe", "save the document", "--top-k", "0"],
    ],
    [
      "wait timeout with trailing junk",
      [
        "compute",
        "wait",
        "--app",
        "Finder",
        "--text",
        "Ready",
        "--timeout",
        "1junk",
      ],
    ],
    [
      "wait timeout in exponent notation",
      [
        "compute",
        "wait",
        "--app",
        "Finder",
        "--text",
        "Ready",
        "--timeout",
        "1e3",
      ],
    ],
  ])("rejects invalid %s before transport dispatch", async (_label, argv) => {
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(["-f", "json", ...argv], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const envelope = JSON.parse(cap.getStderr()) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: "invalid_input", exit_code: 2, retryable: false },
    });
    expect(() =>
      validateEnvelope(envelope as Parameters<typeof validateEnvelope>[0]),
    ).not.toThrow();
    expect(dispatchMock.dispatchComputeRoute).not.toHaveBeenCalled();
  });

  it("observe forwards explicit app scope and a bounded candidate count", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(ok({ candidates: [] }));
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "observe",
          "save the document",
          "--app",
          "TextEdit",
          "--top-k",
          "7",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_observe",
      params: {
        goal: "save the document",
        app: "TextEdit",
        topK: 7,
      },
    });
  });

  it("capture combines snapshot and screenshot into one context packet", async () => {
    dispatchMock.dispatchComputeRoute
      .mockResolvedValueOnce(
        ok({
          format: "text",
          encoding: "compact",
          data: '@e1 button "5"',
          refs: {
            count: 1,
            scope: "window-4242",
            provenance: {
              records: [
                {
                  app: "Calculator",
                  windowId: 4242,
                },
              ],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        ok({
          path: "/tmp/calculator.png",
          mime: "image/png",
        }),
      );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "capture",
          "--app",
          "Calculator",
          "--format",
          "compact",
          "--max-depth",
          "4",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute).toHaveBeenCalledTimes(2);
    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_snapshot",
      params: {
        app: "Calculator",
        format: "compact",
        maxDepth: 4,
      },
    });
    expect(dispatchMock.dispatchComputeRoute.mock.calls[1]?.[1]).toEqual({
      kind: "compute_screenshot",
      params: {
        app: "Calculator",
        windowId: 4242,
      },
    });

    const env = JSON.parse(cap.getStdout()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.command).toBe("compute.capture");
    expect((env.meta as { surface?: string }).surface).toBe("desktop");
    expect(env.data).toMatchObject({
      schema_version: 1,
      app: "Calculator",
      windowId: 4242,
      includes: ["snapshot", "screenshot"],
      snapshot: {
        ok: true,
        data: {
          encoding: "compact",
          data: '@e1 button "5"',
          refs: {
            count: 1,
            scope: "window-4242",
            provenance: {
              records: [{ app: "Calculator", windowId: 4242 }],
            },
          },
        },
      },
      screenshot: {
        ok: true,
        data: {
          path: "/tmp/calculator.png",
          mime: "image/png",
        },
      },
      trajectory: {
        replayable: true,
        steps: [
          {
            index: 0,
            action: "compute_snapshot",
            params: {
              app: "Calculator",
              windowId: 4242,
              format: "compact",
              maxDepth: 4,
            },
            ok: true,
          },
          {
            index: 1,
            action: "compute_screenshot",
            params: { app: "Calculator", windowId: 4242 },
            ok: true,
          },
        ],
      },
      visual_timeline: {
        schema_version: 1,
        replayable: true,
        subject: { app: "Calculator" },
        events: [
          expect.objectContaining({ index: 0, state: "observe" }),
          expect.objectContaining({ index: 1, state: "wait" }),
          expect.objectContaining({ index: 2, state: "target" }),
          expect.objectContaining({ index: 3, state: "success" }),
        ],
      },
    });
    expect(typeof (env.data as Record<string, unknown>).captured_at).toBe(
      "string",
    );
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("refuses a replayable combined capture without exact snapshot identity", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValueOnce(
      ok({
        format: "text",
        encoding: "compact",
        data: '@e1 button "5"',
        refs: { count: 1, scope: "Calculator" },
      }),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "capture", "--app", "Calculator"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute).toHaveBeenCalledTimes(1);
    expect(cap.getStdout()).toBe("");
    const env = JSON.parse(cap.getStderr()) as Record<string, unknown>;
    expect(env).toMatchObject({
      ok: false,
      command: "compute.capture",
      error: {
        minimum_capability: "compute.capture.target_window",
        exit_code: 69,
        retryable: false,
        suggestion: expect.stringContaining("--window-id"),
      },
    });
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("capture enriches screenshot evidence with image metadata and coordinate space", async () => {
    const onePixelPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const onePixelPng = Buffer.from(onePixelPngBase64, "base64");
    dispatchMock.dispatchComputeRoute.mockResolvedValueOnce(
      ok({
        base64: onePixelPngBase64,
        mime: "image/png",
        bounds: { x: 10, y: 20, w: 0.5, h: 0.25 },
      }),
    );

    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "capture", "--include", "screenshot"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({
      schema_version: 1,
      includes: ["screenshot"],
      screenshot: {
        ok: true,
        data: {
          base64: onePixelPngBase64,
          mime: "image/png",
          image: {
            mime: "image/png",
            bytes: onePixelPng.length,
            sha256: createHash("sha256").update(onePixelPng).digest("hex"),
            width: 1,
            height: 1,
            coordinate_space: {
              kind: "image-pixels",
              origin: "top-left",
              native_screen_to_image: {
                input: {
                  kind: "screen-logical",
                  origin: "top-left",
                },
                bounds: {
                  x: 10,
                  y: 20,
                  width: 0.5,
                  height: 0.25,
                },
                affine: {
                  a: 2,
                  b: 0,
                  c: 0,
                  d: 4,
                  e: -20,
                  f: -80,
                },
              },
            },
          },
        },
      },
      visual_timeline: {
        coordinate_space: {
          kind: "image-pixels",
          origin: "top-left",
          width: 1,
          height: 1,
        },
        events: [
          expect.objectContaining({
            point: {
              x: 0,
              y: 0,
              coordinate_space: {
                kind: "image-pixels",
                origin: "top-left",
                width: 1,
                height: 1,
              },
            },
          }),
          expect.objectContaining({ state: "success" }),
        ],
      },
    });
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("capture rejects invalid include parts instead of falling back silently", async () => {
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "capture", "--include", "snapshot,screen"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    const env = JSON.parse(cap.getStderr()) as Record<string, unknown>;
    expect(env.ok).toBe(false);
    expect(env.command).toBe("compute.capture");
    expect((env.error as { message?: string }).message).toContain(
      "invalid capture include part: screen",
    );
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("capture rejects invalid snapshot format instead of falling back silently", async () => {
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "capture", "--format", "text"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    const env = JSON.parse(cap.getStderr()) as Record<string, unknown>;
    expect(env.ok).toBe(false);
    expect(env.command).toBe("compute.capture");
    expect((env.error as { message?: string }).message).toContain(
      "invalid snapshot format: text",
    );
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("snapshot rejects invalid format instead of falling back silently", async () => {
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "snapshot", "--format", "text"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    const env = JSON.parse(cap.getStderr()) as Record<string, unknown>;
    expect(env.ok).toBe(false);
    expect(env.command).toBe("compute.snapshot");
    expect((env.error as { message?: string }).message).toContain(
      "invalid snapshot format: text",
    );
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("capture can persist an app-shots reference for agent handoff", async () => {
    const referenceRoot = mkdtempSync(join(tmpdir(), "unicli-app-shots-root-"));
    process.env.UNICLI_APP_SHOTS_ROOT = referenceRoot;
    const onePixelPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    dispatchMock.dispatchComputeRoute
      .mockResolvedValueOnce(
        ok({
          encoding: "compact",
          data: '@e1 button "5"',
          refs: {
            count: 1,
            scope: "window-4242",
            provenance: {
              records: [{ app: "Calculator", windowId: 4242 }],
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        ok({
          base64: onePixelPngBase64,
          mime: "image/png",
        }),
      );

    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "capture",
          "--app",
          "Calculator",
          "--save-reference",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout()) as {
      ok?: boolean;
      data?: {
        reference?: {
          markup?: string;
          files?: { content?: string; image?: string; metadata?: string };
        };
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data?.reference?.markup).toMatch(/^\[app-shots image="/);
    expect(env.data?.reference?.markup).toContain(' content="');
    expect(env.data?.reference?.markup).toContain(' metadata="');
    expect(existsSync(env.data?.reference?.files?.content ?? "")).toBe(true);
    expect(existsSync(env.data?.reference?.files?.image ?? "")).toBe(true);
    expect(existsSync(env.data?.reference?.files?.metadata ?? "")).toBe(true);
    expect(
      readFileSync(env.data?.reference?.files?.content ?? "", "utf-8"),
    ).toContain('@e1 button "5"');
    rmSync(referenceRoot, { recursive: true, force: true });
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("capture can persist a reference under an explicit root", async () => {
    const referenceRoot = mkdtempSync(join(tmpdir(), "unicli-explicit-root-"));
    dispatchMock.dispatchComputeRoute.mockResolvedValueOnce(
      ok({
        encoding: "compact",
        data: '@e1 window "Calculator"',
      }),
    );

    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "capture",
          "--app",
          "Calculator",
          "--include",
          "snapshot",
          "--reference-root",
          referenceRoot,
          "--save-reference",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout()) as {
      ok?: boolean;
      data?: { reference?: { root?: string; files?: { metadata?: string } } };
    };
    expect(env.ok).toBe(true);
    expect(env.data?.reference?.root?.startsWith(referenceRoot)).toBe(true);
    expect(existsSync(env.data?.reference?.files?.metadata ?? "")).toBe(true);
    rmSync(referenceRoot, { recursive: true, force: true });
  });

  it("click emits a structured error and preserves the transport exit code", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(
      err({
        transport: "visual",
        step: 0,
        action: "compute_click",
        reason: "all transports failed: visual unavailable",
        suggestion: "inspect each transport: unicli doctor compute",
        minimum_capability: "compute.compute_click.provider_unavailable",
        exit_code: 69,
      }),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(["-f", "json", "compute", "click", "@e7"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    expect(process.exitCode).toBe(69);
    expect(cap.getStdout()).toBe("");
    const env = JSON.parse(cap.getStderr()) as Record<string, unknown>;
    expect(env.ok).toBe(false);
    expect(env.command).toBe("compute.click");
    expect(env.error).toMatchObject({
      code: "compute_failed",
      message: "all transports failed: visual unavailable",
      suggestion: "inspect each transport: unicli doctor compute",
      retryable: false,
    });
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("click exposes ref provenance error codes in the CLI envelope", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(
      err({
        transport: "visual",
        step: 0,
        action: "compute_click",
        reason:
          "foreign_ref: olo:accessibility:example belongs to olo.accessibility, not Uni-CLI compute",
        suggestion:
          "route this ref to OLo's accessibility provider, or run `unicli compute snapshot` to allocate a Uni-CLI compute ref",
        minimum_capability: "compute.compute_click.foreign_ref",
        exit_code: 2,
      }),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "click", "olo:accessibility:example"],
        {
          from: "user",
        },
      );
    } finally {
      cap.restore();
    }

    expect(process.exitCode).toBe(2);
    const env = JSON.parse(cap.getStderr()) as Record<string, unknown>;
    expect(env.error).toMatchObject({
      code: "foreign_ref",
      minimum_capability: "compute.compute_click.foreign_ref",
      exit_code: 2,
      suggestion:
        "route this ref to OLo's accessibility provider, or run `unicli compute snapshot` to allocate a Uni-CLI compute ref",
    });
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
  });

  it("click can opt into the system overlay executor and returns visual action evidence", async () => {
    const expectedOverlayProvider = expectedNativeOverlayProvider();
    if (!expectedOverlayProvider) {
      throw new Error(
        `No native overlay provider is registered for ${process.platform}`,
      );
    }
    actionExecutionMock.executeComputeAction.mockResolvedValue({
      result: ok({ transport: "desktop-ax" }),
      evidence: {
        visual_timeline: {
          schema_version: 1,
          replayable: true,
          theme: {
            name: "mac-glass-pointer-v1",
            prefers_reduced_motion: "collapse-durations",
          },
          events: [],
        },
        visual_action: {
          schema_version: 2,
          action_id: "computer-use.click:compute_click:@e7:60,40",
          tool: "compute.click",
          action: "compute_click",
          overlay: {
            provider: expectedOverlayProvider,
            status: "arrived",
            acknowledged_at_ms: 240,
          },
          dispatch: {
            status: "succeeded",
            transport: "desktop-ax",
          },
        },
      },
    });
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "click", "@e7", "--overlay"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute).not.toHaveBeenCalled();
    expect(actionExecutionMock.executeComputeAction).toHaveBeenCalledTimes(1);
    expect(actionExecutionMock.executeComputeAction.mock.calls[0]?.[1]).toEqual(
      {
        kind: "compute_click",
        params: { ref: "@e7", focus: false },
      },
    );
    expect(
      actionExecutionMock.executeComputeAction.mock.calls[0]?.[2],
    ).toMatchObject({
      tool: "compute.click",
      overlayProvider: { provider: expectedOverlayProvider },
    });
    const env = JSON.parse(cap.getStdout()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({
      transport: "desktop-ax",
      visual_action: {
        schema_version: 2,
        overlay: {
          provider: expectedOverlayProvider,
          status: "arrived",
        },
      },
    });
  });

  it("forwards explicit background mode with non-focusing semantics", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(ok({ clicked: true }));
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "click", "@e7", "--background"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_click",
      params: { ref: "@e7", background: true, focus: false },
    });
  });

  it("attach parses the CDP port before dispatching", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(
      ok({
        port: 9333,
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/page-1",
        targets: [],
        relaunched: false,
      }),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "attach", "--port", "9333"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_cdp_attach",
      params: { port: 9333 },
    });
    const env = JSON.parse(cap.getStdout()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.command).toBe("compute.attach");
  });

  it("attach forwards explicit relaunch confirmation", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(
      ok({
        app: "notion",
        port: 9230,
        webSocketDebuggerUrl: "ws://127.0.0.1:9230/page-1",
        targets: [],
        relaunched: true,
      }),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "attach",
          "--app",
          "notion",
          "--confirm-relaunch",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_cdp_attach",
      params: { app: "notion", confirmRelaunch: true },
    });
  });

  it("attach and eval forward exact CDP renderer ids", async () => {
    const directory = mkdtempSync(join(tmpdir(), "unicli-cdp-target-"));
    process.env.UNICLI_COMPUTE_CDP_SESSION_PATH = join(
      directory,
      "session.json",
    );
    dispatchMock.dispatchComputeRoute
      .mockResolvedValueOnce(
        ok({
          port: 9333,
          targetId: "page-b",
          webSocketDebuggerUrl: "ws://127.0.0.1:9333/page-b",
          targets: [],
        }),
      )
      .mockResolvedValueOnce(ok("Second"));
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "attach",
          "--port",
          "9333",
          "--target-id",
          "page-b",
        ],
        { from: "user" },
      );
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "eval",
          "document.title",
          "--target-id",
          "page-b",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
      rmSync(directory, { recursive: true, force: true });
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_cdp_attach",
      params: { port: 9333, targetId: "page-b" },
    });
    expect(dispatchMock.dispatchComputeRoute.mock.calls[1]?.[1]).toMatchObject({
      kind: "compute_evaluate",
      params: {
        script: "document.title",
        port: 9333,
        targetId: "page-b",
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/page-b",
      },
    });
  });

  it("launch parses the Electron debug port before dispatching", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(ok({ launched: true }));
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "launch",
          "Visual Studio Code",
          "--debug-port",
          "9230",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_launch",
      params: { app: "Visual Studio Code", debugPort: 9230 },
    });
  });

  it("attach persists CDP session metadata for later CLI processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-cdp-"));
    const file = join(dir, "cdp-session.json");
    process.env.UNICLI_COMPUTE_CDP_SESSION_PATH = file;
    dispatchMock.dispatchComputeRoute.mockResolvedValue(
      ok({
        app: "vscode",
        port: 9240,
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/page-1",
        targetId: "page-1",
        targets: [],
        relaunched: false,
      }),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "attach", "--app", "vscode"],
        { from: "user" },
      );

      expect(loadCdpSession(file)).toMatchObject({
        schema_version: 1,
        app: "vscode",
        port: 9240,
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/page-1",
        targetId: "page-1",
      });
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("eval forwards JavaScript as the CDP script param", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(ok("Calculator"));
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "eval", "document.title"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_evaluate",
      params: { script: "document.title" },
    });
    const env = JSON.parse(cap.getStdout()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.command).toBe("compute.eval");
  });

  it("eval loads persisted CDP session metadata before dispatching", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-cdp-"));
    const file = join(dir, "cdp-session.json");
    process.env.UNICLI_COMPUTE_CDP_SESSION_PATH = file;
    writeFileSync(
      file,
      JSON.stringify({
        schema_version: 1,
        app: "vscode",
        port: 9240,
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/page-1",
        savedAt: 123,
      }),
    );
    dispatchMock.dispatchComputeRoute.mockResolvedValue(ok("Editor"));
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "eval", "document.title"],
        { from: "user" },
      );
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_evaluate",
      params: {
        script: "document.title",
        app: "vscode",
        port: 9240,
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/page-1",
      },
    });
  });

  it("returns one structured envelope for corrupt persisted CDP state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-cdp-corrupt-"));
    const file = join(dir, "cdp-session.json");
    process.env.UNICLI_COMPUTE_CDP_SESSION_PATH = file;
    writeFileSync(file, "{");
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "eval", "document.title"],
        { from: "user" },
      );
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }

    expect(dispatchMock.dispatchComputeRoute).not.toHaveBeenCalled();
    expect(cap.getStdout()).toBe("");
    const envelope = JSON.parse(cap.getStderr()) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "state_corrupt",
        minimum_capability: "compute.cdp_session.state_corrupt",
        exit_code: 78,
        retryable: false,
        suggestion: expect.stringContaining("unicli compute attach"),
      },
    });
  });

  it("returns one structured envelope for corrupt persisted refs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-corrupt-"));
    const file = join(dir, "refs.json");
    process.env.UNICLI_COMPUTE_REFS_PATH = file;
    writeFileSync(file, "{");
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(["-f", "json", "compute", "apps"], {
        from: "user",
      });
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }

    expect(dispatchMock.dispatchComputeRoute).not.toHaveBeenCalled();
    expect(cap.getStdout()).toBe("");
    const envelope = JSON.parse(cap.getStderr()) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "state_corrupt",
        minimum_capability: "compute.refs.state_corrupt",
        exit_code: 78,
        retryable: false,
        suggestion: expect.stringContaining("fresh compute snapshot"),
      },
    });
  });

  it("keeps capture state corruption inside the shared structured boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-capture-refs-corrupt-"));
    const file = join(dir, "refs.json");
    process.env.UNICLI_COMPUTE_REFS_PATH = file;
    writeFileSync(file, "{");
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "capture", "--include", "snapshot"],
        { from: "user" },
      );
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }

    expect(dispatchMock.dispatchComputeRoute).not.toHaveBeenCalled();
    expect(cap.getStdout()).toBe("");
    const envelope = JSON.parse(cap.getStderr()) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "state_corrupt",
        minimum_capability: "compute.refs.state_corrupt",
        exit_code: 78,
        retryable: false,
        suggestion: expect.stringContaining("fresh compute snapshot"),
      },
    });
  });

  it("never replaces an explicit app with a different persisted CDP target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-cdp-"));
    const file = join(dir, "cdp-session.json");
    process.env.UNICLI_COMPUTE_CDP_SESSION_PATH = file;
    writeFileSync(
      file,
      JSON.stringify({
        schema_version: 1,
        app: "vscode",
        port: 9240,
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/page-1",
        savedAt: 123,
      }),
    );
    dispatchMock.dispatchComputeRoute.mockResolvedValue(
      ok({ format: "text", data: "" }),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "snapshot", "--app", "Calculator"],
        { from: "user" },
      );
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_snapshot",
      params: {
        app: "Calculator",
        format: "compact",
        maxDepth: 64,
      },
    });
  });

  it("never injects a persisted CDP session into a native ref wait", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-native-wait-"));
    const refsFile = join(dir, "refs.json");
    const sessionFile = join(dir, "cdp-session.json");
    process.env.UNICLI_COMPUTE_REFS_PATH = refsFile;
    process.env.UNICLI_COMPUTE_CDP_SESSION_PATH = sessionFile;
    writeFileSync(
      refsFile,
      JSON.stringify({
        schema_version: 1,
        buckets: [
          {
            transport: "desktop-ax",
            scope: "finder",
            createdAt: Date.now(),
            refs: [
              {
                alias: "@e1",
                stable: "desktop-ax:finder:AXWindow[0]",
                role: "AXWindow",
                name: "Finder",
                app: "Finder",
              },
            ],
          },
        ],
      }),
    );
    writeFileSync(
      sessionFile,
      JSON.stringify({
        schema_version: 1,
        app: "vscode",
        port: 9240,
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/page-1",
        savedAt: 123,
      }),
    );
    dispatchMock.dispatchComputeRoute.mockResolvedValue(ok({ matched: true }));
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "wait", "--ref", "@e1", "--state", "focused"],
        { from: "user" },
      );
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_wait",
      params: { ref: "@e1", state: "focused", timeoutMs: 10_000 },
    });
  });

  it("loads persisted refs before compute find dispatches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-compute-"));
    const file = join(dir, "refs.json");
    process.env.UNICLI_COMPUTE_REFS_PATH = file;
    writeFileSync(
      file,
      JSON.stringify({
        schema_version: 1,
        buckets: [
          {
            transport: "desktop-ax",
            scope: "window-4242",
            createdAt: 123,
            refs: [
              {
                alias: "@e1",
                stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[4]",
                role: "AXButton",
                name: "5",
                app: "Calculator",
                pid: 42,
                windowId: 4242,
              },
            ],
          },
        ],
      }),
    );
    dispatchMock.dispatchComputeRoute.mockImplementation(async (bus) =>
      ok(bus.refs.resolve("@e1")),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "find",
          "--role",
          "button",
          "--name",
          "5",
          "--first",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }

    const env = JSON.parse(cap.getStdout()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({
      alias: "@e1",
      stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[4]",
      role: "AXButton",
      name: "5",
    });
  });

  it("find forwards text filters for value-based ref lookup", async () => {
    dispatchMock.dispatchComputeRoute.mockResolvedValue(
      ok({
        alias: "@e2",
        role: "text",
        name: "Display",
        value: "8",
      }),
    );
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        [
          "-f",
          "json",
          "compute",
          "find",
          "--role",
          "input",
          "--text",
          "8",
          "--first",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(dispatchMock.dispatchComputeRoute.mock.calls[0]?.[1]).toEqual({
      kind: "compute_find",
      params: { role: "input", text: "8", first: true },
    });
  });
});
