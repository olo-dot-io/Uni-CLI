/**
 * Unit tests for the CNIPA browser-driven search adapter.
 *
 * We mock the mcp-browser resolver at the engine boundary (third-party-
 * like). The patent-envelope normalizer is an owned module and stays
 * un-mocked — assertions check real PatentRecord shape coming out of
 * assemblePatentRecord.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installMcpResolver,
  type McpResolver,
} from "../../../../src/engine/transport/mcp-browser.js";
import { runCnipaSearch } from "../../../../src/adapters/cnipa/search.js";

afterEach(() => {
  installMcpResolver(undefined);
});

describe("cnipa.search — input validation", () => {
  it("emits PATENT_UNSUPPORTED_QUERY for an empty query", async () => {
    installMcpResolver(undefined);
    const rows = await runCnipaSearch({ query: "" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_UNSUPPORTED_QUERY",
        adapter_path: "src/adapters/cnipa/search.ts",
      }),
    });
  });
});

describe("cnipa.search — transport gap", () => {
  it("emits MCP_BUS_MISSING envelope when no MCP resolver is installed", async () => {
    installMcpResolver(undefined);
    const rows = await runCnipaSearch({ query: "graphene" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_API_DEPRECATED",
        adapter_path: "src/adapters/cnipa/search.ts",
        suggestion: expect.stringContaining("no outbound MCP transport"),
      }),
    });
  });

  it("emits MCP_BUS_MISSING envelope (via no-server reason) when resolver answers no", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async () => false),
      call: vi.fn(),
    };
    installMcpResolver(resolver);
    const rows = await runCnipaSearch({ query: "graphene" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_API_DEPRECATED",
      }),
    });
  });
});

describe("cnipa.search — happy path", () => {
  it("normalizes browser rows into PatentRecord through assemblePatentRecord", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async (server) => server === "bb-browser"),
      call: vi.fn(async (_server, tool) => {
        if (tool === "browser_navigate") {
          return {
            ok: true,
            data: {
              url: "https://pss-system.cponline.cnipa.gov.cn/...",
              title: "search results",
            },
            tab: "a1",
          };
        }
        // browser_eval — return two rows
        return {
          ok: true,
          data: {
            rows: [
              {
                publication_number: "CN114123456A",
                application_number: "202310001234",
                title: "An apparatus for widget assembly",
                applicant: "Acme China Co., Ltd",
                publication_date: "2024-06-01",
              },
              {
                publication_number: "CN999000111B",
                title: "Quantum dot foo bar",
                applicant: "Beta R&D",
                publication_date: "2024-07-15",
              },
            ],
            html_marker: "搜索结果：检索到2条记录",
          },
          tab: "a1",
        };
      }),
    };
    installMcpResolver(resolver);
    const rows = await runCnipaSearch({ query: "graphene", limit: 5 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      publication_number: "CN-114123456-A",
      title: "An apparatus for widget assembly",
      source_adapter: "cnipa",
    });
    expect(rows[1]).toMatchObject({
      publication_number: "CN-999000111-B",
      source_adapter: "cnipa",
    });
    // retrieved_at must be an ISO-8601 timestamp from assemblePatentRecord.
    expect(
      Date.parse((rows[0] as { retrieved_at: string }).retrieved_at),
    ).toBeGreaterThan(0);
  });

  it("emits PATENT_BROWSER_CAPTCHA when zero rows return on a non-empty query", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async (server) => server === "bb-browser"),
      call: vi.fn(async (_server, tool) => {
        if (tool === "browser_navigate") {
          return { ok: true, data: {}, tab: "b2" };
        }
        return {
          ok: true,
          data: { rows: [], html_marker: "请输入验证码" },
          tab: "b2",
        };
      }),
    };
    installMcpResolver(resolver);
    const rows = await runCnipaSearch({ query: "graphene" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_BROWSER_CAPTCHA",
        retryable: true,
      }),
    });
  });

  it("rejects rows that are missing publication_number rather than synthesising", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async (server) => server === "bb-browser"),
      call: vi.fn(async (_server, tool) => {
        if (tool === "browser_navigate") {
          return { ok: true, data: {}, tab: "c3" };
        }
        return {
          ok: true,
          data: {
            rows: [{ title: "Some patent without a number" }],
            html_marker: "Results page",
          },
          tab: "c3",
        };
      }),
    };
    installMcpResolver(resolver);
    const rows = await runCnipaSearch({ query: "x" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      envelope: expect.objectContaining({
        code: "PATENT_NOT_FOUND",
      }),
    });
  });
});
