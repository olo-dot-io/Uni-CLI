/**
 * Unit tests for the Espacenet browser-driven search adapter.
 *
 * Mocks the McpResolver at the transport boundary. Does NOT mock
 * owned modules (assemblePatentRecord stays real so canonicalization
 * is asserted end-to-end).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installMcpResolver,
  type McpResolver,
} from "../../../../src/engine/transport/mcp-browser.js";
import { runEspacenetSearch } from "../../../../src/adapters/espacenet/search.js";

afterEach(() => {
  installMcpResolver(undefined);
});

describe("espacenet.search — input validation", () => {
  it("emits PATENT_UNSUPPORTED_QUERY for an empty query", async () => {
    installMcpResolver(undefined);
    const rows = await runEspacenetSearch({ query: "" });
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_UNSUPPORTED_QUERY",
      }),
    });
  });
});

describe("espacenet.search — transport gap", () => {
  it("emits PATENT_API_DEPRECATED with MCP_BUS_MISSING context when no resolver", async () => {
    installMcpResolver(undefined);
    const rows = await runEspacenetSearch({ query: "graphene" });
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_API_DEPRECATED",
        adapter_path: "src/adapters/espacenet/search.ts",
        suggestion: expect.stringContaining("no outbound MCP transport"),
      }),
    });
  });
});

describe("espacenet.search — happy path", () => {
  it("normalises browser rows into PatentRecord", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async (server) => server === "bb-browser"),
      call: vi.fn(async (_server, tool) => {
        if (tool === "browser_navigate") {
          return { ok: true, data: { url: "..." }, tab: "x" };
        }
        return {
          ok: true,
          data: {
            rows: [
              {
                publication_number: "EP4123456A1",
                title: "Energy harvesting widget",
                applicant: "Acme EU",
                publication_date: "2024-03-10",
                source_url:
                  "https://worldwide.espacenet.com/patent/search/publication/EP4123456A1",
              },
            ],
            html_marker: "Found 1 result",
          },
          tab: "x",
        };
      }),
    };
    installMcpResolver(resolver);
    const rows = await runEspacenetSearch({ query: "energy" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      publication_number: "EP-4123456-A1",
      title: "Energy harvesting widget",
      source_adapter: "espacenet",
    });
  });

  it("emits PATENT_BROWSER_CAPTCHA when zero rows + captcha marker", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async (server) => server === "bb-browser"),
      call: vi.fn(async (_server, tool) => {
        if (tool === "browser_navigate") {
          return { ok: true, data: {}, tab: "y" };
        }
        return {
          ok: true,
          data: { rows: [], html_marker: "Are you a human? Solve the CAPTCHA" },
          tab: "y",
        };
      }),
    };
    installMcpResolver(resolver);
    const rows = await runEspacenetSearch({ query: "energy" });
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_BROWSER_CAPTCHA",
      }),
    });
  });

  it("emits PATENT_NOT_FOUND when zero rows and no captcha marker", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async (server) => server === "bb-browser"),
      call: vi.fn(async (_server, tool) => {
        if (tool === "browser_navigate") {
          return { ok: true, data: {}, tab: "z" };
        }
        return {
          ok: true,
          data: { rows: [], html_marker: "No documents match your query" },
          tab: "z",
        };
      }),
    };
    installMcpResolver(resolver);
    const rows = await runEspacenetSearch({ query: "energy" });
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_NOT_FOUND",
      }),
    });
  });
});
