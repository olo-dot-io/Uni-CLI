import { describe, expect, it } from "vitest";
import {
  collectNugetEntries,
  mapNugetPackageRows,
  requireNugetPackageId,
} from "./package.js";

describe("nuget agent-facing package command", () => {
  it("validates package ids", () => {
    expect(requireNugetPackageId(" Newtonsoft.Json ")).toBe("Newtonsoft.Json");
    expect(() => requireNugetPackageId("../Newtonsoft.Json")).toThrow(
      "package id must be",
    );
  });

  it("collects inline and stub registration pages", async () => {
    await expect(
      collectNugetEntries(
        {
          items: [
            {
              items: [
                {
                  catalogEntry: {
                    id: "Pkg",
                    version: "1.0.0",
                    published: "2020-01-01T00:00:00Z",
                  },
                },
              ],
            },
            { "@id": "https://example.test/page.json" },
          ],
        },
        async () => ({
          items: [
            {
              catalogEntry: {
                id: "Pkg",
                version: "2.0.0",
                published: "2021-01-01T00:00:00Z",
              },
            },
          ],
        }),
      ),
    ).resolves.toHaveLength(2);

    await expect(
      collectNugetEntries({ items: [{}] }, async () => ({})),
    ).rejects.toThrow("missing @id");
  });

  it("maps version history rows sorted by published desc", () => {
    expect(
      mapNugetPackageRows(
        [
          {
            catalogEntry: {
              id: "Newtonsoft.Json",
              version: "1.0.0",
              title: "JSON",
              authors: ["A", "B"],
              tags: ["json", "dotnet"],
              language: "en",
              licenseExpression: "MIT",
              projectUrl: "https://example.test",
              published: "2020-01-01T00:00:00Z",
              listed: true,
            },
          },
          {
            catalogEntry: {
              id: "Newtonsoft.Json",
              version: "2.0.0",
              published: "2021-01-01T00:00:00Z",
            },
          },
        ],
        "Newtonsoft.Json",
      ),
    ).toMatchObject([
      {
        rank: 1,
        id: "Newtonsoft.Json",
        version: "2.0.0",
        published: "2021-01-01T00:00:00Z",
      },
      {
        rank: 2,
        id: "Newtonsoft.Json",
        version: "1.0.0",
        authors: "A, B",
        tags: "json, dotnet",
        listed: true,
      },
    ]);
    expect(() => mapNugetPackageRows([], "missing")).toThrow(
      "No published versions",
    );
  });
});
