/**
 * Unit tests for the mcp-browser transport — interface contract only.
 *
 * The transport's job is to dispatch a tool call to whichever MCP server
 * (bb-browser preferred, claude-in-chrome fallback) is reachable in the
 * current Claude Code session. We mock the McpResolver because it is a
 * third-party-like boundary (the actual MCP plumbing lives outside the
 * engine). Owned modules (assemblePatentRecord, buildPatentEnvelope) are
 * NEVER mocked here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TransportError,
  initMcpBrowserTransport,
  installMcpResolver,
  mcpBrowserEvaluate,
  mcpBrowserNavigate,
  mcpBrowserSnapshot,
  type McpResolver,
} from "../../../../src/engine/transport/mcp-browser.js";

afterEach(() => {
  installMcpResolver(undefined);
});

describe("initMcpBrowserTransport", () => {
  it("reports active_server='none' with reason='bus-missing' when no resolver installed", async () => {
    installMcpResolver(undefined);
    const result = await initMcpBrowserTransport();
    expect(result).toEqual({ active_server: "none", reason: "bus-missing" });
  });

  it("prefers bb-browser when both servers are available", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async () => true),
      call: vi.fn(async () => ({ ok: true, data: {} })),
    };
    installMcpResolver(resolver);
    const result = await initMcpBrowserTransport();
    expect(result.active_server).toBe("bb-browser");
    // Only the preferred server is probed when it answers true.
    expect(resolver.isAvailable).toHaveBeenCalledWith("bb-browser");
    expect(resolver.isAvailable).toHaveBeenCalledTimes(1);
  });

  it("falls back to claude-in-chrome when bb-browser is unreachable", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async (server) => server === "claude-in-chrome"),
      call: vi.fn(async () => ({ ok: true, data: {} })),
    };
    installMcpResolver(resolver);
    const result = await initMcpBrowserTransport();
    expect(result.active_server).toBe("claude-in-chrome");
    expect(resolver.isAvailable).toHaveBeenCalledWith("bb-browser");
    expect(resolver.isAvailable).toHaveBeenCalledWith("claude-in-chrome");
  });

  it("reports active_server='none' with reason='no-server' when neither server answers", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async () => false),
      call: vi.fn(async () => ({ ok: true, data: {} })),
    };
    installMcpResolver(resolver);
    const result = await initMcpBrowserTransport();
    expect(result).toEqual({ active_server: "none", reason: "no-server" });
  });

  it("treats a probe that throws as 'unavailable' without surfacing", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async () => {
        throw new Error("probe blew up");
      }),
      call: vi.fn(async () => ({ ok: true, data: {} })),
    };
    installMcpResolver(resolver);
    const result = await initMcpBrowserTransport();
    expect(result.active_server).toBe("none");
    expect(result.reason).toBe("no-server");
  });
});

describe("dispatch surface (navigate/evaluate/snapshot)", () => {
  it("throws TransportError(code='MCP_BUS_MISSING') when no resolver installed", async () => {
    installMcpResolver(undefined);
    await expect(
      mcpBrowserNavigate({ url: "https://example.com" }),
    ).rejects.toMatchObject({
      name: "TransportError",
      code: "MCP_BUS_MISSING",
    });
    await expect(
      mcpBrowserEvaluate({ expression: "1+1" }),
    ).rejects.toMatchObject({
      name: "TransportError",
      code: "MCP_BUS_MISSING",
    });
    await expect(mcpBrowserSnapshot({})).rejects.toMatchObject({
      name: "TransportError",
      code: "MCP_BUS_MISSING",
    });
  });

  it("throws TransportError(code='MCP_NO_SERVER') when resolver exists but no server reachable", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async () => false),
      call: vi.fn(async () => ({ ok: true, data: {} })),
    };
    installMcpResolver(resolver);
    await expect(
      mcpBrowserNavigate({ url: "https://example.com" }),
    ).rejects.toMatchObject({
      name: "TransportError",
      code: "MCP_NO_SERVER",
    });
  });

  it("dispatches to bb-browser tool name on the happy path", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async (server) => server === "bb-browser"),
      call: vi.fn(async () => ({
        ok: true,
        data: { url: "https://example.com", title: "Example" },
      })),
    };
    installMcpResolver(resolver);
    const result = await mcpBrowserNavigate({ url: "https://example.com" });
    expect(result).toEqual({
      ok: true,
      data: { url: "https://example.com", title: "Example" },
    });
    expect(resolver.call).toHaveBeenCalledWith(
      "bb-browser",
      "browser_navigate",
      expect.objectContaining({ url: "https://example.com" }),
    );
  });

  it("dispatches to claude-in-chrome tool name when only that server is up", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async (server) => server === "claude-in-chrome"),
      call: vi.fn(async () => ({ ok: true, data: { foo: 1 } })),
    };
    installMcpResolver(resolver);
    await mcpBrowserEvaluate({ expression: "document.title" });
    expect(resolver.call).toHaveBeenCalledWith(
      "claude-in-chrome",
      "javascript_tool",
      expect.objectContaining({ expression: "document.title" }),
    );
  });

  it("propagates resolver-returned ok:false without re-mapping", async () => {
    const resolver: McpResolver = {
      isAvailable: vi.fn(async (server) => server === "bb-browser"),
      call: vi.fn(async () => ({
        ok: false,
        code: "PATENT_BROWSER_CAPTCHA",
        message: "captcha gate",
      })),
    };
    installMcpResolver(resolver);
    const result = await mcpBrowserNavigate({ url: "https://example.com" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("PATENT_BROWSER_CAPTCHA");
    expect(result.message).toBe("captcha gate");
  });
});

describe("TransportError shape", () => {
  it("is named TransportError and carries the code field", () => {
    const err = new TransportError("MCP_BUS_MISSING", "no bus");
    expect(err.name).toBe("TransportError");
    expect(err.code).toBe("MCP_BUS_MISSING");
    expect(err.message).toBe("no bus");
    expect(err instanceof Error).toBe(true);
  });
});

describe("resolver lifecycle", () => {
  let resolver: McpResolver;
  beforeEach(() => {
    resolver = {
      isAvailable: vi.fn(async () => true),
      call: vi.fn(async () => ({ ok: true })),
    };
  });

  it("uninstalls cleanly when given undefined", async () => {
    installMcpResolver(resolver);
    expect((await initMcpBrowserTransport()).active_server).toBe("bb-browser");
    installMcpResolver(undefined);
    expect((await initMcpBrowserTransport()).active_server).toBe("none");
  });
});
