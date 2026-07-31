import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SURFACE_SIGNALS,
  buildSurfaceCoverageReport,
  buildCommandParityLedger,
  evaluateSignalCoverage,
  readArchivedSurface,
  readReferenceSurface,
  readUniSurface,
} from "../../bench/surface-coverage.js";

describe("surface coverage benchmark", () => {
  const referenceManifestPath = join(
    process.cwd(),
    "ref",
    "agent-control-plane",
    "opencli",
    "cli-manifest.json",
  );
  const referenceCoverageIt = existsSync(referenceManifestPath) ? it : it.skip;

  referenceCoverageIt(
    "classifies every current OpenCLI command without hiding gaps",
    () => {
      const report = buildSurfaceCoverageReport({
        repoRoot: process.cwd(),
        generatedAt: "2026-04-26T00:00:00.000Z",
      });
      const referenceSurface = readReferenceSurface(process.cwd());

      expect(report.reference.commands).toBe(referenceSurface.commands);
      expect(report.reference.commands).toBeGreaterThan(0);
      expect(report.ledger.commands).toHaveLength(referenceSurface.commands);
      expect(report.ledger.unclassified_commands).toEqual([]);
      expect(
        Object.values(report.ledger.summary).reduce(
          (sum, value) => sum + value,
          0,
        ),
      ).toBe(referenceSurface.commands);
      expect(report.coverage.missing_commands).toBe(
        report.ledger.summary.missing,
      );
      expect(report.coverage.command_coverage).toBe(
        report.ledger.functional_command_coverage,
      );
      expect(report.coverage.exact_command_coverage).toBe(
        report.coverage.functional_command_coverage,
      );
      expect(report.coverage.exact_missing_commands).toBe(
        report.coverage.missing_commands,
      );
      expect(report.coverage.exact_site_coverage).toBe(
        report.coverage.functional_site_coverage,
      );
      expect(report.coverage.exact_missing_sites).toBe(
        report.coverage.functional_missing_sites,
      );
      expect(report.reference.source).toBe(referenceManifestPath);
      expect(report.reference.git?.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(
        report.ledger.commands
          .filter((entry) => entry.status === "missing")
          .map((entry) => entry.reference_command)
          .sort(),
      ).toEqual(report.missing.commands);
      expect(report.archived.commands).toContain("ctrip/search");
      expect(
        report.ledger.commands.find(
          (entry) => entry.reference_command === "ctrip/search",
        ),
      ).toMatchObject({
        status: "implemented",
        evidence: [{ kind: "uni-command", command: "ctrip/search" }],
      });
      expect(readArchivedSurface(process.cwd()).command_keys).toContain(
        "ctrip/search",
      );
    },
  );

  it("turns surface release signals into measurable coverage", () => {
    const uni = readUniSurface(process.cwd());
    const signals = evaluateSignalCoverage(
      uni,
      DEFAULT_SURFACE_SIGNALS,
      process.cwd(),
    );

    const googleScholar = signals.find(
      (signal) => signal.id === "surface-pr-1176",
    );
    const textJavascriptNetwork = signals.find(
      (signal) => signal.id === "surface-pr-1195",
    );
    const instagram = signals.find(
      (signal) => signal.id === "surface-issue-1192",
    );
    const doubao = signals.find((signal) => signal.id === "surface-issue-1189");
    const pluginBrowserRuntime = signals.find(
      (signal) => signal.id === "surface-pr-1193",
    );
    const sharedBrokerEndpoint = signals.find(
      (signal) => signal.id === "surface-pr-1187",
    );
    const debuggerDetachRetry = signals.find(
      (signal) => signal.id === "surface-pr-1182",
    );
    const browserUpload = signals.find(
      (signal) => signal.id === "surface-pr-1181",
    );
    const deepseekUpload = signals.find(
      (signal) => signal.id === "surface-issue-1167",
    );
    const dashPrefixedPositionals = signals.find(
      (signal) => signal.id === "surface-issue-1161",
    );
    const redditRecent = signals.find(
      (signal) =>
        signal.id === "surface-v1.7.18-reddit-account-and-thread-actions",
    );
    const rednoteRecent = signals.find(
      (signal) => signal.id === "surface-v1.7.18-rednote-read-surface",
    );
    const researchSources = signals.find(
      (signal) => signal.id === "surface-v1.7.17-research-and-registry-sources",
    );
    const browserRuntime = signals.find(
      (signal) => signal.id === "surface-v1.7.16-browser-agent-runtime",
    );
    const persistentSession = signals.find(
      (signal) =>
        signal.id === "surface-v1.7.15-persistent-browser-session-contract",
    );
    const structuredHelp = signals.find(
      (signal) => signal.id === "surface-v1.7.14-structured-help",
    );
    const typedErrorHardening = signals.find(
      (signal) => signal.id === "surface-v1.7.13-typed-error-hardening",
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
    expect(pluginBrowserRuntime).toMatchObject({
      status: "covered",
      missing_files: [],
      missing_text: [],
    });
    expect(sharedBrokerEndpoint).toMatchObject({
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
    expect(browserRuntime).toMatchObject({
      status: "covered",
      missing_text: [],
    });
    expect(persistentSession).toMatchObject({
      status: "covered",
      missing_text: [],
    });
    expect(structuredHelp).toMatchObject({
      status: "covered",
      missing_commands: [],
    });
    expect(typedErrorHardening).toMatchObject({
      status: "covered",
      missing_text: [],
    });
    expect(redditRecent).toMatchObject({
      status: "covered",
      missing_commands: [],
    });
    expect(rednoteRecent).toMatchObject({
      status: "covered",
      missing_sites: [],
      missing_commands: [],
    });
    expect(researchSources).toMatchObject({
      status: "covered",
      missing_sites: [],
    });
    expect(
      DEFAULT_SURFACE_SIGNALS.filter((signal) => signal.source_version),
    ).toHaveLength(7);
  });

  it("requires rationale for equivalent and strict-superset mappings", () => {
    const reference = {
      source: "reference",
      sites: 1,
      commands: 1,
      site_counts: { github: 1 },
      command_keys: ["github/repo"],
    };
    const uni = {
      source: "uni",
      sites: 1,
      commands: 1,
      site_counts: { github: 1 },
      command_keys: ["github/repository"],
    };
    const archived = {
      source: "archive",
      sites: 0,
      commands: 0,
      site_counts: {},
      command_keys: [],
    };

    expect(() =>
      buildCommandParityLedger(reference, uni, archived, [
        {
          reference_command: "github/repo",
          status: "equivalent",
          uni_command: "github/repository",
          rationale: "",
        },
      ]),
    ).toThrow("command coverage mapping missing rationale");

    expect(
      buildCommandParityLedger(reference, uni, archived, [
        {
          reference_command: "github/repo",
          status: "strict-superset",
          uni_command: "github/repository",
          evidence_files: ["tests/unit/surface-coverage.test.ts"],
          rationale:
            "Uni command returns the stable fields plus owner metadata.",
        },
      ]),
    ).toMatchObject({
      summary: {
        implemented: 0,
        equivalent: 0,
        "strict-superset": 1,
        missing: 0,
      },
      unclassified_commands: [],
      functional_command_coverage: 1,
    });

    expect(() =>
      buildCommandParityLedger(reference, uni, archived, [
        {
          reference_command: "github/repo",
          status: "equivalent",
          uni_command: "github/missing",
          rationale: "A non-existent command cannot establish parity.",
        },
      ]),
    ).toThrow("targets unknown Uni-CLI command");
  });

  referenceCoverageIt(
    "keeps exact and evidence-backed functional coverage distinct",
    () => {
      const commandMappings = JSON.parse(
        readFileSync(
          join(process.cwd(), "bench", "surface-parity-mappings.json"),
          "utf8",
        ),
      );
      const report = buildSurfaceCoverageReport({
        repoRoot: process.cwd(),
        commandMappings,
      });

      expect(report.coverage.functional_command_coverage).toBeGreaterThan(
        report.coverage.exact_command_coverage,
      );
      expect(report.coverage.exact_missing_commands).toBe(
        report.coverage.missing_commands + 4,
      );
      expect(report.coverage.functional_missing_sites).toBe(
        report.coverage.exact_missing_sites - 1,
      );
      expect(report.missing.sites).toContain("semanticscholar");
      expect(report.missing.functional_sites).not.toContain("semanticscholar");
      expect(
        report.ledger.commands.find(
          (entry) =>
            entry.reference_command === "semanticscholar/recommendations",
        ),
      ).toMatchObject({
        status: "strict-superset",
        evidence: expect.arrayContaining([
          expect.objectContaining({
            kind: "mapping",
            command: "semantic-scholar/recommendations",
          }),
        ]),
      });
    },
  );
});
