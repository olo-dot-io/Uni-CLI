import { describe, expect, it } from "vitest";
import {
  mapDockerHubImageRow,
  mapDockerHubSearchRows,
  parseDockerHubImage,
  requireDockerHubLimit,
  requireDockerHubString,
} from "./registry.js";

describe("dockerhub agent-facing registry commands", () => {
  it("validates shared registry args", () => {
    expect(requireDockerHubString(" nginx ", "query")).toBe("nginx");
    expect(() => requireDockerHubString("", "query")).toThrow(
      "query is required",
    );
    expect(requireDockerHubLimit(undefined, 25)).toBe(25);
    expect(requireDockerHubLimit("4", 25)).toBe(4);
    expect(() => requireDockerHubLimit("0", 25)).toThrow(
      "limit must be an integer",
    );
    expect(() => requireDockerHubLimit("101", 25)).toThrow(
      "limit must be an integer",
    );
  });

  it("parses official and namespaced image names", () => {
    expect(parseDockerHubImage("nginx")).toEqual({
      owner: "library",
      name: "nginx",
    });
    expect(parseDockerHubImage("bitnami/redis")).toEqual({
      owner: "bitnami",
      name: "redis",
    });
    expect(() => parseDockerHubImage("too/many/parts")).toThrow(
      "image must be a Docker Hub image name",
    );
  });

  it("maps Docker Hub search rows to agent-facing columns", () => {
    expect(
      mapDockerHubSearchRows(
        [
          {
            repo_name: "nginx",
            is_official: true,
            star_count: 10,
            pull_count: 100,
            short_description: "web server",
          },
        ],
        25,
      ),
    ).toEqual([
      {
        rank: 1,
        image: "library/nginx",
        official: true,
        stars: 10,
        pulls: 100,
        description: "web server",
        url: "https://hub.docker.com/r/library/nginx",
      },
    ]);
  });

  it("maps Docker Hub image detail rows", () => {
    expect(
      mapDockerHubImageRow(
        {
          namespace: "bitnami",
          name: "redis",
          star_count: 7,
          pull_count: 70,
          description: "Redis image",
          last_updated: "2026-05-01T12:00:00.123Z",
          last_modified: "2026-05-02T12:00:00Z",
          date_registered: "2020-01-01T00:00:00Z",
          status_description: "active",
        },
        "library",
        "redis",
      ),
    ).toEqual({
      image: "bitnami/redis",
      official: false,
      stars: 7,
      pulls: 70,
      description: "Redis image",
      lastUpdated: "2026-05-01T12:00:00Z",
      lastModified: "2026-05-02T12:00:00Z",
      registered: "2020-01-01T00:00:00Z",
      status: "active",
      url: "https://hub.docker.com/r/bitnami/redis",
    });
  });
});
