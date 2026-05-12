import { describe, expect, it } from "vitest";
import { mapNpmPackageRow, requireNpmPackageName } from "./package.js";

describe("npm agent-facing package command", () => {
  it("validates npm package names", () => {
    expect(requireNpmPackageName(" @vercel/og ")).toBe("@vercel/og");
    expect(requireNpmPackageName("react")).toBe("react");
    expect(() => requireNpmPackageName("")).toThrow("is required");
    expect(() => requireNpmPackageName("../react")).toThrow("not valid");
  });

  it("maps latest package metadata to agent-facing columns", () => {
    expect(
      mapNpmPackageRow(
        {
          name: "react",
          description: "base description",
          "dist-tags": { latest: "19.0.0" },
          versions: {
            "19.0.0": {
              description: "ui library",
              license: { type: "MIT" },
              homepage: "https://react.dev",
              repository: { url: "git+https://github.com/facebook/react.git" },
              bugs: { url: "https://github.com/facebook/react/issues" },
              keywords: ["ui", "react"],
            },
          },
          maintainers: [{ name: "core" }, { email: "ops@example.test" }],
          time: {
            created: "2011-10-26T00:00:00.000Z",
            modified: "2026-05-01T00:00:00.000Z",
          },
        },
        "react",
      ),
    ).toMatchObject({
      name: "react",
      latestVersion: "19.0.0",
      description: "ui library",
      license: "MIT",
      repository: "https://github.com/facebook/react",
      bugs: "https://github.com/facebook/react/issues",
      maintainers: "core, ops@example.test",
      keywords: "ui, react",
      created: "2011-10-26",
      modified: "2026-05-01",
    });
    expect(() => mapNpmPackageRow({}, "missing")).toThrow(
      "has no latest version",
    );
  });
});
