/**
 * Unit tests for operate subcommands (upload, hover).
 *
 * Mocks BrowserBridge to avoid needing a live daemon/Chrome.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";

// Build a mock DaemonPage with the methods the operate subcommands use
const mockPage = {
  goto: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn().mockResolvedValue(undefined),
  click: vi.fn().mockResolvedValue(undefined),
  setFileInput: vi.fn().mockResolvedValue(undefined),
  title: vi.fn().mockResolvedValue("Test Page"),
  url: vi.fn().mockResolvedValue("https://example.com"),
  snapshot: vi.fn().mockResolvedValue("snapshot"),
  screenshot: vi.fn().mockResolvedValue(Buffer.from("img")),
  wait: vi.fn().mockResolvedValue(undefined),
  waitForSelector: vi.fn().mockResolvedValue(undefined),
  press: vi.fn().mockResolvedValue(undefined),
  insertText: vi.fn().mockResolvedValue(undefined),
  scroll: vi.fn().mockResolvedValue(undefined),
  autoScroll: vi.fn().mockResolvedValue(undefined),
  networkRequests: vi.fn().mockResolvedValue([]),
  closeWindow: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../../src/browser/bridge.js", () => ({
  BrowserBridge: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(mockPage),
  })),
  DaemonPage: vi.fn(),
}));

// Dynamically import after mock is set up
const { registerOperateCommands } =
  await import("../../src/commands/operate.js");

function createProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit
  registerOperateCommands(program);
  return program;
}

describe("operate upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("calls setFileInput with correct selector and absolute path", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node",
      "test",
      "operate",
      "upload",
      "42",
      "/tmp/photo.png",
    ]);

    expect(mockPage.setFileInput).toHaveBeenCalledWith(
      '[data-unicli-ref="42"]',
      ["/tmp/photo.png"],
    );
  });

  it("rejects non-numeric ref with error", async () => {
    const program = createProgram();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await program.parseAsync([
      "node",
      "test",
      "operate",
      "upload",
      "abc",
      "/tmp/file.txt",
    ]);

    expect(process.exitCode).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid ref"),
    );
    consoleSpy.mockRestore();
  });

  it("resolves relative path to absolute", async () => {
    const program = createProgram();
    await program.parseAsync([
      "node",
      "test",
      "operate",
      "upload",
      "7",
      "relative/file.png",
    ]);

    // The path passed to setFileInput should be absolute (resolved)
    const call = mockPage.setFileInput.mock.calls[0];
    expect(call[0]).toBe('[data-unicli-ref="7"]');
    // Absolute path should not start with "relative/"
    expect(call[1][0]).toMatch(/^\//);
    expect(call[1][0]).toContain("relative/file.png");
  });
});

describe("operate hover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it("dispatches mouseenter and mouseover events via evaluate", async () => {
    const program = createProgram();
    await program.parseAsync(["node", "test", "operate", "hover", "15"]);

    expect(mockPage.evaluate).toHaveBeenCalledTimes(1);
    const js = mockPage.evaluate.mock.calls[0][0] as string;
    expect(js).toContain("data-unicli-ref");
    expect(js).toContain("mouseenter");
    expect(js).toContain("mouseover");
  });

  it("rejects non-numeric ref with error", async () => {
    const program = createProgram();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await program.parseAsync(["node", "test", "operate", "hover", "<script>"]);

    expect(process.exitCode).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid ref"),
    );
    consoleSpy.mockRestore();
  });
});
