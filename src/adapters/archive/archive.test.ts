import { describe, expect, it } from "vitest";
import {
  mapArchiveItem,
  mapArchiveSearchRows,
  mapArchiveSnapshotRows,
  mapArchiveWaybackRow,
  normalizeArchiveTimestamp,
  requireArchiveIdentifier,
  requireArchiveLimit,
} from "./archive.js";

describe("archive structured adapters", () => {
  it("validates identifiers, limits, and timestamps before acquisition", () => {
    expect(requireArchiveIdentifier("open-syllabus_2.0")).toBe(
      "open-syllabus_2.0",
    );
    expect(() => requireArchiveIdentifier("../private")).toThrow("identifier");
    expect(requireArchiveLimit(undefined, 20, 100, "limit")).toBe(20);
    expect(() => requireArchiveLimit(101, 20, 100, "limit")).toThrow(
      "[1, 100]",
    );
    expect(normalizeArchiveTimestamp("2026-07-31T04:30:00Z")).toBe(
      "20260731043000",
    );
    expect(() => normalizeArchiveTimestamp("20260")).toThrow("timestamp");
  });

  it("maps item metadata without weakening its stable identity", () => {
    expect(
      mapArchiveItem("sample-item", {
        metadata: {
          identifier: "sample-item",
          title: "Sample",
          creator: ["Alice", "Bob"],
          date: "2026-07-31T00:00:00Z",
          mediatype: "texts",
          collection: ["opensource"],
          description: ["First.", "Second."],
        },
        files: [{ name: "book.pdf" }, { name: "book.txt" }],
      }),
    ).toEqual({
      identifier: "sample-item",
      title: "Sample",
      creator: "Alice, Bob",
      date: "2026-07-31",
      mediatype: "texts",
      collection: "opensource",
      description: "First. Second.",
      file_count: 2,
      url: "https://archive.org/details/sample-item",
    });

    expect(() =>
      mapArchiveItem("requested", {
        metadata: { identifier: "different" },
        files: [],
      }),
    ).toThrow("unexpected identifier");
  });

  it("maps bounded search rows and rejects missing stable identifiers", () => {
    expect(
      mapArchiveSearchRows(
        {
          response: {
            docs: [
              {
                identifier: "item-1",
                title: "One",
                creator: ["Alice", "Bob"],
                date: "2025-01-02T00:00:00Z",
                mediatype: "texts",
                downloads: 42,
              },
              { identifier: "item-2", downloads: 2 },
            ],
          },
        },
        1,
      ),
    ).toEqual([
      {
        rank: 1,
        identifier: "item-1",
        title: "One",
        creator: "Alice, Bob",
        date: "2025-01-02",
        mediatype: "texts",
        downloads: 42,
        url: "https://archive.org/details/item-1",
      },
    ]);
    expect(() => mapArchiveSearchRows({ response: { docs: [{}] } }, 1)).toThrow(
      "stable identifier",
    );
  });

  it("decodes CDX columns by header rather than fixed position", () => {
    expect(
      mapArchiveSnapshotRows(
        [
          ["statuscode", "original", "mimetype", "timestamp"],
          ["200", "https://example.com", "text/html", "20260102030405"],
        ],
        10,
      ),
    ).toEqual([
      {
        timestamp: "20260102030405",
        snapshot_url:
          "https://web.archive.org/web/20260102030405/https://example.com",
        status: "200",
        mimetype: "text/html",
        original_url: "https://example.com",
      },
    ]);
    expect(() =>
      mapArchiveSnapshotRows(
        [
          ["timestamp", "original", "mimetype"],
          ["x", "y", "z"],
        ],
        1,
      ),
    ).toThrow("statuscode");
  });

  it("maps only available, fully identified Wayback snapshots", () => {
    expect(
      mapArchiveWaybackRow(
        {
          url: "example.com",
          archived_snapshots: {
            closest: {
              available: true,
              timestamp: "20260102030405",
              url: "https://web.archive.org/web/20260102030405/example.com",
              status: "200",
            },
          },
        },
        "example.com",
        "2026",
      ),
    ).toEqual({
      original_url: "example.com",
      requested_timestamp: "2026",
      snapshot_timestamp: "20260102030405",
      snapshot_url: "https://web.archive.org/web/20260102030405/example.com",
      status: "200",
    });
    expect(() =>
      mapArchiveWaybackRow(
        { archived_snapshots: { closest: { available: false } } },
        "example.com",
        "",
      ),
    ).toThrow("No Wayback snapshot");
  });
});
