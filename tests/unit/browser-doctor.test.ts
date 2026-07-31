import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  probe: vi.fn(),
  remote: vi.fn(),
  policy: vi.fn(),
}));

vi.mock("../../src/browser/runtime-launch.js", () => ({
  ensureBrowserRuntimeBroker: mocks.ensure,
  probeBrowserRuntimeBroker: mocks.probe,
}));
vi.mock("../../src/browser/runtime-transport.js", () => ({
  browserBrokerPaths: () => ({
    runtimeRoot: "/tmp/unicli-browser-runtime",
    descriptorPath: "/tmp/unicli-browser-runtime/endpoint.json",
  }),
}));
vi.mock("../../src/browser/launcher.js", () => ({
  findChrome: () => "/Applications/Chrome",
}));
vi.mock("../../src/browser/local-profiles.js", () => ({
  detectDefaultProfileDebugBlocks: () => [],
  detectLocalBrowserProfiles: () => [
    {
      id: "google-chrome:Default",
      browser_path_exists: true,
      browser_path: "/Applications/Chrome",
    },
  ],
  selectBrowserIdentityFromProfiles: (profiles: unknown[]) => ({
    status: "selected",
    source: "preferred",
    profile: profiles[0],
  }),
  resolvePreferredLocalBrowserProfile: () => ({
    id: "google-chrome:Default",
    browser_path_exists: true,
    browser_path: "/Applications/Chrome",
  }),
}));
vi.mock("../../src/browser/chrome-policy.js", () => ({
  detectChromeRemoteDebuggingPolicy: mocks.policy,
}));
vi.mock("../../src/browser/profile-seed.js", () => ({
  isBrowserEphemeralRequested: () => false,
}));
vi.mock("../../src/browser/remote-browser.js", () => ({
  readRemoteEndpoint: mocks.remote,
}));

import {
  repairBrowserDoctor,
  runBrowserDoctor,
} from "../../src/browser/doctor.js";

describe("browser doctor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.probe.mockRejectedValue(
      Object.assign(new Error("stopped"), {
        code: "browser_broker_unavailable",
      }),
    );
    mocks.remote.mockReturnValue(null);
    mocks.policy.mockReturnValue({
      name: "RemoteDebuggingAllowed",
      state: "not-configured",
      source: "not-found",
      detail: "not configured",
      next_step: "none",
      commands: [],
      official_docs: [],
    });
  });

  it("reports a usable hidden default path without starting control plane or provider", async () => {
    const report = await runBrowserDoctor();

    expect(report.status).toBe("ready");
    expect(report.default_path).toEqual({
      provider: "managed",
      visibility: "hidden",
      available: true,
      profile_source: "seeded",
    });
    expect(report.broker.state).toBe("stopped");
    expect(report.providers.managed).toEqual([]);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("surfaces malformed remote configuration as an exact repair instead of hiding it", async () => {
    mocks.remote.mockImplementation(() => {
      throw Object.assign(new Error("UNICLI_CDP_HEADERS is not valid JSON"), {
        code: "remote_browser_configuration_invalid",
      });
    });

    const report = await runBrowserDoctor();
    const remote = report.checks.find((check) => check.id === "remote_hidden");

    expect(remote).toMatchObject({
      status: "needs-action",
      evidence: {
        configured: true,
        configuration_error: "UNICLI_CDP_HEADERS is not valid JSON",
      },
    });
    expect(report.next_actions).toContain(
      "Correct or unset UNICLI_CDP_ENDPOINT and UNICLI_CDP_HEADERS, then restart the broker.",
    );
  });

  it("repairs only the broker control plane", async () => {
    mocks.ensure.mockResolvedValue({
      spawned: true,
      status: { broker_pid: 321, runtime_id: "runtime-1" },
    });

    await expect(repairBrowserDoctor()).resolves.toEqual({
      attempted: true,
      action: "broker.start",
      status: "started",
      broker_pid: 321,
      runtime_id: "runtime-1",
    });
  });

  it("marks the managed default path unavailable when Chrome policy blocks remote debugging", async () => {
    mocks.policy.mockReturnValue({
      name: "RemoteDebuggingAllowed",
      state: "disabled",
      value: false,
      source: "managed-policy",
      detail: "disabled",
      next_step: "Remove the false Chrome policy and restart Chrome.",
      commands: [],
      official_docs: [],
    });

    const report = await runBrowserDoctor();

    expect(report.status).toBe("needs-action");
    expect(report.default_path).toMatchObject({
      available: false,
      profile_source: "policy-blocked",
    });
    expect(
      report.checks.find((check) => check.id === "managed_hidden"),
    ).toMatchObject({
      status: "needs-action",
      next_step: "Remove the false Chrome policy and restart Chrome.",
    });
  });
});
