import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import {
  networkCachePath,
  saveNetworkCache,
} from "../../../src/browser/network-cache.js";
import { writeFixture } from "../../../src/browser/verify-fixture.js";
import { primeKernelCache } from "../../../src/discovery/loader.js";
import { registerAdapter } from "../../../src/registry.js";
import { AdapterType, Strategy } from "../../../src/types.js";
import type { AdapterManifest } from "../../../src/types.js";

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
  let tmpHome: string | null = null;
  let origHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    origHome = process.env.HOME;
  });

  afterEach(() => {
    delete process.env.UNICLI_OUTPUT;
    if (tmpHome) {
      rmSync(tmpHome, { recursive: true, force: true });
      tmpHome = null;
    }
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  });

  function useTempHome(): string {
    tmpHome = mkdtempSync(join(tmpdir(), "unicli-browser-cmd-"));
    process.env.HOME = tmpHome;
    return tmpHome;
  }

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

  it("browser analyze reports deterministic pattern and anti-bot evidence", async () => {
    mockPage.readNetworkCapture.mockResolvedValueOnce([
      {
        url: "https://example.com/api/private-feed",
        method: "GET",
        status: 403,
        contentType: "text/html",
        size: 32,
        responseBody: "Cloudflare Ray ID",
      },
    ]);
    mockPage.evaluate.mockImplementation(async (js: string) => {
      if (js.includes("document.cookie")) return ["__cf_bm"];
      if (js.includes("__INITIAL_STATE__")) {
        return {
          __INITIAL_STATE__: false,
          __NUXT__: false,
          __NEXT_DATA__: false,
          __APOLLO_STATE__: false,
        };
      }
      return undefined;
    });

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "analyze", "https://example.com"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      command: string;
      data: { pattern: { pattern: string }; anti_bot: { vendor: string } };
    };
    expect(env.command).toBe("browser.analyze");
    expect(env.data.pattern.pattern).toBe("D");
    expect(env.data.anti_bot.vendor).toBe("cloudflare");
  });

  it("browser network persists cache and filters by response body shape", async () => {
    const home = useTempHome();
    mockPage.readNetworkCapture.mockResolvedValueOnce([
      {
        url: "https://example.com/api/feed",
        method: "GET",
        status: 200,
        contentType: "application/json",
        size: 48,
        responseBody: JSON.stringify({ data: [{ id: "1", title: "First" }] }),
      },
      {
        url: "https://example.com/api/ping",
        method: "GET",
        status: 200,
        contentType: "application/json",
        size: 12,
        responseBody: JSON.stringify({ ok: true }),
      },
    ]);

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "network", "--filter", "id,title"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: Array<{ key: string; url: string; body?: unknown }>;
    };
    expect(env.data).toHaveLength(1);
    expect(env.data[0].key).toMatch(/^get-feed-/);
    expect(env.data[0].body).toBeUndefined();
    expect(
      existsSync(
        networkCachePath("browser:default", join(home, ".unicli", "cache")),
      ),
    ).toBe(true);
  });

  it("browser network keeps text/javascript API responses when body matches filter", async () => {
    useTempHome();
    mockPage.readNetworkCapture.mockResolvedValueOnce([
      {
        url: "https://example.com/api/bootstrap",
        method: "GET",
        status: 200,
        contentType: "text/javascript; charset=utf-8",
        size: 64,
        responseBody: JSON.stringify({
          data: [{ id: "1", title: "From JS MIME" }],
        }),
      },
      {
        url: "https://example.com/static/app.js",
        method: "GET",
        status: 200,
        contentType: "text/javascript",
        size: 12,
        responseBody: "console.log('asset')",
      },
    ]);

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "network", "--filter", "data"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: Array<{ url: string; contentType: string }>;
    };
    expect(env.data).toHaveLength(1);
    expect(env.data[0]).toMatchObject({
      url: "https://example.com/api/bootstrap",
      contentType: "text/javascript; charset=utf-8",
    });
  });

  it("browser network detail reads from persisted cache without a live capture", async () => {
    const home = useTempHome();
    saveNetworkCache(
      "browser:default",
      [
        {
          key: "get-feed-deadbeef",
          url: "https://example.com/api/feed",
          method: "GET",
          status: 200,
          contentType: "application/json",
          bodySize: 64,
          body: { data: [{ id: "1" }] },
        },
      ],
      join(home, ".unicli", "cache"),
    );

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        ["browser", "network", "--detail", "get-feed-deadbeef"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: { key: string; body: unknown };
    };
    expect(env.data.key).toBe("get-feed-deadbeef");
    expect(env.data.body).toEqual({ data: [{ id: "1" }] });
  });

  it("browser init creates a schema-v2 YAML adapter skeleton", async () => {
    const home = useTempHome();

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "init", "example/search"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const adapterPath = join(
      home,
      ".unicli",
      "adapters",
      "example",
      "search.yaml",
    );
    const env = JSON.parse(cap.getStdout().trim()) as {
      command: string;
      data: { adapterPath: string };
    };
    expect(env.command).toBe("browser.init");
    expect(env.data.adapterPath).toBe(adapterPath);
    expect(readFileSync(adapterPath, "utf-8")).toContain("site: example");
    expect(readFileSync(adapterPath, "utf-8")).toContain(
      "minimum_capability: http.fetch",
    );
  });

  it("browser verify --strict-memory fails when site memory was not written", async () => {
    useTempHome();

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        ["browser", "verify", "example/search", "--strict-memory"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStderr().trim()) as {
      ok: boolean;
      command: string;
      error: { code: string; message: string };
    };
    expect(env.ok).toBe(false);
    expect(env.command).toBe("browser.verify");
    expect(env.error.code).toBe("not_found");
    expect(env.error.message).toContain("endpoints.json");
  });

  it("browser verify runs adapters with args from the fixture", async () => {
    const home = useTempHome();
    const fixtureAdapter: AdapterManifest = {
      name: "browser-verify-fixture",
      type: AdapterType.WEB_API,
      strategy: Strategy.PUBLIC,
      commands: {
        search: {
          name: "search",
          adapterArgs: [
            { name: "query", type: "str", required: true, positional: true },
            { name: "limit", type: "int", default: 20 },
          ],
          func: async (_page, args) => [
            { query: args.query, limit: args.limit },
          ],
        },
      },
    };
    registerAdapter(fixtureAdapter);
    primeKernelCache();
    writeFixture(
      "browser-verify-fixture",
      "search",
      {
        args: { query: "ai", limit: 3 },
        expect: {
          rowCount: { min: 1 },
          columns: ["query", "limit"],
          types: { query: "string", limit: "number" },
          notEmpty: ["query"],
        },
      },
      home,
    );

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        ["browser", "verify", "browser-verify-fixture/search"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: { rowCount: number; fixtureFailures: unknown[] };
    };
    expect(process.exitCode).toBe(0);
    expect(env.data.rowCount).toBe(1);
    expect(env.data.fixtureFailures).toEqual([]);
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
