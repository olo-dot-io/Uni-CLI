import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENCLI_SIGNALS,
  buildOpenCliParityReport,
  evaluateSignalCoverage,
  readUniSurface,
} from "../../bench/opencli-parity.js";

describe("OpenCLI parity benchmark", () => {
  const referenceManifestPath = join(
    process.cwd(),
    "ref",
    "opencli",
    "cli-manifest.json",
  );
  const itWithReference = existsSync(referenceManifestPath) ? it : it.skip;

  itWithReference(
    "reports zero missing commands against the synced OpenCLI manifest",
    () => {
      const report = buildOpenCliParityReport({
        repoRoot: process.cwd(),
        generatedAt: "2026-04-26T00:00:00.000Z",
      });

      expect(report.opencli.commands).toBe(628);
      expect(report.coverage.missing_commands).toBe(0);
      expect(report.coverage.command_coverage).toBe(1);
      expect(report.missing.commands).toEqual([]);
    },
  );

  it("turns latest OpenCLI PR and issue signals into measurable coverage", () => {
    const uni = readUniSurface(process.cwd());
    const signals = evaluateSignalCoverage(
      uni,
      DEFAULT_OPENCLI_SIGNALS,
      process.cwd(),
    );

    const googleScholar = signals.find(
      (signal) => signal.id === "opencli-pr-1176",
    );
    const textJavascriptNetwork = signals.find(
      (signal) => signal.id === "opencli-pr-1195",
    );
    const instagram = signals.find(
      (signal) => signal.id === "opencli-issue-1192",
    );
    const doubao = signals.find((signal) => signal.id === "opencli-issue-1189");
    const pluginDaemonDocs = signals.find(
      (signal) => signal.id === "opencli-pr-1193",
    );
    const customDaemonPorts = signals.find(
      (signal) => signal.id === "opencli-pr-1187",
    );
    const debuggerDetachRetry = signals.find(
      (signal) => signal.id === "opencli-pr-1182",
    );
    const browserUpload = signals.find(
      (signal) => signal.id === "opencli-pr-1181",
    );
    const deepseekUpload = signals.find(
      (signal) => signal.id === "opencli-issue-1167",
    );
    const dashPrefixedPositionals = signals.find(
      (signal) => signal.id === "opencli-issue-1161",
    );

    expect(googleScholar).toMatchObject({
      status: "covered",
      missing_commands: [],
    });
    expect(textJavascriptNetwork).toMatchObject({
      status: "covered",
      missing_text: [],
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
    expect(dashPrefixedPositionals).toMatchObject({
      status: "covered",
      missing_text: [],
    });
    expect(signals.filter((signal) => signal.status === "missing")).toEqual([]);
  });
});
