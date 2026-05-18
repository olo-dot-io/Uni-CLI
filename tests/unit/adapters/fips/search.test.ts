/**
 * Unit tests for the FIPS (Rospatent) browser-driven adapter.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installMcpResolver,
  type McpResolver,
} from "../../../../src/engine/transport/mcp-browser.js";
import { runFipsSearch } from "../../../../src/adapters/fips/search.js";

afterEach(() => {
  installMcpResolver(undefined);
});

describe("fips.search", () => {
  it("rejects an empty query", async () => {
    installMcpResolver(undefined);
    const rows = await runFipsSearch({ query: "" });
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_UNSUPPORTED_QUERY",
      }),
    });
  });

  it("emits MCP_BUS_MISSING-coded envelope when no resolver installed", async () => {
    installMcpResolver(undefined);
    const rows = await runFipsSearch({ query: "квантовый" });
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_API_DEPRECATED",
        suggestion: expect.stringContaining("no outbound MCP transport"),
      }),
    });
  });

  it("normalises rows and prefixes RU when absent", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async (server) => server === "bb-browser"),
      call: vi.fn(async (_server, tool) => {
        if (tool === "browser_navigate")
          return { ok: true, data: {}, tab: "t" };
        return {
          ok: true,
          data: {
            rows: [
              {
                publication_number: "2789000C1",
                title: "Quantum widget",
                applicant: "Skoltech",
                publication_date: "2024-04-22",
              },
            ],
          },
          tab: "t",
        };
      }),
    };
    installMcpResolver(resolver);
    const rows = await runFipsSearch({ query: "quantum" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      publication_number: "RU-2789000-C1",
      source_adapter: "fips",
    });
  });
});
