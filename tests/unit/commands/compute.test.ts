import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, err } from "../../../src/core/envelope.js";
import { validateEnvelope } from "../../../src/output/envelope.js";

const cascadeMock = vi.hoisted(() => ({
  tryCascade: vi.fn(),
}));

vi.mock("../../../src/transport/cascade.js", () => ({
  tryCascade: cascadeMock.tryCascade,
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

describe("unicli compute", () => {
  beforeEach(() => {
    cascadeMock.tryCascade.mockReset();
    process.exitCode = undefined;
    delete process.env.UNICLI_COMPUTE_REFS_PATH;
    delete process.env.UNICLI_COMPUTE_CDP_SESSION_PATH;
  });

  afterEach(() => {
    process.exitCode = undefined;
    delete process.env.UNICLI_COMPUTE_REFS_PATH;
    delete process.env.UNICLI_COMPUTE_CDP_SESSION_PATH;
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

  it("click emits a structured error and preserves the transport exit code", async () => {
    cascadeMock.tryCascade.mockResolvedValue(
      err({
        transport: "cua",
        step: 0,
        action: "compute_click",
        reason: "all transports failed: cua unavailable",
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
      message: "all transports failed: cua unavailable",
      suggestion: "inspect each transport: unicli doctor compute",
      retryable: false,
    });
    validateEnvelope(env as Parameters<typeof validateEnvelope>[0]);
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
