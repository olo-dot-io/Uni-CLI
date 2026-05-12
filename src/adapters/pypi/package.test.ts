import { describe, expect, it } from "vitest";
import {
  mapOverallDownloadRows,
  mapPyPiPackageRow,
  mapRecentDownloadRows,
  requirePyPiDownloadsPeriod,
  requirePyPiPackageName,
} from "./package.js";

describe("pypi agent-facing package commands", () => {
  it("validates package names and download periods", () => {
    expect(requirePyPiPackageName(" requests ")).toBe("requests");
    expect(requirePyPiPackageName("zope.interface")).toBe("zope.interface");
    expect(() => requirePyPiPackageName("")).toThrow(
      "pypi package name is required",
    );
    expect(() => requirePyPiPackageName("-bad")).toThrow(
      "not a valid distribution name",
    );
    expect(requirePyPiDownloadsPeriod(undefined)).toBe("recent");
    expect(requirePyPiDownloadsPeriod("OVERALL")).toBe("overall");
    expect(() => requirePyPiDownloadsPeriod("daily")).toThrow(
      "period must be recent or overall",
    );
  });

  it("maps PyPI package metadata without sentinel rows", () => {
    expect(
      mapPyPiPackageRow(
        {
          info: {
            name: "requests",
            version: "2.0.0",
            summary: "HTTP",
            author_email: "dev@example.com",
            license_expression: "Apache-2.0",
            project_urls: {
              Homepage: "https://requests.readthedocs.io",
              Source: "https://github.com/psf/requests",
            },
            requires_python: ">=3.8",
            keywords: "http",
          },
          releases: {
            "1.0.0": [{ upload_time: "2020-01-01T00:00:00" }],
            "2.0.0": [{ upload_time: "2026-05-01T00:00:00" }],
          },
        },
        "requests",
      ),
    ).toMatchObject({
      name: "requests",
      latestVersion: "2.0.0",
      author: "dev@example.com",
      license: "Apache-2.0",
      homepage: "https://requests.readthedocs.io",
      repository: "https://github.com/psf/requests",
      releases: 2,
      firstReleased: "2020-01-01",
      lastReleased: "2026-05-01",
      url: "https://pypi.org/project/requests/",
    });
    expect(() => mapPyPiPackageRow({}, "missing")).toThrow(
      'PyPI returned no metadata for "missing"',
    );
  });

  it("maps recent pypistats download rows", () => {
    expect(
      mapRecentDownloadRows(
        {
          package: "requests",
          data: {
            last_day: 1,
            last_week: 7,
            last_month: 30,
          },
        },
        "requests",
      ),
    ).toEqual([
      {
        rank: 1,
        package: "requests",
        period: "last_day",
        date: "",
        downloads: 1,
      },
      {
        rank: 2,
        package: "requests",
        period: "last_week",
        date: "",
        downloads: 7,
      },
      {
        rank: 3,
        package: "requests",
        period: "last_month",
        date: "",
        downloads: 30,
      },
    ]);
    expect(() => mapRecentDownloadRows({ data: {} }, "missing")).toThrow(
      "pypistats has no recent download data",
    );
  });

  it("maps overall pypistats download rows", () => {
    expect(
      mapOverallDownloadRows(
        {
          package: "requests",
          data: [{ date: "2026-05-01", downloads: 12 }],
        },
        "requests",
      ),
    ).toEqual([
      {
        rank: 1,
        package: "requests",
        period: "daily",
        date: "2026-05-01",
        downloads: 12,
      },
    ]);
    expect(() => mapOverallDownloadRows({ data: [] }, "missing")).toThrow(
      "pypistats has no overall download history",
    );
  });
});
