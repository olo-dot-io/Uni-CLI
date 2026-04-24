import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendSiteNote,
  mergeFieldMap,
  readSiteMemory,
  recordEndpointDiscoveries,
  siteMemoryPaths,
  writeEndpointMemory,
} from "../../../src/browser/site-memory.js";

describe("site memory", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "unicli-site-memory-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes endpoints under ~/.unicli/sites/<site> compatible paths", () => {
    writeEndpointMemory(
      "example",
      "feed",
      {
        url: "https://example.com/api/feed",
        method: "GET",
        response: { fields: ["id", "title"] },
        notes: "captured from browser analyze",
      },
      { baseDir: tmp, verifiedAt: "2026-04-24" },
    );

    const memory = readSiteMemory("example", { baseDir: tmp });

    expect(memory.endpoints.feed).toMatchObject({
      url: "https://example.com/api/feed",
      verified_at: "2026-04-24",
    });
    expect(siteMemoryPaths("example", tmp).endpoints).toContain(
      ".unicli/sites/example/endpoints.json",
    );
  });

  it("merges field-map entries without overwriting existing meanings", () => {
    mergeFieldMap(
      "example",
      { id: { meaning: "stable id", source: "manual" } },
      { baseDir: tmp, verifiedAt: "2026-04-24" },
    );
    mergeFieldMap(
      "example",
      {
        id: { meaning: "different id", source: "new run" },
        title: { meaning: "title", source: "new run" },
      },
      { baseDir: tmp, verifiedAt: "2026-04-25" },
    );

    const memory = readSiteMemory("example", { baseDir: tmp });

    expect(memory.fieldMap.id.meaning).toBe("stable id");
    expect(memory.fieldMap.title).toMatchObject({
      meaning: "title",
      verified_at: "2026-04-25",
    });
  });

  it("prepends dated notes for future adapter authors", () => {
    appendSiteNote("example", "first note", {
      baseDir: tmp,
      date: "2026-04-24",
      author: "codex",
    });
    appendSiteNote("example", "second note", {
      baseDir: tmp,
      date: "2026-04-25",
      author: "codex",
    });

    const notes = readFileSync(siteMemoryPaths("example", tmp).notes, "utf-8");

    expect(notes.indexOf("2026-04-25")).toBeLessThan(
      notes.indexOf("2026-04-24"),
    );
  });

  it("records discovered endpoints and inferred field-map entries", () => {
    recordEndpointDiscoveries(
      "example",
      [
        {
          url: "https://example.com/api/feed",
          method: "GET",
          status: 200,
          contentType: "application/json",
          responseBody: JSON.stringify({ data: [{ id: "1", title: "First" }] }),
          size: 42,
          detectedFields: ["id", "title"],
          capability: "feed",
        },
      ],
      { baseDir: tmp, verifiedAt: "2026-04-24" },
    );

    const memory = readSiteMemory("example", { baseDir: tmp });

    expect(memory.endpoints.feed).toMatchObject({
      url: "https://example.com/api/feed",
      method: "GET",
      verified_at: "2026-04-24",
    });
    expect(memory.fieldMap.id).toMatchObject({
      meaning: "id",
      source: "discovery",
    });
    expect(memory.notes).toContain("Recorded 1 discovered endpoint");
  });
});
