/**
 * Unit tests for the INPI Brasil browser-driven adapter.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installMcpResolver,
  type McpResolver,
} from "../../../../src/engine/transport/mcp-browser.js";
import { runInpiBrSearch } from "../../../../src/adapters/inpi-br/search.js";

afterEach(() => {
  installMcpResolver(undefined);
});

describe("inpi-br.search", () => {
  it("rejects an empty query", async () => {
    installMcpResolver(undefined);
    const rows = await runInpiBrSearch({ query: "" });
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_UNSUPPORTED_QUERY",
      }),
    });
  });

  it("emits MCP_BUS_MISSING envelope when no resolver", async () => {
    installMcpResolver(undefined);
    const rows = await runInpiBrSearch({ query: "vacina" });
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_API_DEPRECATED",
        suggestion: expect.stringContaining("INPI Brasil has no upstream API"),
      }),
    });
  });

  it("normalises rows and prefixes BR when absent", async () => {
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
                publication_number: "1020230012345A2",
                title: "Algum invento",
                applicant: "Empresa Brasil S.A.",
                publication_date: "2024-08-22",
              },
            ],
          },
          tab: "t",
        };
      }),
    };
    installMcpResolver(resolver);
    const rows = await runInpiBrSearch({ query: "invento" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      publication_number: "BR-1020230012345-A2",
      source_adapter: "inpi-br",
    });
  });
});
