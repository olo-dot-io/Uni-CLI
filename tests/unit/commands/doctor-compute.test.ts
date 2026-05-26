import { describe, expect, it } from "vitest";

import { runComputeDoctor } from "../../../src/commands/doctor-compute.js";

describe("doctor compute", () => {
  it("reports a stable per-transport check structure", async () => {
    const report = await runComputeDoctor();

    expect(report.host.platform).toBe(process.platform);
    expect(report.checks.length).toBeGreaterThanOrEqual(6);
    expect(new Set(report.checks.map((check) => check.transport))).toEqual(
      new Set([
        "desktop-ax",
        "desktop-uia",
        "desktop-atspi",
        "subprocess",
        "cdp-browser",
        "visual",
        "overlay",
      ]),
    );
    for (const check of report.checks) {
      expect(check.name.length).toBeGreaterThan(0);
      expect(check.transport.length).toBeGreaterThan(0);
      expect(["ok", "warn", "fail", "skip"]).toContain(check.status);
      expect(typeof check.ok).toBe("boolean");
      expect(check.detail.length).toBeGreaterThan(0);
      if (check.status === "fail") {
        expect(check.remedy?.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("includes the macOS Screen Recording probe on darwin hosts", async () => {
    const report = await runComputeDoctor();
    const check = report.checks.find(
      (candidate) =>
        candidate.transport === "desktop-ax" &&
        candidate.name === "screen-recording",
    );

    if (process.platform === "darwin") {
      expect(check).toBeDefined();
      expect(check?.remedy?.deeplink).toContain("Privacy_ScreenCapture");
      return;
    }
    expect(check).toMatchObject({
      status: "skip",
      detail: "host is not macOS",
    });
  });

  it("can include non-blocking external provider discovery", async () => {
    const report = await runComputeDoctor({ providers: true });
    const providerChecks = report.checks.filter(
      (check) => check.transport === "provider",
    );

    expect(providerChecks.map((check) => check.name)).toEqual([
      "external-provider",
      "platform-provider",
      "visual-model",
    ]);
    expect(
      providerChecks.every((check) =>
        ["ok", "warn", "skip"].includes(check.status),
      ),
    ).toBe(true);
    expect(providerChecks.some((check) => check.status === "fail")).toBe(false);
  });

  it("reports the macOS AppKit overlay provider status", async () => {
    const report = await runComputeDoctor();
    const check = report.checks.find(
      (candidate) =>
        candidate.transport === "overlay" && candidate.name === "macos-appkit",
    );

    expect(check).toBeDefined();
    if (process.platform === "darwin") {
      expect(["ok", "fail"]).toContain(check?.status);
      expect(check?.detail).toContain("AppKit overlay");
      return;
    }
    expect(check).toMatchObject({
      status: "skip",
      detail: "host is not macOS",
    });
  });

  it("reports every native system overlay provider with platform-gated status", async () => {
    const report = await runComputeDoctor();
    const overlayChecks = report.checks.filter(
      (candidate) => candidate.transport === "overlay",
    );

    expect(overlayChecks.map((check) => check.name)).toEqual([
      "macos-appkit",
      "windows-win32",
      "linux-gtk",
    ]);
    for (const check of overlayChecks) {
      if (
        (check.name === "macos-appkit" && process.platform === "darwin") ||
        (check.name === "windows-win32" && process.platform === "win32") ||
        (check.name === "linux-gtk" && process.platform === "linux")
      ) {
        expect(["ok", "fail"]).toContain(check.status);
      } else {
        expect(check.status).toBe("skip");
      }
    }
  });
});
