/**
 * Unit tests for the CIPO Canadian Patents Database browser-driven adapter.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installMcpResolver,
  type McpResolver,
} from "../../../../src/engine/transport/mcp-browser.js";
import { runCipoSearch } from "../../../../src/adapters/cipo/search.js";

afterEach(() => {
  installMcpResolver(undefined);
});

describe("cipo.search", () => {
  it("rejects an empty query", async () => {
    installMcpResolver(undefined);
    const rows = await runCipoSearch({ query: "" });
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_UNSUPPORTED_QUERY",
      }),
    });
  });

  it("surfaces MCP_BUS_MISSING honestly when no resolver", async () => {
    installMcpResolver(undefined);
    const rows = await runCipoSearch({ query: "vaccine" });
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_API_DEPRECATED",
        suggestion: expect.stringContaining("no outbound MCP transport"),
      }),
    });
  });

  it("normalises rows into PatentRecord and prefixes CA when absent", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async (server) => server === "bb-browser"),
      call: vi.fn(async (_server, tool) => {
        if (tool === "browser_navigate") {
          return { ok: true, data: {}, tab: "t" };
        }
        return {
          ok: true,
          data: {
            rows: [
              {
                publication_number: "3001234A1",
                title: "Maple-syrup widget",
                applicant: "Big Maple Inc",
                publication_date: "2024-01-15",
              },
            ],
          },
          tab: "t",
        };
      }),
    };
    installMcpResolver(resolver);
    const rows = await runCipoSearch({ query: "maple" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      publication_number: "CA-3001234-A1",
      source_adapter: "cipo",
    });
  });
});
