/**
 * Unit tests for the scholarly artifact adapter contract.
 *
 * These keep URL/page/filename validation local and deterministic. Live PDF
 * download/read behavior is covered by command smoke runs, not networked unit
 * tests.
 */

import { describe, expect, it } from "vitest";

import {
  requireScholarMaxChars,
  requireScholarPageRange,
  requireScholarPdfUrl,
  scholarArtifactFilename,
  truncateScholarText,
} from "../../../src/adapters/scholar-artifacts/pdf.js";
import { resolveCommand } from "../../../src/registry.js";

describe("scholar-artifacts pdf adapter", () => {
  it("registers download and read commands with artifact capabilities", () => {
    expect(
      resolveCommand("scholar-artifacts", "download-pdf")?.command.capabilities,
    ).toEqual(["http.download"]);
    const readCommand = resolveCommand(
      "scholar-artifacts",
      "read-pdf",
    )?.command;
    expect(readCommand?.capabilities).toEqual([
      "http.download",
      "subprocess.exec",
    ]);
    expect(readCommand?.adapterArgs?.map((arg) => arg.name)).toEqual(
      expect.arrayContaining(["first-page", "last-page", "max-chars"]),
    );
  });

  it("accepts only http(s) PDF URLs", () => {
    expect(requireScholarPdfUrl("https://example.org/paper.pdf")).toBe(
      "https://example.org/paper.pdf",
    );
    expect(() => requireScholarPdfUrl("file:///tmp/paper.pdf")).toThrow(
      /must use http or https/,
    );
    expect(() => requireScholarPdfUrl("not a url")).toThrow(/not a valid URL/);
  });

  it("validates page ranges", () => {
    expect(requireScholarPageRange("2", "4")).toEqual({
      firstPage: 2,
      lastPage: 4,
    });
    expect(() => requireScholarPageRange("0", "4")).toThrow(/first-page/);
    expect(() => requireScholarPageRange("5", "4")).toThrow(/last-page/);
  });

  it("validates and applies text extraction caps", () => {
    expect(requireScholarMaxChars(undefined)).toBe(40000);
    expect(requireScholarMaxChars("1000")).toBe(1000);
    expect(() => requireScholarMaxChars("999")).toThrow(/max-chars/);
    expect(truncateScholarText("short", 1000)).toEqual({
      text: "short",
      truncated: false,
      originalChars: 5,
    });
    const truncated = truncateScholarText("x".repeat(1200), 1000);
    expect(truncated.truncated).toBe(true);
    expect(truncated.originalChars).toBe(1200);
    expect(truncated.text).toContain("[truncated at 1000 characters]");
  });

  it("derives stable safe PDF filenames", () => {
    expect(
      scholarArtifactFilename({
        source_adapter: "acl-anthology",
        id: "2024.naacl-long.1",
        title: "A/B: test? paper",
      }),
    ).toBe("acl-anthology-2024.naacl-long.1-A_B__test__paper.pdf");
    expect(scholarArtifactFilename({ filename: "paper" })).toBe("paper.pdf");
  });
});
