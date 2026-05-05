/**
 * @owner   tests/unit/commands/adapter-authoring.test.ts
 * @does    Verify shared adapter-authoring helpers used by explore, generate, and synthesize commands.
 * @needs   vitest, src/commands/adapter-authoring.ts, src/engine/endpoint-scorer types
 * @feeds   command-helper regression coverage for adapter authoring
 * @breaks  Helper regressions fail focused unit checks before command flows drift.
 */

import { describe, expect, it } from "vitest";
import {
  buildGeneratedAdapterYaml,
  convertToEndpointEntries,
  deriveCommandName,
  detectAuth,
  extractSiteName,
  pickStrategy,
  uniqueName,
} from "../../../src/commands/adapter-authoring.js";
import type { ScoredEndpoint } from "../../../src/engine/endpoint-scorer.js";

describe("adapter authoring command helpers", () => {
  it("normalizes site names from browser URLs", () => {
    expect(extractSiteName("https://www.example.com/path")).toBe("example");
    expect(extractSiteName("not a url")).toBe("unknown");
  });

  it("converts captured requests into endpoint entries", () => {
    const entries = convertToEndpointEntries([
      {
        url: "https://example.com/api/feed",
        data: { items: [{ id: 1 }] },
        method: "POST",
        status: 201,
      },
      {
        url: "https://example.com/api/feed?page=2",
        data: { duplicate: true },
      },
      {
        url: "not a url",
        data: { ignored: true },
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      url: "https://example.com/api/feed",
      method: "POST",
      status: 201,
      contentType: "application/json",
    });
    expect(entries[0].responseBody).toContain("items");
  });

  it("detects auth strategy from cookies", () => {
    const headerAuth = detectAuth({
      csrftoken: "a",
      session_id: "b",
    });
    expect(headerAuth.strategy).toBe("header");
    expect(pickStrategy(headerAuth)).toBe("header");
    expect(headerAuth.cookies).toEqual(["csrftoken", "session_id"]);

    const publicAuth = detectAuth({});
    expect(publicAuth.strategy).toBe("public");
    expect(publicAuth.notes).toContain("No auth detected - public API likely");
  });

  it("derives stable command names and unique suffixes", () => {
    expect(deriveCommandName("https://example.com/api/v1/users/list")).toBe(
      "users-list",
    );
    const used = new Set(["feed", "feed-2"]);
    expect(uniqueName("feed", used)).toBe("feed-3");
  });

  it("builds generated adapter YAML from a scored endpoint", () => {
    const endpoint: ScoredEndpoint = {
      url: "https://example.com/api/feed",
      method: "GET",
      status: 200,
      contentType: "application/json",
      responseBody: JSON.stringify({ data: [{ id: "1", title: "First" }] }),
      size: 42,
      detectedFields: ["id", "title"],
      capability: "feed",
    };

    expect(
      buildGeneratedAdapterYaml("example", "feed", endpoint, "cookie"),
    ).toBe(
      [
        "site: example",
        "name: feed",
        'description: "Auto-generated: feed"',
        "type: web-api",
        "strategy: cookie",
        "pipeline:",
        "  - fetch:",
        '      url: "https://example.com/api/feed"',
        '  - select: "data"',
        "  - map:",
        '      id: "${{ item.id }}"',
        '      title: "${{ item.title }}"',
        '  - limit: "${{ args.limit | default(20) }}"',
        "columns: [id, title]",
        "",
      ].join("\n"),
    );
  });
});
