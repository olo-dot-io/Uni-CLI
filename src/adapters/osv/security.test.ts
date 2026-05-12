import { describe, expect, it } from "vitest";
import {
  mapOsvQueryRows,
  mapOsvVulnerabilityRow,
  requireOsvEcosystem,
  requireOsvLimit,
  requireOsvString,
  requireOsvVulnerabilityId,
} from "./security.js";

describe("osv agent-facing security commands", () => {
  it("validates OSV query inputs", () => {
    expect(requireOsvString(" lodash ", "package")).toBe("lodash");
    expect(() => requireOsvString("", "package")).toThrow("cannot be empty");
    expect(requireOsvEcosystem("PyPI")).toBe("PyPI");
    expect(() => requireOsvEcosystem("pypi")).toThrow("not recognised");
    expect(requireOsvLimit(undefined)).toBe(30);
    expect(requireOsvLimit("200")).toBe(200);
    expect(() => requireOsvLimit("0")).toThrow("osv limit must be");
    expect(requireOsvVulnerabilityId("GHSA-29mw-wpgm-hmr9")).toBe(
      "GHSA-29mw-wpgm-hmr9",
    );
    expect(() => requireOsvVulnerabilityId("has spaces")).toThrow("not valid");
  });

  it("sorts OSV query rows by published date descending", () => {
    expect(
      mapOsvQueryRows(
        [
          {
            id: "GHSA-old",
            summary: "old",
            published: "2020-01-01T00:00:00Z",
            affected: [{ package: { ecosystem: "PyPI", name: "django" } }],
          },
          {
            id: "GHSA-new",
            summary: "new",
            published: "2026-01-01T00:00:00Z",
            affected: [{ package: { ecosystem: "PyPI", name: "django" } }],
          },
        ],
        10,
      ),
    ).toMatchObject([
      {
        rank: 1,
        id: "GHSA-new",
        published: "2026-01-01T00:00:00Z",
        affectedPackages: "PyPI:django",
      },
      {
        rank: 2,
        id: "GHSA-old",
      },
    ]);
  });

  it("maps OSV vulnerability details without sentinel rows", () => {
    expect(
      mapOsvVulnerabilityRow({
        id: "GHSA-29mw-wpgm-hmr9",
        summary: "ReDoS in lodash",
        aliases: ["CVE-2020-28500"],
        published: "2022-01-06T20:30:46Z",
        modified: "2025-09-29T21:12:31.102523Z",
        database_specific: {
          severity: "MODERATE",
          cwe_ids: ["CWE-1333", "CWE-400"],
        },
        affected: [
          { package: { name: "lodash", ecosystem: "npm" } },
          { package: { name: "lodash-rails", ecosystem: "RubyGems" } },
        ],
        references: [{ url: "https://example.test" }],
      }),
    ).toMatchObject({
      id: "GHSA-29mw-wpgm-hmr9",
      severity: "MODERATE",
      aliases: "CVE-2020-28500",
      modified: "2025-09-29T21:12:31Z",
      affectedPackages: "npm:lodash, RubyGems:lodash-rails",
      cwes: "CWE-1333, CWE-400",
      referenceCount: 1,
      url: "https://osv.dev/vulnerability/GHSA-29mw-wpgm-hmr9",
    });
    expect(() => mapOsvVulnerabilityRow({})).toThrow(
      "OSV.dev returned no vulnerability record",
    );
  });
});
