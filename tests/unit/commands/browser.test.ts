import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
  fetchDaemonPortConflict: vi.fn().mockResolvedValue(null),
  fetchDaemonStatus: vi.fn().mockResolvedValue({
    pid: 999,
    uptime: 10,
    extensionConnected: true,
    pending: 0,
    memoryMB: 32,
    port: 19825,
  }),
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

const launcherMocks = vi.hoisted(() => ({
  findChrome: vi.fn(
    () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ),
  getCDPPort: vi.fn(() => Number(process.env.UNICLI_CDP_PORT ?? 9222)),
  isCDPAvailable: vi.fn().mockResolvedValue(false),
  findAvailableCDPPort: vi.fn(async (port: number) => port),
  launchChrome: vi.fn().mockResolvedValue(9222),
}));

const cookieExtractorMocks = vi.hoisted(() => ({
  extractCookiesViaCDP: vi.fn().mockResolvedValue({ sid: "cookie" }),
  saveCookies: vi.fn().mockReturnValue("/tmp/unicli-cookies/example.json"),
}));

const chromiumCookieMocks = vi.hoisted(() => {
  class ChromiumCookieError extends Error {
    constructor(
      public readonly code: string,
      message: string,
      public readonly suggestion?: string,
    ) {
      super(message);
      this.name = "ChromiumCookieError";
    }
  }
  return {
    ChromiumCookieError,
    readCookiesAsRecord: vi.fn().mockReturnValue({}),
  };
});

const chromePolicyMocks = vi.hoisted(() => ({
  buildChrome136RemoteDebuggingGuidance: vi.fn(() => ({
    default_user_data_dir_cdp_supported: false,
    policy_can_bypass_default_user_data_dir: false,
    automatic_fix: "custom-user-data-dir",
    safe_command: "unicli browser doctor --repair",
    supported_paths: [
      "Launch Chrome with a Uni-CLI-owned non-default --user-data-dir under ~/.unicli.",
      "Use Chrome for Testing or Chromium when a fully automation-owned browser is acceptable.",
    ],
    unsupported_paths: [
      "Do not retry Google Chrome --remote-debugging-port against the browser default user-data-dir.",
      "Do not rely on RemoteDebuggingAllowed policy to bypass the Chrome 136+ default-directory restriction.",
    ],
    user_visible_warning:
      "Chrome 136+ ignores remote debugging switches for the default user-data-dir; Uni-CLI repairs this by starting a separate automation profile and reusing auth through cookie import.",
    official_docs: [
      "https://developer.chrome.com/blog/remote-debugging-port",
      "https://support.google.com/chrome/a/answer/10314655",
      "https://chromeenterprise.google/policies/remote-debugging-allowed/",
    ],
  })),
  detectChromeRemoteDebuggingPolicy: vi.fn(() => ({
    name: "RemoteDebuggingAllowed",
    state: "not-configured",
    source: "not-found",
    detail:
      "RemoteDebuggingAllowed is not configured, so Chrome allows remote debugging except for the Chrome 136+ default data-dir restriction.",
    next_step: "Use `unicli browser doctor --repair` for local CDP.",
    commands: ["unicli browser doctor --repair"],
    official_docs: [
      "https://developer.chrome.com/blog/remote-debugging-port",
      "https://support.google.com/chrome/a/answer/10314655",
      "https://chromeenterprise.google/policies/remote-debugging-allowed/",
    ],
  })),
}));

vi.mock("../../../src/browser/bridge.js", () => ({
  BROWSER_REMOTE_CONNECT_MAX_ATTEMPTS: 3,
  BROWSER_REMOTE_RETRY_DELAY_MS: 1000,
  BrowserBridge: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(mockPage),
  })),
  BridgeConnectionError: class BridgeConnectionError extends Error {},
  DaemonPage: vi.fn(),
}));

vi.mock("../../../src/browser/launcher.js", () => launcherMocks);

vi.mock("../../../src/browser/daemon-client.js", () => ({
  BROWSER_DAEMON_COMMAND_MAX_ATTEMPTS: 4,
  BROWSER_DAEMON_EXTENSION_RETRY_DELAY_MS: 1500,
  BROWSER_DAEMON_NETWORK_RETRY_DELAY_MS: 500,
  fetchDaemonPortConflict: daemonClientMocks.fetchDaemonPortConflict,
  fetchDaemonStatus: daemonClientMocks.fetchDaemonStatus,
  listSessions: daemonClientMocks.listSessions,
  bindCurrentTab: daemonClientMocks.bindCurrentTab,
  sendCommand: daemonClientMocks.sendCommand,
}));

vi.mock("../../../src/engine/cookie-extractor.js", () => cookieExtractorMocks);

vi.mock("../../../src/engine/chromium-cookies.js", () => chromiumCookieMocks);

vi.mock("../../../src/browser/chrome-policy.js", () => chromePolicyMocks);

import { registerBrowserCommands } from "../../../src/commands/browser/index.js";

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
  let origUserProfile: string | undefined;
  let origAppData: string | undefined;
  let origLocalAppData: string | undefined;
  let origRecordRun: string | undefined;
  let origRunRoot: string | undefined;
  let origBrowserWatchdog: string | undefined;
  let origCdpEndpoint: string | undefined;
  let origCdpHeaders: string | undefined;
  let origCdpPort: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockPage();
    process.exitCode = undefined;
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    origAppData = process.env.APPDATA;
    origLocalAppData = process.env.LOCALAPPDATA;
    origRecordRun = process.env.UNICLI_RECORD_RUN;
    origRunRoot = process.env.UNICLI_RUN_ROOT;
    origBrowserWatchdog = process.env.UNICLI_BROWSER_WATCHDOG;
    origCdpEndpoint = process.env.UNICLI_CDP_ENDPOINT;
    origCdpHeaders = process.env.UNICLI_CDP_HEADERS;
    origCdpPort = process.env.UNICLI_CDP_PORT;
    daemonClientMocks.fetchDaemonPortConflict.mockResolvedValue(null);
    daemonClientMocks.fetchDaemonStatus.mockResolvedValue({
      pid: 999,
      uptime: 10,
      extensionConnected: true,
      pending: 0,
      memoryMB: 32,
      port: 19825,
    });
    daemonClientMocks.listSessions.mockResolvedValue([
      {
        workspace: "browser:default",
        windowId: 41,
        tabCount: 2,
        idleMsRemaining: 12_000,
      },
    ]);
    launcherMocks.findChrome.mockReturnValue(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    launcherMocks.getCDPPort.mockImplementation(() =>
      Number(process.env.UNICLI_CDP_PORT ?? 9222),
    );
    launcherMocks.isCDPAvailable.mockResolvedValue(false);
    launcherMocks.findAvailableCDPPort.mockImplementation(
      async (port: number) => port,
    );
    launcherMocks.launchChrome.mockResolvedValue(9222);
    cookieExtractorMocks.extractCookiesViaCDP.mockResolvedValue({
      sid: "cookie",
    });
    cookieExtractorMocks.saveCookies.mockReturnValue(
      "/tmp/unicli-cookies/example.json",
    );
    chromiumCookieMocks.readCookiesAsRecord.mockReturnValue({});
    chromePolicyMocks.detectChromeRemoteDebuggingPolicy.mockReturnValue({
      name: "RemoteDebuggingAllowed",
      state: "not-configured",
      source: "not-found",
      detail:
        "RemoteDebuggingAllowed is not configured, so Chrome allows remote debugging except for the Chrome 136+ default data-dir restriction.",
      next_step: "Use `unicli browser doctor --repair` for local CDP.",
      commands: ["unicli browser doctor --repair"],
      official_docs: [
        "https://developer.chrome.com/blog/remote-debugging-port",
        "https://support.google.com/chrome/a/answer/10314655",
        "https://chromeenterprise.google/policies/remote-debugging-allowed/",
      ],
    });
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
    if (origCdpEndpoint === undefined) delete process.env.UNICLI_CDP_ENDPOINT;
    else process.env.UNICLI_CDP_ENDPOINT = origCdpEndpoint;
    if (origCdpHeaders === undefined) delete process.env.UNICLI_CDP_HEADERS;
    else process.env.UNICLI_CDP_HEADERS = origCdpHeaders;
    if (origCdpPort === undefined) delete process.env.UNICLI_CDP_PORT;
    else process.env.UNICLI_CDP_PORT = origCdpPort;
    if (tmpHome) {
      rmSync(tmpHome, { recursive: true, force: true });
      tmpHome = null;
    }
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
    if (origAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = origAppData;
    if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = origLocalAppData;
  });

  function useTempHome(): string {
    tmpHome = mkdtempSync(join(tmpdir(), "unicli-browser-cmd-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.APPDATA = join(tmpHome, "AppData", "Roaming");
    process.env.LOCALAPPDATA = join(tmpHome, "AppData", "Local");
    return tmpHome;
  }

  it("browser sessions emits a structured error when the extension bridge is unavailable", async () => {
    daemonClientMocks.listSessions.mockRejectedValueOnce(
      new Error("Compatible Uni-CLI browser extension not connected"),
    );
    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "sessions", "--json"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      ok: boolean;
      command: string;
      error: { code: string; message: string; retryable: boolean };
    };
    expect(env.ok).toBe(false);
    expect(env.command).toBe("browser.sessions");
    expect(env.error).toMatchObject({
      code: "internal_error",
      message: "Compatible Uni-CLI browser extension not connected",
      retryable: false,
    });
    expect(process.exitCode).toBe(1);
  });

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
      "environment.snapshot",
      "tool.call.started",
      "permission.evaluated",
      "evidence.captured",
      "evidence.captured",
      "tool.call.completed",
      "run.completed",
    ]);
    expect(events[1]).toMatchObject({
      visibility: "public",
      data: {
        schema_version: "1",
        transport_surface: "cli",
        target_surface: "web",
        permission_profile: "open",
        pipeline_steps: 0,
      },
    });
    expect(events[1]).not.toHaveProperty("internal");
    expect(events[1]).not.toHaveProperty("secret");
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
      "environment.snapshot",
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
      "environment.snapshot",
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

  it("browser profiles lists local Chromium-family profiles with stable ids", async () => {
    const home = useTempHome();
    const chromeRoot = join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
    mkdirSync(join(chromeRoot, "Default"), { recursive: true });
    writeFileSync(
      join(chromeRoot, "Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "Personal" } } },
      }),
    );
    writeFileSync(join(chromeRoot, "Default", "Preferences"), "{}");
    process.env.UNICLI_OUTPUT = "json";

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "profiles"], { from: "user" });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      command: string;
      data: {
        source: string;
        profiles: Array<{
          id: string;
          browser_name: string;
          profile_dir: string;
          profile_name: string;
          display_name: string;
          profile_path: string;
          debug_port: { state: string };
        }>;
      };
    };
    expect(env.command).toBe("browser.profiles");
    expect(env.data.source).toBe("local-filesystem");
    expect(env.data.profiles).toEqual([
      expect.objectContaining({
        id: "google-chrome:Default",
        browser_name: "Google Chrome",
        profile_dir: "Default",
        profile_name: "Personal",
        display_name: "Google Chrome - Personal",
        profile_path: join(chromeRoot, "Default"),
        debug_port: { state: "not-recorded" },
      }),
    ]);
  });

  it("browser doctor reports the browser reliability contract", async () => {
    const home = useTempHome();
    const chromeRoot = join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
    mkdirSync(join(chromeRoot, "Default"), { recursive: true });
    writeFileSync(
      join(chromeRoot, "Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "Personal" } } },
      }),
    );
    writeFileSync(join(chromeRoot, "Default", "Preferences"), "{}");
    process.env.UNICLI_OUTPUT = "json";
    process.env.UNICLI_CDP_ENDPOINT =
      "wss://user:secret@remote.example/devtools/browser/secret-id?token=hidden#fragsecret";
    process.env.UNICLI_CDP_HEADERS = JSON.stringify({
      Authorization: "Bearer secret",
    });

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "doctor", "--json"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      command: string;
      data: {
        status: string;
        cookie_reuse: {
          status: string;
          profiles_count: number;
          raw_cookie_values_returned: boolean;
          raw_cookie_export_supported: boolean;
          direct_browser_cookie_import_supported: boolean;
          command: string;
          direct_browser_cookie_import_command: string;
          explicit_cookie_export_command: string;
          reuse_paths: string[];
        };
        background_operation: {
          status: string;
          daemon: { status: string; extension_connected: boolean };
          sessions_count: number;
          controls: string[];
        };
        browser_use: {
          modes: string[];
          layers: Array<{ name: string }>;
        };
        direct_connect: {
          local_cdp: { port: number; command: string };
          remote_cdp: {
            configured: boolean;
            endpoint: string;
            header_count: number;
          };
        };
        chrome_remote_debugging: {
          chrome_136: {
            default_user_data_dir_cdp_supported: boolean;
            policy_can_bypass_default_user_data_dir: boolean;
            safe_command: string;
          };
          policy: { name: string; state: string };
        };
        stability_reliability: {
          guards: string[];
          evidence: string[];
        };
        repair_retry: {
          retry_policy: Array<{
            surface: string;
            max_attempts: number;
            retry_delay_ms?: number;
            network_retry_delay_ms?: number;
            extension_retry_delay_ms?: number;
          }>;
          recovery_commands: string[];
        };
        default_path: {
          status: string;
          mode: string;
          ready: boolean;
          next_step: string;
          commands: string[];
        };
        checks: Array<{
          name: string;
          ok: boolean;
          status: string;
          next_step: string;
          commands?: string[];
          auto_repairable?: boolean;
        }>;
        self_repair: {
          safe_command: string;
          actions: Array<{
            id: string;
            status: string;
            command: string;
            safe: boolean;
          }>;
        };
        completeness: {
          complete: boolean;
          required_capabilities: string[];
          missing: string[];
          matrix: Record<
            string,
            {
              status: string;
              evidence: string[];
              repair_commands: string[];
              diagnostics?: string[];
            }
          >;
        };
      };
    };

    expect(env.command).toBe("browser.doctor");
    expect(env.data.status).toBe("ready");
    expect(env.data.cookie_reuse).toMatchObject({
      status: "ready",
      profiles_count: 1,
      raw_cookie_values_returned: false,
      raw_cookie_export_supported: true,
      direct_browser_cookie_import_supported: true,
      command: "unicli browser profiles --json",
      direct_browser_cookie_import_command:
        "unicli auth import <site> --domain <domain> --browser <id> --profile <name>",
      explicit_cookie_export_command:
        "unicli browser cookies <domain> --profile-id <id>",
    });
    expect(env.data.cookie_reuse.reuse_paths).toEqual(
      expect.arrayContaining([
        "direct browser DB cookie import",
        "profile DevToolsActivePort",
        "automation profile launch under ~/.unicli",
        "selected profile cookie injection into CDP automation profile",
        "explicit raw cookie export through browser cookies",
      ]),
    );
    expect(env.data.background_operation).toMatchObject({
      status: "ready",
      daemon: { status: "running", extension_connected: true },
      sessions_count: 1,
    });
    expect(env.data.background_operation.controls).toEqual(
      expect.arrayContaining([
        "default windowFocused=false",
        "browser start uses --no-startup-window by default",
        "--background",
        "--focus",
        "--workspace",
        "--isolated",
      ]),
    );
    expect(env.data.browser_use.modes).toEqual(
      expect.arrayContaining(["logged-in Chrome", "headless Chrome"]),
    );
    expect(env.data.browser_use.layers.map((layer) => layer.name)).toEqual([
      "runtime-control",
      "browser-session",
      "page-state",
      "evidence-repair",
    ]);
    expect(env.data.direct_connect.local_cdp).toMatchObject({
      port: 9222,
      command: "unicli browser start",
    });
    expect(env.data.direct_connect.remote_cdp).toEqual({
      configured: true,
      endpoint: "wss://remote.example/devtools/browser/...?...",
      header_count: 1,
    });
    expect(env.data.chrome_remote_debugging.chrome_136).toMatchObject({
      default_user_data_dir_cdp_supported: false,
      policy_can_bypass_default_user_data_dir: false,
      safe_command: "unicli browser doctor --repair",
    });
    expect(env.data.chrome_remote_debugging.policy).toMatchObject({
      name: "RemoteDebuggingAllowed",
      state: "not-configured",
    });
    expect(env.data.stability_reliability.guards).toEqual(
      expect.arrayContaining([
        "non-focusing daemon command default",
        "no-startup-window local Chrome launch",
        "doctor sessions probe does not create placeholder tabs",
        "workspace lease",
        "target lease",
        "domain/path guard",
        "render stability probe",
      ]),
    );
    expect(env.data.stability_reliability.evidence).toEqual(
      expect.arrayContaining(["DOM snapshot", "screenshot", "network"]),
    );
    expect(env.data.repair_retry.retry_policy).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: "daemon-command",
          max_attempts: 4,
          network_retry_delay_ms: 500,
          extension_retry_delay_ms: 1500,
        }),
        expect.objectContaining({
          surface: "remote-cdp",
          max_attempts: 3,
          retry_delay_ms: 1000,
        }),
      ]),
    );
    expect(env.data.repair_retry.recovery_commands).toEqual(
      expect.arrayContaining([
        "unicli auth import <site> --domain <domain>",
        "unicli browser start",
        "unicli browser bind",
        "unicli repair <site> <command>",
      ]),
    );
    expect(env.data.default_path).toMatchObject({
      status: "ready",
      mode: "remote-cdp",
      ready: true,
      next_step: "Run the requested Uni-CLI command.",
    });
    expect(env.data.default_path.commands).toEqual(
      expect.arrayContaining([
        "unicli browser remote --status",
        "unicli <site> <command> -f json",
      ]),
    );
    expect(env.data.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Chrome 136+ remote debugging hardening",
          ok: true,
          status: "ready",
        }),
        expect.objectContaining({
          name: "remote debugging policy",
          ok: true,
          status: "ready",
        }),
        expect.objectContaining({
          name: "local automation CDP",
          ok: false,
          status: "needs-action",
          next_step: "unicli browser doctor --repair",
          auto_repairable: true,
        }),
        expect.objectContaining({
          name: "default profile CDP trap",
          ok: true,
          status: "ready",
          next_step: "No action.",
        }),
      ]),
    );
    expect(env.data.self_repair.safe_command).toBe(
      "unicli browser doctor --repair",
    );
    expect(env.data.self_repair.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "start-local-automation-cdp",
          status: "available",
          command: "unicli browser doctor --repair",
          safe: true,
        }),
      ]),
    );
    expect(env.data.completeness.complete).toBe(true);
    expect(env.data.completeness.missing).toEqual([]);
    expect(env.data.completeness.required_capabilities).toEqual([
      "cookie_reuse",
      "background_operation",
      "browser_use",
      "page_layering",
      "direct_connect",
      "stability",
      "reliability",
      "repair",
      "retry",
    ]);
    expect(env.data.completeness.matrix.cookie_reuse).toMatchObject({
      status: "ready",
      repair_commands: [
        "unicli browser profiles --json",
        "unicli auth import <site> --domain <domain> --browser <id> --profile <name>",
        "unicli browser cookies <domain> --profile-id <id>",
      ],
    });
    expect(env.data.completeness.matrix.cookie_reuse.evidence).toEqual(
      expect.arrayContaining([
        "raw_cookie_export_supported=true",
        "direct_browser_cookie_import_supported=true",
        "unicli auth import <site> --domain <domain> --browser <id> --profile <name>",
        "unicli browser cookies <domain> --profile-id <id>",
      ]),
    );
    expect(env.data.completeness.matrix.direct_connect.evidence).toEqual(
      expect.arrayContaining(["remote CDP configured"]),
    );
    expect(env.data.completeness.matrix.retry.evidence).toEqual(
      expect.arrayContaining([
        "daemon-command max_attempts=4",
        "remote-cdp max_attempts=3",
      ]),
    );
    expect(cap.getStdout()).not.toContain("secret");
    expect(cap.getStdout()).not.toContain("secret-id");
    expect(cap.getStdout()).not.toContain("hidden");
    expect(cap.getStdout()).not.toContain("fragsecret");
    expect(cap.getStdout()).not.toContain("Authorization");
  });

  it("browser doctor reports missing browser capability surfaces", async () => {
    useTempHome();
    daemonClientMocks.fetchDaemonStatus.mockResolvedValue(null);
    daemonClientMocks.fetchDaemonPortConflict.mockResolvedValue(
      "port 19825 is occupied by a non-Uni-CLI browser daemon",
    );
    delete process.env.UNICLI_CDP_ENDPOINT;
    delete process.env.UNICLI_CDP_HEADERS;
    process.env.UNICLI_CDP_PORT = "9";
    process.env.UNICLI_OUTPUT = "json";

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "doctor", "--json"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        status: string;
        background_operation: {
          status: string;
          daemon: { status: string; conflict?: string };
        };
        direct_connect: {
          local_cdp: { port: number; reachable: boolean };
          remote_cdp: { configured: boolean; header_count: number };
        };
        completeness: {
          complete: boolean;
          missing: string[];
          matrix: Record<
            string,
            {
              status: string;
              diagnostics?: string[];
              repair_commands: string[];
            }
          >;
        };
      };
    };

    expect(env.data.status).toBe("needs-action");
    expect(process.exitCode).toBe(1);
    expect(env.data.background_operation).toMatchObject({
      status: "blocked",
      daemon: {
        status: "blocked",
        conflict: "port 19825 is occupied by a non-Uni-CLI browser daemon",
      },
    });
    expect(env.data.direct_connect).toMatchObject({
      local_cdp: { port: 9, reachable: false },
      remote_cdp: { configured: false, header_count: 0 },
    });
    expect(env.data.completeness.complete).toBe(false);
    expect(env.data.completeness.missing).toEqual(
      expect.arrayContaining([
        "cookie_reuse",
        "background_operation",
        "direct_connect",
        "reliability",
      ]),
    );
    expect(
      env.data.completeness.matrix.background_operation.diagnostics,
    ).toEqual(
      expect.arrayContaining([
        "port 19825 is occupied by a non-Uni-CLI browser daemon",
      ]),
    );
    expect(env.data.completeness.matrix.direct_connect.repair_commands).toEqual(
      expect.arrayContaining([
        "unicli browser start",
        "unicli browser remote --status",
      ]),
    );
    expect(env.data.completeness.matrix.repair.status).toBe("ready");
    expect(env.data.completeness.matrix.retry.status).toBe("ready");
  });

  it("browser doctor --repair starts the safe local automation CDP path", async () => {
    useTempHome();
    launcherMocks.isCDPAvailable
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    process.env.UNICLI_OUTPUT = "json";

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "doctor", "--repair", "--json"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        repair_attempt?: {
          status: string;
          actions: Array<{ id: string; status: string; command: string }>;
        };
        direct_connect: { local_cdp: { reachable: boolean } };
      };
    };
    expect(launcherMocks.launchChrome).toHaveBeenCalledWith(9222);
    expect(env.data.repair_attempt).toMatchObject({
      status: "repaired",
      actions: [
        {
          id: "start-local-automation-cdp",
          status: "repaired",
          command: "unicli browser start",
        },
      ],
    });
    expect(env.data.direct_connect.local_cdp.reachable).toBe(true);
  });

  it("browser doctor --repair refuses unsupported policy bypasses when remote debugging is disabled", async () => {
    useTempHome();
    launcherMocks.isCDPAvailable.mockResolvedValue(false);
    chromePolicyMocks.detectChromeRemoteDebuggingPolicy.mockReturnValue({
      name: "RemoteDebuggingAllowed",
      state: "disabled",
      value: false,
      source: "mac-defaults",
      source_path: "/Library/Managed Preferences/com.google.Chrome",
      detail:
        "Chrome policy RemoteDebuggingAllowed=false blocks all remote-debugging switches, including Uni-CLI automation profiles.",
      next_step:
        "Remove the false Chrome policy or set RemoteDebuggingAllowed=true, then fully restart Chrome.",
      commands: ["open chrome://policy"],
      official_docs: [
        "https://developer.chrome.com/blog/remote-debugging-port",
        "https://chromeenterprise.google/policies/remote-debugging-allowed/",
      ],
    });
    process.env.UNICLI_OUTPUT = "json";

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(["browser", "doctor", "--repair", "--json"], {
        from: "user",
      });
    } finally {
      cap.restore();
    }

    const env = JSON.parse(cap.getStdout().trim()) as {
      data: {
        repair_attempt?: {
          status: string;
          actions: Array<{ id: string; status: string; command: string }>;
        };
        checks: Array<{ name: string; ok: boolean; next_step: string }>;
        self_repair: { actions: Array<{ id: string; status: string }> };
      };
    };
    expect(launcherMocks.launchChrome).not.toHaveBeenCalled();
    expect(env.data.repair_attempt).toMatchObject({
      status: "failed",
      actions: [
        {
          id: "enable-remote-debugging-policy",
          status: "failed",
          command:
            "Remove the false Chrome policy or set RemoteDebuggingAllowed=true, then fully restart Chrome.",
        },
      ],
    });
    expect(env.data.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "remote debugging policy",
          ok: false,
          next_step:
            "Remove the false Chrome policy or set RemoteDebuggingAllowed=true, then fully restart Chrome.",
        }),
      ]),
    );
    expect(env.data.self_repair.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "start-local-automation-cdp",
          status: "blocked",
        }),
      ]),
    );
  });

  it("browser cookies uses a selected profile's live DevTools port before launching", async () => {
    const home = useTempHome();
    const chromeRoot = join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
    mkdirSync(join(chromeRoot, "Default"), { recursive: true });
    writeFileSync(
      join(chromeRoot, "Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "Personal" } } },
      }),
    );
    writeFileSync(join(chromeRoot, "Default", "Preferences"), "{}");
    writeFileSync(
      join(chromeRoot, "DevToolsActivePort"),
      "9444\n/devtools/browser/live\n",
    );
    launcherMocks.isCDPAvailable.mockImplementation(async (port: number) => {
      return port === 9444;
    });

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "browser",
          "cookies",
          "example.com",
          "--profile-id",
          "google-chrome:Default",
          "--port",
          "9333",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(launcherMocks.launchChrome).not.toHaveBeenCalled();
    expect(cookieExtractorMocks.extractCookiesViaCDP).toHaveBeenCalledWith(
      "example.com",
      9444,
    );
    expect(cookieExtractorMocks.saveCookies).toHaveBeenCalledWith(
      "example-com",
      { sid: "cookie" },
    );
    expect(cap.getStdout()).toContain("Extracted 1 cookies for example.com");
  });

  it("browser cookies imports raw cookies from the selected local browser profile before CDP", async () => {
    const home = useTempHome();
    const chromeRoot = join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
    mkdirSync(join(chromeRoot, "Default"), { recursive: true });
    writeFileSync(
      join(chromeRoot, "Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "Personal" } } },
      }),
    );
    writeFileSync(join(chromeRoot, "Default", "Preferences"), "{}");
    chromiumCookieMocks.readCookiesAsRecord.mockReturnValue({
      sid: "raw-cookie",
    });
    launcherMocks.isCDPAvailable.mockResolvedValue(true);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "browser",
          "cookies",
          "example.com",
          "--profile-id",
          "google-chrome:Default",
          "--port",
          "9333",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(chromiumCookieMocks.readCookiesAsRecord).toHaveBeenCalledWith({
      browser: "chrome",
      domain: "example.com",
      profile: "Default",
    });
    expect(launcherMocks.findAvailableCDPPort).not.toHaveBeenCalled();
    expect(launcherMocks.launchChrome).not.toHaveBeenCalled();
    expect(cookieExtractorMocks.extractCookiesViaCDP).not.toHaveBeenCalled();
    expect(cookieExtractorMocks.saveCookies).toHaveBeenCalledWith(
      "example-com",
      { sid: "raw-cookie" },
    );
    expect(cap.getStdout()).toContain("Extracted 1 cookies for example.com");
  });

  it("browser cookies reuses a selected profile only when its recorded CDP port is live", async () => {
    const home = useTempHome();
    const chromeRoot = join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
    mkdirSync(join(chromeRoot, "Default"), { recursive: true });
    writeFileSync(
      join(chromeRoot, "Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "Personal" } } },
      }),
    );
    writeFileSync(join(chromeRoot, "Default", "Preferences"), "{}");
    chromiumCookieMocks.readCookiesAsRecord.mockImplementation(() => {
      throw new chromiumCookieMocks.ChromiumCookieError(
        "keychain_denied",
        "keychain denied",
      );
    });
    writeFileSync(
      join(chromeRoot, "DevToolsActivePort"),
      "9444\n/devtools/browser/live\n",
    );
    launcherMocks.isCDPAvailable.mockImplementation(async (port: number) => {
      return port === 9444;
    });

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "browser",
          "cookies",
          "example.com",
          "--profile-id",
          "google-chrome:Default",
          "--port",
          "9333",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(launcherMocks.findAvailableCDPPort).not.toHaveBeenCalled();
    expect(launcherMocks.launchChrome).not.toHaveBeenCalled();
    expect(cookieExtractorMocks.extractCookiesViaCDP).toHaveBeenCalledWith(
      "example.com",
      9444,
    );
  });

  it("browser cookies fails closed instead of launching the default profile with CDP when direct import is unavailable", async () => {
    const home = useTempHome();
    const chromeRoot = join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
    mkdirSync(join(chromeRoot, "Default"), { recursive: true });
    writeFileSync(
      join(chromeRoot, "Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "Personal" } } },
      }),
    );
    writeFileSync(join(chromeRoot, "Default", "Preferences"), "{}");
    chromiumCookieMocks.readCookiesAsRecord.mockImplementation(() => {
      throw new chromiumCookieMocks.ChromiumCookieError(
        "keychain_denied",
        "keychain denied",
      );
    });
    launcherMocks.isCDPAvailable.mockResolvedValue(false);
    launcherMocks.launchChrome.mockResolvedValue(9333);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "browser",
          "cookies",
          "example.com",
          "--profile-id",
          "google-chrome:Default",
          "--port",
          "9333",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(launcherMocks.findAvailableCDPPort).not.toHaveBeenCalled();
    expect(launcherMocks.launchChrome).not.toHaveBeenCalled();
    expect(cookieExtractorMocks.extractCookiesViaCDP).not.toHaveBeenCalled();
    expect(cap.getStderr()).toContain("Direct cookie DB import unavailable");
    expect(cap.getStderr()).toContain(
      "Chrome blocks CDP on its default profile",
    );
    expect(process.exitCode).toBe(1);
  });

  it("browser start launches a selected logged-in profile with CDP", async () => {
    const home = useTempHome();
    const chromeRoot = join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
    mkdirSync(join(chromeRoot, "Default"), { recursive: true });
    writeFileSync(
      join(chromeRoot, "Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "Personal" } } },
      }),
    );
    writeFileSync(join(chromeRoot, "Default", "Preferences"), "{}");
    launcherMocks.isCDPAvailable.mockResolvedValue(false);
    launcherMocks.launchChrome.mockResolvedValue(9333);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "browser",
          "start",
          "--profile-id",
          "google-chrome:Default",
          "--port",
          "9333",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(launcherMocks.launchChrome).toHaveBeenCalledWith(
      9333,
      expect.objectContaining({
        userDataDir: join(
          home,
          ".unicli",
          "browser-profiles",
          "google-chrome_Default",
        ),
      }),
    );
    const launchOptions = launcherMocks.launchChrome.mock.calls[0]?.[1] as
      | { profileDirectory?: string }
      | undefined;
    expect(launchOptions?.profileDirectory).toBeUndefined();
    expect(cap.getStdout()).toContain("Chrome CDP ready on port 9333");
  });

  it("browser start only allows a foreground startup window when --focus is explicit", async () => {
    const home = useTempHome();
    const chromeRoot = join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
    mkdirSync(join(chromeRoot, "Default"), { recursive: true });
    writeFileSync(
      join(chromeRoot, "Local State"),
      JSON.stringify({
        profile: { info_cache: { Default: { name: "Personal" } } },
      }),
    );
    writeFileSync(join(chromeRoot, "Default", "Preferences"), "{}");
    launcherMocks.isCDPAvailable.mockResolvedValue(false);
    launcherMocks.launchChrome.mockResolvedValue(9333);

    const cap = captureConsole();
    try {
      const program = createProgram();
      await program.parseAsync(
        [
          "browser",
          "--focus",
          "start",
          "--profile-id",
          "google-chrome:Default",
          "--port",
          "9333",
        ],
        { from: "user" },
      );
    } finally {
      cap.restore();
    }

    expect(launcherMocks.launchChrome).toHaveBeenCalledWith(
      9333,
      expect.objectContaining({
        background: false,
        userDataDir: join(
          home,
          ".unicli",
          "browser-profiles",
          "google-chrome_Default",
        ),
      }),
    );
    const launchOptions = launcherMocks.launchChrome.mock.calls[0]?.[1] as
      | { profileDirectory?: string }
      | undefined;
    expect(launchOptions?.profileDirectory).toBeUndefined();
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
