import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
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
import {
  createRunStore,
  readRunEvents,
} from "../../../src/engine/session/store.js";
import { createBrowserSessionLease } from "../../../src/engine/browser/session-lease.js";

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
  cookies: vi.fn().mockResolvedValue({ sid: "cookie" }),
  browserTargetInfo: vi.fn().mockResolvedValue({
    kind: "daemon-tab",
    captured_at: "2026-04-29T02:00:00.000Z",
    tab_id: 77,
    window_id: 41,
    url: "https://example.com",
    title: "Test Page",
    owned: true,
    preferred_tab_id: 77,
    tab_count: 2,
  }),
  closeWindow: vi.fn().mockResolvedValue(undefined),
  addInitScript: vi.fn().mockResolvedValue(undefined),
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

function resetMockPage(): void {
  mockPage.goto.mockReset().mockResolvedValue(undefined);
  mockPage.evaluate.mockReset().mockResolvedValue(undefined);
  mockPage.click.mockReset().mockResolvedValue(undefined);
  mockPage.setFileInput.mockReset().mockResolvedValue(undefined);
  mockPage.title.mockReset().mockResolvedValue("Test Page");
  mockPage.url.mockReset().mockResolvedValue("https://example.com");
  mockPage.snapshot.mockReset().mockResolvedValue("snapshot");
  mockPage.screenshot.mockReset().mockResolvedValue(Buffer.from("img"));
  mockPage.wait.mockReset().mockResolvedValue(undefined);
  mockPage.waitForSelector.mockReset().mockResolvedValue(undefined);
  mockPage.press.mockReset().mockResolvedValue(undefined);
  mockPage.insertText.mockReset().mockResolvedValue(undefined);
  mockPage.scroll.mockReset().mockResolvedValue(undefined);
  mockPage.autoScroll.mockReset().mockResolvedValue(undefined);
  mockPage.networkRequests.mockReset().mockResolvedValue([]);
  mockPage.cookies.mockReset().mockResolvedValue({ sid: "cookie" });
  mockPage.browserTargetInfo.mockReset().mockResolvedValue({
    kind: "daemon-tab",
    captured_at: "2026-04-29T02:00:00.000Z",
    tab_id: 77,
    window_id: 41,
    url: "https://example.com",
    title: "Test Page",
    owned: true,
    preferred_tab_id: 77,
    tab_count: 2,
  });
  mockPage.closeWindow.mockReset().mockResolvedValue(undefined);
  mockPage.addInitScript.mockReset().mockResolvedValue(undefined);
  mockPage.startNetworkCapture.mockReset().mockResolvedValue(undefined);
  mockPage.readNetworkCapture.mockReset().mockResolvedValue([]);
  mockPage.sendCDP.mockReset().mockResolvedValue({
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
  });
}

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
  let origRecordRun: string | undefined;
  let origRunRoot: string | undefined;
  let origBrowserWatchdog: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockPage();
    process.exitCode = undefined;
    origHome = process.env.HOME;
    origRecordRun = process.env.UNICLI_RECORD_RUN;
    origRunRoot = process.env.UNICLI_RUN_ROOT;
    origBrowserWatchdog = process.env.UNICLI_BROWSER_WATCHDOG;
  });

  afterEach(() => {
    delete process.env.UNICLI_OUTPUT;
    if (origRecordRun === undefined) delete process.env.UNICLI_RECORD_RUN;
    else process.env.UNICLI_RECORD_RUN = origRecordRun;
    if (origRunRoot === undefined) delete process.env.UNICLI_RUN_ROOT;
    else process.env.UNICLI_RUN_ROOT = origRunRoot;
    if (origBrowserWatchdog === undefined)
      delete process.env.UNICLI_BROWSER_WATCHDOG;
    else process.env.UNICLI_BROWSER_WATCHDOG = origBrowserWatchdog;
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

  it("browser click records internal pre/post evidence when run recording is enabled", async () => {
    const home = useTempHome();
    const runRoot = join(home, "runs");
    process.env.UNICLI_OUTPUT = "json";
    process.env.UNICLI_RECORD_RUN = "1";
    process.env.UNICLI_RUN_ROOT = runRoot;
    mockPage.snapshot.mockResolvedValue("[1]<button>Save</button>");
    mockPage.evaluate.mockImplementation(async (script: string) => {
      if (script.includes("__unicli_ref_identity")) {
        return { role: "button", name: "Save", taken_at: Date.now() };
      }
      if (script.includes("document.querySelectorAll")) return 1;
      if (script.includes("__unicli_console_summary")) {
        return JSON.stringify({
          count: 0,
          error_count: 0,
          warn_count: 0,
          observed_since: "2026-04-28T01:00:00.000Z",
        });
      }
      return undefined;
    });

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "click", "1"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      command: string;
      data: Record<string, unknown>;
    };
    expect(env.command).toBe("browser.click");
    expect(env.data).toEqual({ ok: true, clicked: "1" });
    const [runId] = readdirSync(runRoot);
    const events = await readRunEvents(
      createRunStore({ rootDir: runRoot }),
      runId,
    );
    expect(events.map((event) => event.name)).toEqual([
      "run.started",
      "tool.call.started",
      "permission.evaluated",
      "evidence.captured",
      "evidence.captured",
      "tool.call.completed",
      "run.completed",
    ]);
    const expectedLease = createBrowserSessionLease({
      namespace: "browser",
      workspace: "browser:default",
    });
    const browserLeases = events.map((event) => event.metadata.browser_lease);
    expect(events.map((event) => event.metadata.browser_lease)).toEqual(
      events.map(() => expect.objectContaining(expectedLease)),
    );
    expect(browserLeases[0]).toMatchObject({
      target: {
        kind: "daemon-tab",
        tab_id: 77,
        window_id: 41,
      },
      auth: {
        state: "cookies_present",
        cookie_count: 1,
      },
    });
    const evidenceEvents = events.filter(
      (event) => event.name === "evidence.captured",
    );
    expect(evidenceEvents[0]).toMatchObject({
      visibility: "internal",
      data: {
        evidence_type: "browser-operator",
        action: "click",
        phase: "before",
        outcome: "pending",
        workspace: "browser:default",
        browser_session_id: expectedLease.browser_session_id,
        browser_workspace_id: expectedLease.browser_workspace_id,
        browser_target_kind: "daemon-tab",
        browser_tab_id: 77,
        browser_window_id: 41,
        browser_auth_state: "cookies_present",
        browser_cookie_count: 1,
        lease_owner: expectedLease.lease_owner,
        lease_scope: expectedLease.scope,
      },
      internal: {
        action: "click.before",
        evidence_type: "browser-operator",
        workspace: "browser:default",
        lease: expect.objectContaining(expectedLease),
      },
    });
    expect(evidenceEvents[0].data).not.toHaveProperty("browser_target_id");
    expect(evidenceEvents[1]).toMatchObject({
      visibility: "internal",
      data: {
        evidence_type: "browser-operator",
        action: "click",
        phase: "after",
        outcome: "success",
        workspace: "browser:default",
        browser_session_id: expectedLease.browser_session_id,
        browser_workspace_id: expectedLease.browser_workspace_id,
        browser_target_kind: "daemon-tab",
        browser_tab_id: 77,
        browser_window_id: 41,
        browser_auth_state: "cookies_present",
        browser_cookie_count: 1,
        lease_owner: expectedLease.lease_owner,
        lease_scope: expectedLease.scope,
        movement: {
          url_changed: false,
          title_changed: false,
          dom_changed: false,
          screenshot_changed: false,
          network_count_delta: 0,
          console_count_delta: 0,
          changed_dimensions: [],
          no_observed_change: true,
        },
      },
      internal: {
        action: "click.after",
        evidence_type: "browser-operator",
        workspace: "browser:default",
      },
    });
    expect(evidenceEvents[0]?.data).not.toHaveProperty("snapshot");
    expect(evidenceEvents[0]?.data).not.toHaveProperty("text");
  });

  it("browser click records concrete movement dimensions after action", async () => {
    const home = useTempHome();
    const runRoot = join(home, "runs");
    process.env.UNICLI_OUTPUT = "json";
    process.env.UNICLI_RECORD_RUN = "1";
    process.env.UNICLI_RUN_ROOT = runRoot;
    let afterClick = false;
    mockPage.click.mockImplementation(async () => {
      afterClick = true;
    });
    mockPage.url.mockImplementation(async () =>
      afterClick ? "https://example.com/saved" : "https://example.com",
    );
    mockPage.title.mockImplementation(async () =>
      afterClick ? "Saved" : "Test Page",
    );
    mockPage.snapshot.mockImplementation(async () =>
      afterClick ? "[1]<button>Saved</button>" : "[1]<button>Save</button>",
    );
    mockPage.screenshot.mockImplementation(async () =>
      Buffer.from(afterClick ? "after-img" : "before-img"),
    );
    mockPage.readNetworkCapture.mockImplementation(async () =>
      afterClick
        ? [
            {
              url: "https://example.com/api/save",
              method: "POST",
              status: 200,
              size: 12,
            },
          ]
        : [],
    );
    mockPage.evaluate.mockImplementation(async (script: string) => {
      if (script.includes("__unicli_ref_identity")) {
        return { role: "button", name: "Save", taken_at: Date.now() };
      }
      if (script.includes("document.querySelectorAll")) return 1;
      if (script.includes("__unicli_console_summary")) {
        return JSON.stringify({
          count: afterClick ? 2 : 0,
          error_count: afterClick ? 1 : 0,
          warn_count: 0,
          observed_since: "2026-04-28T01:20:00.000Z",
        });
      }
      return undefined;
    });

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "click", "1"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const [runId] = readdirSync(runRoot);
    const events = await readRunEvents(
      createRunStore({ rootDir: runRoot }),
      runId,
    );
    const afterEvidence = events.find(
      (event) =>
        event.name === "evidence.captured" && event.data?.phase === "after",
    );
    expect(afterEvidence?.data?.movement).toEqual({
      url_changed: true,
      title_changed: true,
      dom_changed: true,
      screenshot_changed: true,
      network_count_delta: 1,
      console_count_delta: 2,
      changed_dimensions: [
        "url",
        "title",
        "dom",
        "screenshot",
        "network",
        "console",
      ],
      no_observed_change: false,
    });
  });

  it("strict browser watchdog fails a recorded click with no observed movement", async () => {
    const home = useTempHome();
    const runRoot = join(home, "runs");
    process.env.UNICLI_OUTPUT = "json";
    process.env.UNICLI_RECORD_RUN = "1";
    process.env.UNICLI_RUN_ROOT = runRoot;
    process.env.UNICLI_BROWSER_WATCHDOG = "error";
    process.exitCode = undefined;
    mockPage.snapshot.mockResolvedValue("[1]<button>Save</button>");
    mockPage.evaluate.mockImplementation(async (script: string) => {
      if (script.includes("__unicli_ref_identity")) {
        return { role: "button", name: "Save", taken_at: Date.now() };
      }
      if (script.includes("document.querySelectorAll")) return 1;
      if (script.includes("__unicli_console_summary")) {
        return JSON.stringify({
          count: 0,
          error_count: 0,
          warn_count: 0,
          observed_since: "2026-04-28T01:30:00.000Z",
        });
      }
      return undefined;
    });

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "click", "1"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const err = JSON.parse(cap.getStderr().trim()) as {
      ok: boolean;
      error: { code: string; retryable: boolean; suggestion: string };
    };
    expect(err.ok).toBe(false);
    expect(err.error).toMatchObject({
      code: "no_observed_change",
      retryable: false,
      suggestion: "Inspect the browser state and retry with a fresh target.",
    });
    expect(process.exitCode).toBe(1);

    const [runId] = readdirSync(runRoot);
    const events = await readRunEvents(
      createRunStore({ rootDir: runRoot }),
      runId,
    );
    expect(events.map((event) => event.name)).toEqual([
      "run.started",
      "tool.call.started",
      "permission.evaluated",
      "evidence.captured",
      "evidence.captured",
      "tool.call.failed",
      "run.failed",
    ]);
    const afterEvidence = events.find(
      (event) =>
        event.name === "evidence.captured" && event.data?.phase === "after",
    );
    expect(afterEvidence?.data).toMatchObject({
      outcome: "failure",
      watchdog: {
        mode: "error",
        expected_movement: true,
        passed: false,
        reason: "no_observed_change",
        observed_dimensions: [],
      },
    });
    expect(events.at(-1)?.data?.error).toMatchObject({
      code: "no_observed_change",
    });
  });

  it("browser click records structured stale-ref evidence on recorded failure", async () => {
    const home = useTempHome();
    const runRoot = join(home, "runs");
    process.env.UNICLI_OUTPUT = "json";
    process.env.UNICLI_RECORD_RUN = "1";
    process.env.UNICLI_RUN_ROOT = runRoot;
    mockPage.snapshot.mockResolvedValue("[2]<button>Fresh</button>");
    mockPage.evaluate.mockImplementation(async (script: string) => {
      if (script.includes("__unicli_console_summary")) {
        return JSON.stringify({
          count: 0,
          error_count: 0,
          warn_count: 0,
          observed_since: "2026-04-28T01:10:00.000Z",
        });
      }
      if (script.includes("__unicli_ref_taken_at")) return 4200;
      if (script.includes("Object.keys")) {
        return [{ ref: "2", role: "button", name: "Fresh" }];
      }
      if (script.includes("__unicli_ref_identity")) return null;
      return undefined;
    });

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "click", "1"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const err = JSON.parse(cap.getStderr().trim()) as {
      ok: boolean;
      error: { code: string; retryable: boolean };
    };
    expect(err.ok).toBe(false);
    expect(err.error.code).toBe("stale_ref");
    expect(err.error.retryable).toBe(true);
    expect(mockPage.click).not.toHaveBeenCalled();

    const [runId] = readdirSync(runRoot);
    const events = await readRunEvents(
      createRunStore({ rootDir: runRoot }),
      runId,
    );
    expect(events.map((event) => event.name)).toEqual([
      "run.started",
      "tool.call.started",
      "permission.evaluated",
      "evidence.captured",
      "evidence.captured",
      "tool.call.failed",
      "run.failed",
    ]);
    const failedEvidence = events.find(
      (event) =>
        event.name === "evidence.captured" && event.data?.outcome === "failure",
    );
    expect(failedEvidence?.data?.error).toMatchObject({
      code: "stale_ref",
      ref: "1",
      snapshot_age_ms: 4200,
      candidates: [{ ref: "2", role: "button", name: "Fresh" }],
    });
    expect(events.at(-1)?.data?.error).toMatchObject({
      code: "stale_ref",
      ref: "1",
    });
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

  it("browser evidence captures a browser operator evidence packet", async () => {
    const home = useTempHome();
    mockPage.snapshot.mockResolvedValueOnce("[1]<button>Save</button>");
    mockPage.evaluate.mockResolvedValueOnce(undefined).mockResolvedValueOnce(
      JSON.stringify({
        count: 1,
        error_count: 0,
        warn_count: 1,
        observed_since: "2026-04-27T14:00:00.000Z",
      }),
    );
    mockPage.readNetworkCapture.mockResolvedValueOnce([
      {
        url: "https://example.com/api/feed",
        method: "GET",
        status: 200,
        contentType: "application/json",
        size: 24,
      },
    ]);

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "evidence"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      ok: boolean;
      schema_version: string;
      command: string;
      data: {
        evidence_type: string;
        workspace: string;
        lease: {
          browser_session_id: string;
          browser_workspace_id: string;
          lease_owner: string;
          scope: string;
          target: {
            kind: string;
            tab_id: number;
            window_id: number;
          };
          auth: {
            state: string;
            cookie_count?: number;
          };
        };
        observed_since: string;
        partial: boolean;
        capture_scope: {
          console: string;
          dom: string;
          network: string;
          screenshot: string;
        };
        dom: { ref_count: number; chars: number };
        console: { count: number; warn_count: number };
        network: {
          count: number;
          status_counts: Record<string, number>;
          method_counts: Record<string, number>;
        };
        screenshot: { path: string; sha256: string; skipped?: boolean };
      };
    };
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe("2");
    expect(env.command).toBe("browser.evidence");
    expect(env.data.evidence_type).toBe("browser-operator");
    expect(env.data.workspace).toBe("browser:default");
    expect(env.data.lease).toMatchObject({
      ...createBrowserSessionLease({
        namespace: "browser",
        workspace: "browser:default",
      }),
      target: {
        kind: "daemon-tab",
        tab_id: 77,
        window_id: 41,
      },
      auth: {
        state: "cookies_present",
        cookie_count: 1,
      },
    });
    expect(env.data.observed_since).toBe("2026-04-27T14:00:00.000Z");
    expect(env.data.partial).toBe(true);
    expect(env.data.capture_scope).toMatchObject({
      console: "since_hook",
      dom: "current_snapshot",
      network: "session",
      screenshot: "current_viewport",
    });
    expect(env.data.dom.ref_count).toBe(1);
    expect(env.data.dom.chars).toBe("[1]<button>Save</button>".length);
    expect(env.data.console).toMatchObject({ count: 1, warn_count: 1 });
    expect(env.data.network).toMatchObject({
      count: 1,
      status_counts: { "200": 1 },
      method_counts: { GET: 1 },
    });
    expect(env.data.screenshot.path).toContain(
      join(home, ".unicli", "evidence", "browser"),
    );
    expect(env.data.screenshot.sha256).toBe(
      "sha256:b29814cf5792e684cd75d6a7fce7a67a11887e312f87ca2ac2496d81f365ff72",
    );
    expect(mockPage.addInitScript).toHaveBeenCalledWith(
      expect.stringContaining("__unicli_console_summary"),
    );
    expect(readFileSync(env.data.screenshot.path, "utf-8")).toBe("img");
  });

  it("browser evidence can wait for render-aware stability", async () => {
    useTempHome();
    mockPage.snapshot.mockResolvedValue("[1]<main>Ready</main>");
    mockPage.evaluate.mockImplementation(async (script: string) => {
      if (script.includes("__unicli_console_summary")) {
        return JSON.stringify({
          count: 0,
          error_count: 0,
          warn_count: 0,
          observed_since: "2026-04-29T00:40:00.000Z",
        });
      }
      return undefined;
    });

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "browser",
          "evidence",
          "--render-aware",
          "--no-screenshot",
          "--stability-ms",
          "100",
          "--timeout-ms",
          "400",
          "--poll-ms",
          "50",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        render_stability: {
          reached: boolean;
          reason: string;
          samples: number;
          stable_for_ms: number;
        };
      };
    };
    expect(env.data.render_stability).toMatchObject({
      reached: true,
      reason: "stable",
    });
    expect(env.data.render_stability.samples).toBeGreaterThanOrEqual(3);
    expect(env.data.render_stability.stable_for_ms).toBeGreaterThanOrEqual(100);
  });

  it("browser evidence attaches URL guard metadata when the current tab matches", async () => {
    useTempHome();
    mockPage.url.mockResolvedValue("https://app.example.com/feed/today");
    mockPage.snapshot.mockResolvedValueOnce("[1]<button>Save</button>");
    mockPage.evaluate.mockResolvedValueOnce(undefined).mockResolvedValueOnce(
      JSON.stringify({
        count: 0,
        error_count: 0,
        warn_count: 0,
        observed_since: "2026-04-29T01:10:00.000Z",
      }),
    );

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "browser",
          "--expect-domain",
          "example.com",
          "--expect-path-prefix",
          "/feed",
          "evidence",
          "--no-screenshot",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        lease: {
          url_guard: {
            expected_domain: string;
            expected_path_prefix: string;
          };
        };
      };
    };
    expect(env.data.lease.url_guard).toEqual({
      expected_domain: "example.com",
      expected_path_prefix: "/feed",
    });
  });

  it("browser evidence fails when the current tab violates the lease URL guard", async () => {
    useTempHome();
    process.exitCode = undefined;
    mockPage.url.mockResolvedValue("https://badexample.com/feed/today");

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        ["browser", "--expect-domain", "example.com", "evidence"],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const err = JSON.parse(cap.getStderr().trim()) as {
      ok: boolean;
      error: { code: string; retryable: boolean; suggestion: string };
    };
    expect(err.ok).toBe(false);
    expect(err.error).toMatchObject({
      code: "browser_domain_mismatch",
      retryable: false,
      suggestion:
        "Bind or open a tab that matches the requested browser lease guard.",
    });
    expect(process.exitCode).toBe(1);
    expect(mockPage.screenshot).not.toHaveBeenCalled();
  });

  it("browser click fails when the leased tab target changes before action", async () => {
    useTempHome();
    process.exitCode = undefined;
    mockPage.browserTargetInfo
      .mockResolvedValueOnce({
        kind: "daemon-tab",
        captured_at: "2026-04-29T02:00:00.000Z",
        tab_id: 77,
        window_id: 41,
      })
      .mockResolvedValueOnce({
        kind: "daemon-tab",
        captured_at: "2026-04-29T02:00:01.000Z",
        tab_id: 78,
        window_id: 41,
      });

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "click", "1"], { from: "user" });
    } finally {
      cap.restore();
    }

    const err = JSON.parse(cap.getStderr().trim()) as {
      ok: boolean;
      error: { code: string; message: string; retryable: boolean };
    };
    expect(err.ok).toBe(false);
    expect(err.error).toMatchObject({
      code: "browser_target_mismatch",
      retryable: false,
    });
    expect(err.error.message).toContain("window:41:tab:77");
    expect(err.error.message).toContain("window:41:tab:78");
    expect(process.exitCode).toBe(1);
    expect(mockPage.click).not.toHaveBeenCalled();
  });

  it("browser evidence honors --no-screenshot without capturing a screenshot", async () => {
    useTempHome();
    mockPage.snapshot.mockResolvedValueOnce("[1]<button>Save</button>");
    mockPage.evaluate.mockResolvedValueOnce(undefined).mockResolvedValueOnce(
      JSON.stringify({
        count: 0,
        error_count: 0,
        warn_count: 0,
        observed_since: "2026-04-27T14:05:00.000Z",
      }),
    );

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "evidence", "--no-screenshot"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        capture_scope: { screenshot: string };
        screenshot: { skipped?: boolean };
      };
    };
    expect(env.data.screenshot).toEqual({ skipped: true });
    expect(env.data.capture_scope.screenshot).toBe("skipped");
    expect(mockPage.screenshot).not.toHaveBeenCalled();
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

  it("browser extract can wait for render-aware stability before reading text", async () => {
    mockPage.snapshot.mockResolvedValue("[1]<main>Ready article</main>");
    mockPage.evaluate.mockImplementation(async (script: string) => {
      if (script.includes("__unicli_console_summary")) {
        return JSON.stringify({
          count: 0,
          error_count: 0,
          warn_count: 0,
          observed_since: "2026-04-29T01:00:00.000Z",
        });
      }
      if (script.includes("document.body")) {
        return {
          selector: "body",
          title: "Ready",
          url: "https://example.com/article",
          content: "Ready article body",
        };
      }
      return undefined;
    });

    process.env.UNICLI_OUTPUT = "json";
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "browser",
          "extract",
          "--render-aware",
          "--no-screenshot",
          "--stability-ms",
          "100",
          "--timeout-ms",
          "400",
          "--poll-ms",
          "50",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        content: string;
        render_stability: { reached: boolean; reason: string };
      };
    };
    expect(env.data.content).toBe("Ready article body");
    expect(env.data.render_stability).toMatchObject({
      reached: true,
      reason: "stable",
    });
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
