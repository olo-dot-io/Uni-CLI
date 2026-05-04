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
        "cua",
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
});
