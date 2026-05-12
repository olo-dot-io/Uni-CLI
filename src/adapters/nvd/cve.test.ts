import { describe, expect, it } from "vitest";
import { mapNvdCveRow, requireCveId } from "./cve.js";

describe("nvd agent-facing CVE command", () => {
  it("validates CVE identifiers", () => {
    expect(requireCveId("cve-2021-44228")).toBe("CVE-2021-44228");
    expect(() => requireCveId("")).toThrow("nvd CVE id is required");
    expect(() => requireCveId("GHSA-xxxx-yyyy-zzzz")).toThrow(
      "not a valid CVE identifier",
    );
  });

  it("maps NVD CVE rows with primary CVSS and CWE fields", () => {
    expect(
      mapNvdCveRow(
        {
          id: "CVE-2021-44228",
          published: "2021-12-10T10:15:00.000",
          lastModified: "2026-01-01T00:00:00.000",
          vulnStatus: "Analyzed",
          descriptions: [
            { lang: "es", value: "Spanish" },
            { lang: "en", value: "Log4Shell" },
          ],
          metrics: {
            cvssMetricV31: [
              {
                type: "Primary",
                cvssData: {
                  baseScore: 10,
                  baseSeverity: "CRITICAL",
                  attackVector: "NETWORK",
                },
              },
            ],
          },
          weaknesses: [
            {
              description: [{ value: "CWE-20" }, { value: "CWE-20" }],
            },
            {
              description: [{ value: "CWE-502" }],
            },
          ],
          cisaExploitAdd: "2021-12-10",
        },
        "CVE-2021-44228",
      ),
    ).toEqual({
      id: "CVE-2021-44228",
      published: "2021-12-10",
      lastModified: "2026-01-01",
      vulnStatus: "Analyzed",
      baseScore: 10,
      severity: "CRITICAL",
      attackVector: "NETWORK",
      cwe: "CWE-20, CWE-502",
      kevAdded: "2021-12-10",
      description: "Log4Shell",
      url: "https://nvd.nist.gov/vuln/detail/CVE-2021-44228",
    });
    expect(() => mapNvdCveRow({}, "CVE-2099-0001")).toThrow(
      'NVD has no record for "CVE-2099-0001"',
    );
  });
});
