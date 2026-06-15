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

const cascadeMock = vi.hoisted(() => ({
  tryCascade: vi.fn(),
}));
const actionExecutionMock = vi.hoisted(() => ({
  executeComputeAction: vi.fn(),
}));

vi.mock("../../../src/transport/cascade.js", () => ({
  tryCascade: cascadeMock.tryCascade,
}));
vi.mock("../../../src/compute/action-execution.js", () => ({
  executeComputeAction: actionExecutionMock.executeComputeAction,
}));

const { registerComputeCommand } =
  await import("../../../src/commands/compute.js");

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

describe("unicli compute", () => {
  beforeEach(() => {
    cascadeMock.tryCascade.mockReset();
    actionExecutionMock.executeComputeAction.mockReset();
    process.exitCode = undefined;
    delete process.env.UNICLI_COMPUTE_REFS_PATH;
    delete process.env.UNICLI_COMPUTE_CDP_SESSION_PATH;
    delete process.env.UNICLI_APP_SHOTS_ROOT;
  });

  afterEach(() => {
    process.exitCode = undefined;
    delete process.env.UNICLI_COMPUTE_REFS_PATH;
    delete process.env.UNICLI_COMPUTE_CDP_SESSION_PATH;
    delete process.env.UNICLI_APP_SHOTS_ROOT;
  });

  it("snapshot forwards normalized options and emits a desktop envelope", async () => {
    cascadeMock.tryCascade.mockResolvedValue(
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

    expect(cascadeMock.tryCascade).toHaveBeenCalledTimes(1);
    expect(cascadeMock.tryCascade.mock.calls[0]?.[1]).toEqual({
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

  it("capture combines snapshot and screenshot into one context packet", async () => {
    cascadeMock.tryCascade
      .mockResolvedValueOnce(
        ok({
          format: "text",
          encoding: "compact",
          data: '@e1 button "5"',
          refs: { count: 1, scope: "Calculator" },
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

    expect(cascadeMock.tryCascade).toHaveBeenCalledTimes(2);
    expect(cascadeMock.tryCascade.mock.calls[0]?.[1]).toEqual({
      kind: "compute_snapshot",
      params: {
        app: "Calculator",
        format: "compact",
        maxDepth: 4,
      },
    });
    expect(cascadeMock.tryCascade.mock.calls[1]?.[1]).toEqual({
      kind: "compute_screenshot",
      params: {
        app: "Calculator",
      },
    });

    const env = JSON.parse(cap.getStdout()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.command).toBe("compute.capture");
    expect((env.meta as { surface?: string }).surface).toBe("desktop");
    expect(env.data).toMatchObject({
      schema_version: 1,
      app: "Calculator",
      includes: ["snapshot", "screenshot"],
      snapshot: {
        ok: true,
        data: {
          encoding: "compact",
          data: '@e1 button "5"',
          refs: { count: 1, scope: "Calculator" },
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
            params: { app: "Calculator", format: "compact", maxDepth: 4 },
            ok: true,
          },
          {
            index: 1,
            action: "compute_screenshot",
            params: { app: "Calculator" },
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

  it("capture enriches screenshot evidence with image metadata and coordinate space", async () => {
    const onePixelPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const onePixelPng = Buffer.from(onePixelPngBase64, "base64");
    cascadeMock.tryCascade.mockResolvedValueOnce(
      ok({
        base64: onePixelPngBase64,
        mime: "image/png",
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
              x: 1,
              y: 1,
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

    expect(cascadeMock.tryCascade).not.toHaveBeenCalled();
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

    expect(cascadeMock.tryCascade).not.toHaveBeenCalled();
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

    expect(cascadeMock.tryCascade).not.toHaveBeenCalled();
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
    cascadeMock.tryCascade
      .mockResolvedValueOnce(
        ok({
          encoding: "compact",
          data: '@e1 button "5"',
          refs: { count: 1, scope: "Calculator" },
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
    cascadeMock.tryCascade.mockResolvedValueOnce(
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
    cascadeMock.tryCascade.mockResolvedValue(
      err({
        transport: "visual",
        step: 0,
        action: "compute_click",
        reason: "all transports failed: visual unavailable",
        suggestion: "inspect each transport: unicli doctor compute",
        minimum_capability: "compute.compute_click.no-transport-available",
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
    cascadeMock.tryCascade.mockResolvedValue(
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

    expect(cascadeMock.tryCascade).not.toHaveBeenCalled();
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

  it("normalizes focus options for mutating commands", async () => {
    cascadeMock.tryCascade.mockResolvedValue(ok({ clicked: true }));
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "click", "@e7", "--background"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(cascadeMock.tryCascade.mock.calls[0]?.[1]).toEqual({
      kind: "compute_click",
      params: { ref: "@e7", focus: false },
    });
  });

  it("attach parses the CDP port before dispatching", async () => {
    cascadeMock.tryCascade.mockResolvedValue(
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

    expect(cascadeMock.tryCascade.mock.calls[0]?.[1]).toEqual({
      kind: "compute_cdp_attach",
      params: { port: 9333 },
    });
    const env = JSON.parse(cap.getStdout()) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.command).toBe("compute.attach");
  });

  it("attach forwards explicit relaunch confirmation", async () => {
    cascadeMock.tryCascade.mockResolvedValue(
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

    expect(cascadeMock.tryCascade.mock.calls[0]?.[1]).toEqual({
      kind: "compute_cdp_attach",
      params: { app: "notion", confirmRelaunch: true },
    });
  });

  it("launch parses the Electron debug port before dispatching", async () => {
    cascadeMock.tryCascade.mockResolvedValue(ok({ launched: true }));
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

    expect(cascadeMock.tryCascade.mock.calls[0]?.[1]).toEqual({
      kind: "compute_launch",
      params: { app: "Visual Studio Code", debugPort: 9230 },
    });
  });

  it("attach persists CDP session metadata for later CLI processes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-cdp-"));
    const file = join(dir, "cdp-session.json");
    process.env.UNICLI_COMPUTE_CDP_SESSION_PATH = file;
    cascadeMock.tryCascade.mockResolvedValue(
      ok({
        app: "vscode",
        port: 9240,
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/page-1",
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

      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
        schema_version: 1,
        app: "vscode",
        port: 9240,
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/page-1",
      });
    } finally {
      cap.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("eval forwards JavaScript as the CDP script param", async () => {
    cascadeMock.tryCascade.mockResolvedValue(ok("Calculator"));
    const cap = captureConsole();
    try {
      await newProgram().parseAsync(
        ["-f", "json", "compute", "eval", "document.title"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(cascadeMock.tryCascade.mock.calls[0]?.[1]).toEqual({
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
    cascadeMock.tryCascade.mockResolvedValue(ok("Editor"));
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

    expect(cascadeMock.tryCascade.mock.calls[0]?.[1]).toEqual({
      kind: "compute_evaluate",
      params: {
        script: "document.title",
        app: "vscode",
        port: 9240,
        webSocketDebuggerUrl: "ws://127.0.0.1:9240/page-1",
      },
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
            scope: "calc",
            createdAt: 123,
            refs: [
              {
                alias: "@e1",
                stable: "desktop-ax:calc:AXWindow[0]/AXButton[4]",
                role: "AXButton",
                name: "5",
              },
            ],
          },
        ],
      }),
    );
    cascadeMock.tryCascade.mockImplementation(async (bus) =>
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
      stable: "desktop-ax:calc:AXWindow[0]/AXButton[4]",
      role: "AXButton",
      name: "5",
    });
  });

  it("find forwards text filters for value-based ref lookup", async () => {
    cascadeMock.tryCascade.mockResolvedValue(
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

    expect(cascadeMock.tryCascade.mock.calls[0]?.[1]).toEqual({
      kind: "compute_find",
      params: { role: "input", text: "8", first: true },
    });
  });
});
