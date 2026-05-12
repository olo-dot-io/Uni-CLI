import { describe, expect, it } from "vitest";
import {
  mapCratesDetailRow,
  mapCratesSearchRows,
  requireRegistryLimit,
  requireRegistryString,
} from "./registry.js";

describe("crates agent-facing registry commands", () => {
  it("validates shared registry args", () => {
    expect(requireRegistryString(" serde ", "query")).toBe("serde");
    expect(() => requireRegistryString("", "query")).toThrow(
      "query is required",
    );
    expect(requireRegistryLimit(undefined, 20)).toBe(20);
    expect(requireRegistryLimit("3", 20)).toBe(3);
    expect(() => requireRegistryLimit("0", 20)).toThrow(
      "limit must be an integer",
    );
    expect(() => requireRegistryLimit("101", 20)).toThrow(
      "limit must be an integer",
    );
  });

  it("maps crates.io search rows to agent-facing columns", () => {
    expect(
      mapCratesSearchRows(
        [
          {
            name: "serde",
            newest_version: "1.0.0",
            description: "Serialize",
            downloads: 10,
            recent_downloads: 2,
            repository: "https://github.com/serde-rs/serde",
            updated_at: "2026-05-01T00:00:00Z",
          },
        ],
        20,
      ),
    ).toEqual([
      {
        rank: 1,
        name: "serde",
        latestVersion: "1.0.0",
        description: "Serialize",
        downloads: 10,
        recentDownloads: 2,
        repository: "https://github.com/serde-rs/serde",
        updated: "2026-05-01",
        url: "https://crates.io/crates/serde",
      },
    ]);
  });

  it("maps crates.io detail rows without sentinel output", () => {
    expect(
      mapCratesDetailRow({
        crate: {
          name: "tokio",
          newest_version: "1.2.3",
          description: "Runtime",
          downloads: 100,
          recent_downloads: 9,
          num_versions: 42,
          homepage: "https://tokio.rs",
          documentation: "https://docs.rs/tokio",
          repository: "https://github.com/tokio-rs/tokio",
          created_at: "2020-01-01T00:00:00Z",
          updated_at: "2026-05-02T00:00:00Z",
        },
        versions: [{ num: "1.2.3", license: "MIT" }],
        keywords: [{ keyword: "async" }],
        categories: [{ category: "asynchronous" }],
      }),
    ).toMatchObject({
      name: "tokio",
      latestVersion: "1.2.3",
      license: "MIT",
      keywords: "async",
      categories: "asynchronous",
      created: "2020-01-01",
      updated: "2026-05-02",
    });
    expect(() => mapCratesDetailRow({})).toThrow(
      "crates.io returned no crate metadata",
    );
  });
});
