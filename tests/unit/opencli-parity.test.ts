import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENCLI_SIGNALS,
  buildOpenCliParityReport,
} from "../../bench/opencli-parity.js";

describe("OpenCLI parity benchmark", () => {
  it("reports zero missing commands against the synced OpenCLI manifest", () => {
    const report = buildOpenCliParityReport({
      repoRoot: process.cwd(),
      generatedAt: "2026-04-26T00:00:00.000Z",
    });

    expect(report.opencli.commands).toBe(628);
    expect(report.coverage.missing_commands).toBe(0);
    expect(report.coverage.command_coverage).toBe(1);
    expect(report.missing.commands).toEqual([]);
  });

  it("turns latest OpenCLI PR and issue signals into measurable coverage", () => {
    const report = buildOpenCliParityReport({
      repoRoot: process.cwd(),
      generatedAt: "2026-04-26T00:00:00.000Z",
      signals: DEFAULT_OPENCLI_SIGNALS,
    });

    const googleScholar = report.signals.find(
      (signal) => signal.id === "opencli-pr-1176",
    );
    const instagram = report.signals.find(
      (signal) => signal.id === "opencli-issue-1192",
    );
    const doubao = report.signals.find(
      (signal) => signal.id === "opencli-issue-1189",
    );
    const pluginDaemonDocs = report.signals.find(
      (signal) => signal.id === "opencli-pr-1193",
    );
    const customDaemonPorts = report.signals.find(
      (signal) => signal.id === "opencli-pr-1187",
    );
    const debuggerDetachRetry = report.signals.find(
      (signal) => signal.id === "opencli-pr-1182",
    );
    const browserUpload = report.signals.find(
      (signal) => signal.id === "opencli-pr-1181",
    );
    const deepseekUpload = report.signals.find(
      (signal) => signal.id === "opencli-issue-1167",
    );

    expect(googleScholar).toMatchObject({
      status: "covered",
      missing_commands: [],
    });
    expect(instagram).toMatchObject({ status: "covered", missing_sites: [] });
    expect(doubao).toMatchObject({ status: "covered", missing_commands: [] });
    expect(pluginDaemonDocs).toMatchObject({
      status: "covered",
      missing_files: [],
      missing_text: [],
    });
    expect(customDaemonPorts).toMatchObject({
      status: "covered",
      missing_text: [],
    });
    expect(debuggerDetachRetry).toMatchObject({
      status: "covered",
      missing_text: [],
    });
    expect(browserUpload).toMatchObject({
      status: "covered",
      missing_commands: [],
      missing_text: [],
    });
    expect(deepseekUpload).toMatchObject({
      status: "covered",
      missing_text: [],
    });
    expect(
      report.signals.filter((signal) => signal.status === "missing"),
    ).toEqual([]);
  });
});
