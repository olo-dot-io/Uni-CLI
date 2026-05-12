import { describe, expect, it } from "vitest";
import { mapRubyGemRow, requireGemName } from "./gem.js";

describe("rubygems agent-facing gem command", () => {
  it("validates gem tokens", () => {
    expect(requireGemName(" rails ")).toBe("rails");
    expect(() => requireGemName("../rails")).toThrow("gem name must be");
  });

  it("maps gem metadata with source and bug tracker fallbacks", () => {
    expect(
      mapRubyGemRow(
        {
          name: "rails",
          version: "8.0.0",
          version_created_at: "2026-05-01T00:00:00.000Z",
          downloads: 1000,
          version_downloads: 100,
          licenses: ["MIT"],
          authors: "DHH",
          homepage_uri: "https://rubyonrails.org",
          metadata: {
            source_code_uri: "https://github.com/rails/rails",
            bug_tracker_uri: "https://github.com/rails/rails/issues",
          },
          info: "Rails is a framework",
          project_uri: "https://rubygems.org/gems/rails",
        },
        "rails",
      ),
    ).toMatchObject({
      gem: "rails",
      version: "8.0.0",
      releasedAt: "2026-05-01",
      downloads: 1000,
      versionDownloads: 100,
      license: "MIT",
      authors: "DHH",
      source: "https://github.com/rails/rails",
      bugs: "https://github.com/rails/rails/issues",
    });
  });
});
