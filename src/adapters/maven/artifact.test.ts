import { describe, expect, it } from "vitest";
import {
  mapMavenArtifactRows,
  parseMavenCoordinate,
  requireMavenLimit,
} from "./artifact.js";

describe("maven agent-facing artifact command", () => {
  it("parses coordinates and validates limits", () => {
    expect(parseMavenCoordinate(" org.example:lib ")).toEqual({
      groupId: "org.example",
      artifactId: "lib",
      version: "",
    });
    expect(parseMavenCoordinate("org.example:lib:1.0.0")).toEqual({
      groupId: "org.example",
      artifactId: "lib",
      version: "1.0.0",
    });
    expect(() => parseMavenCoordinate("org.example")).toThrow(
      "coordinate must be",
    );
    expect(requireMavenLimit(undefined, 20)).toBe(20);
    expect(requireMavenLimit("200", 20)).toBe(200);
    expect(() => requireMavenLimit("201", 20)).toThrow(
      "limit must be an integer",
    );
  });

  it("maps gav rows newest-first shape with published timestamp", () => {
    expect(
      mapMavenArtifactRows(
        {
          response: {
            docs: [
              {
                g: "org.example",
                a: "lib",
                v: "1.2.3",
                p: "jar",
                timestamp: 1770000000000,
                tags: ["testing", "example"],
              },
            ],
          },
        },
        { groupId: "org.example", artifactId: "lib", version: "" },
      ),
    ).toEqual([
      {
        groupId: "org.example",
        artifactId: "lib",
        version: "1.2.3",
        packaging: "jar",
        publishedAt: "2026-02-02T02:40:00.000Z",
        tags: "testing, example",
        url: "https://central.sonatype.com/artifact/org.example/lib/1.2.3",
      },
    ]);
    expect(() =>
      mapMavenArtifactRows(
        { response: { docs: [] } },
        { groupId: "g", artifactId: "a", version: "" },
      ),
    ).toThrow("no published versions");
  });
});
