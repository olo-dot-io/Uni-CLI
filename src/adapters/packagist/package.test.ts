import { describe, expect, it } from "vitest";
import {
  mapPackagistPackageRow,
  pickStableVersion,
  requirePackagistName,
} from "./package.js";

describe("packagist agent-facing package command", () => {
  it("validates package names and picks stable versions", () => {
    expect(requirePackagistName(" Symfony/Console ")).toBe("symfony/console");
    expect(() => requirePackagistName("symfony")).toThrow(
      'must be "<vendor>/<package>"',
    );
    expect(
      pickStableVersion({
        "dev-main": {},
        "2.0.0-RC1": {},
        "1.9.0": {},
      }),
    ).toBe("1.9.0");
  });

  it("maps package metadata and download counters", () => {
    expect(
      mapPackagistPackageRow(
        {
          package: {
            name: "symfony/console",
            description: "Console tools",
            repository: "https://github.com/symfony/console",
            github_stars: 42,
            favers: 7,
            downloads: { total: 1000, monthly: 100, daily: 10 },
            versions: {
              "1.0.0": {
                time: "2020-01-01T00:00:00+00:00",
                license: ["MIT"],
              },
            },
          },
        },
        "symfony/console",
      ),
    ).toEqual({
      package: "symfony/console",
      version: "1.0.0",
      releasedAt: "2020-01-01",
      license: "MIT",
      description: "Console tools",
      repository: "https://github.com/symfony/console",
      githubStars: 42,
      favers: 7,
      downloads: 1000,
      monthlyDownloads: 100,
      dailyDownloads: 10,
      url: "https://packagist.org/packages/symfony/console",
    });
    expect(() => mapPackagistPackageRow({}, "missing/pkg")).toThrow(
      "returned no package metadata",
    );
  });
});
