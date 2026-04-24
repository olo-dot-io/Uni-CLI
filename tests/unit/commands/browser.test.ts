import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

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
  startNetworkCapture: vi.fn().mockResolvedValue(undefined),
  readNetworkCapture: vi.fn().mockResolvedValue([]),
  sendCDP: vi.fn().mockResolvedValue({
    frameTree: {
      frame: { id: "root", url: "https://example.com" },
      childFrames: [
        {
          frame: {
            id: "frame-1",
            parentId: "root",
            url: "https://x.example/embed",
          },
        },
      ],
    },
  }),
};

const daemonClientMocks = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  listSessions: vi.fn().mockResolvedValue([
    {
      workspace: "browser:default",
      windowId: 41,
      tabCount: 2,
      idleMsRemaining: 12_000,
    },
  ]),
  bindCurrentTab: vi.fn().mockResolvedValue({
    tabId: 77,
    url: "https://bound.example",
    title: "Bound",
  }),
}));

vi.mock("../../../src/browser/bridge.js", () => ({
  BrowserBridge: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(mockPage),
  })),
  BridgeConnectionError: class BridgeConnectionError extends Error {},
  DaemonPage: vi.fn(),
}));

vi.mock("../../../src/browser/daemon-client.js", () => ({
  fetchDaemonStatus: vi.fn().mockResolvedValue({
    pid: 999,
    uptime: 10,
    extensionConnected: true,
    pending: 0,
    memoryMB: 32,
    port: 19825,
  }),
  listSessions: daemonClientMocks.listSessions,
  bindCurrentTab: daemonClientMocks.bindCurrentTab,
  sendCommand: daemonClientMocks.sendCommand,
}));

import { registerBrowserCommands } from "../../../src/commands/browser.js";

function captureConsole(): {
  getStdout: () => string;
  getStderr: () => string;
  restore: () => void;
} {
  let out = "";
  let err = "";
  const origLog = console.log;
  const origError = console.error;
  console.log = ((...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    err += args.map(String).join(" ") + "\n";
  }) as typeof console.error;
  return {
    getStdout: () => out,
    getStderr: () => err,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("-f, --format <fmt>", "output format");
  registerBrowserCommands(program);
  return program;
}

describe("unicli browser operator surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    delete process.env.UNICLI_OUTPUT;
  });

  it("browser open exposes the operator surface under browser", async () => {
    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "open", "https://example.com"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      command: string;
      data: { workspace: string };
    };
    expect(env.command).toBe("browser.open");
    expect(env.data.workspace).toBe("browser:default");
    expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", {
      settleMs: 2000,
    });
  });

  it("browser find allocates refs and returns structured matches", async () => {
    mockPage.evaluate
      .mockResolvedValueOnce([
        {
          nth: 0,
          ref: "12",
          tag: "button",
          role: "button",
          text: "Save",
          visible: true,
          attrs: { "data-testid": "save" },
        },
      ])
      .mockResolvedValueOnce(undefined);

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "find", "--css", "button.save"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      command: string;
      data: Array<{ ref: string; text: string }>;
    };
    expect(env.command).toBe("browser.find");
    expect(env.data[0]).toMatchObject({ ref: "12", text: "Save" });
    expect(mockPage.evaluate.mock.calls[0]?.[0]).toContain(
      "document.querySelectorAll",
    );
  });

  it("browser frames reports iframe tree entries", async () => {
    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "frames"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: Array<{ frameId: string; url: string }>;
    };
    expect(env.data).toEqual([
      {
        index: 0,
        frameId: "frame-1",
        parentFrameId: "root",
        url: "https://x.example/embed",
      },
    ]);
    expect(mockPage.sendCDP).toHaveBeenCalledWith("Page.getFrameTree");
  });

  it("browser tabs honors isolated workspaces", async () => {
    daemonClientMocks.sendCommand.mockResolvedValueOnce([
      { id: 1, url: "https://one.example", title: "one" },
    ]);

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "--isolated", "tabs"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      command: string;
      data: Array<{ url: string }>;
    };
    expect(env.command).toBe("browser.tabs");
    expect(env.data[0]?.url).toBe("https://one.example");
    expect(daemonClientMocks.sendCommand).toHaveBeenCalledWith(
      "tabs",
      expect.objectContaining({
        workspace: expect.stringMatching(/^browser:\d+:\d+:[0-9a-f]+$/),
      }),
    );
  });

  it("browser bind routes match filters into bindCurrentTab", async () => {
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "browser",
          "--workspace",
          "profile-a",
          "bind",
          "--match-domain",
          "example.com",
          "--match-path-prefix",
          "/feed",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(daemonClientMocks.bindCurrentTab).toHaveBeenCalledWith("profile-a", {
      matchDomain: "example.com",
      matchPathPrefix: "/feed",
    });
  });

  it("browser upload rejects paths that only share the home prefix", async () => {
    process.env.UNICLI_OUTPUT = "json";
    const outsideHomePath = `${homedir()}-outside/upload.txt`;
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "upload", "12", outsideHomePath], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStderr().trim()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("permission_denied");
    expect(env.error.message).toContain("outside workspace and home directory");
    expect(mockPage.setFileInput).not.toHaveBeenCalled();
  });
});
