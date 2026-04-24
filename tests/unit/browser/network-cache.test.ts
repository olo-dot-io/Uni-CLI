import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bodyMatchesNetworkFilter,
  findNetworkCacheEntry,
  loadNetworkCache,
  parseNetworkFilter,
  saveNetworkCache,
  toCachedNetworkEntries,
  truncateNetworkBody,
} from "../../../src/browser/network-cache.js";

describe("browser network cache", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "unicli-network-cache-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("persists keyed entries so detail can be read after a later command", () => {
    const entries = toCachedNetworkEntries([
      {
        url: "https://example.com/api/feed?page=1",
        method: "GET",
        status: 200,
        contentType: "application/json",
        bodySize: 42,
        body: { items: [{ id: "1", title: "First" }] },
      },
    ]);

    saveNetworkCache("browser:default", entries, tmp);
    const loaded = loadNetworkCache("browser:default", { baseDir: tmp });

    expect(loaded.status).toBe("ok");
    expect(findNetworkCacheEntry(loaded.file!, entries[0].key)).toMatchObject({
      url: "https://example.com/api/feed?page=1",
      method: "GET",
      body: { items: [{ id: "1", title: "First" }] },
    });
  });

  it("filters response bodies by nested field names", () => {
    const parsed = parseNetworkFilter("id,title");
    expect(parsed).toEqual({ ok: true, fields: ["id", "title"] });

    expect(
      bodyMatchesNetworkFilter(
        { data: { items: [{ id: "1", title: "First" }] } },
        parsed.ok ? parsed.fields : [],
      ),
    ).toBe(true);
    expect(
      bodyMatchesNetworkFilter({ data: { items: [{ id: "1" }] } }, [
        "id",
        "missing",
      ]),
    ).toBe(false);
  });

  it("truncates detail bodies without mutating cached entries", () => {
    const [entry] = toCachedNetworkEntries([
      {
        url: "https://example.com/api/feed",
        method: "GET",
        status: 200,
        contentType: "application/json",
        bodySize: 20,
        body: "0123456789abcdef",
      },
    ]);

    const truncated = truncateNetworkBody(entry, 6);

    expect(truncated.body).toBe("012345");
    expect(truncated.body_truncated).toBe(true);
    expect(entry.body).toBe("0123456789abcdef");
  });
});
