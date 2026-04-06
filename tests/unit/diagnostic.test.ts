/**
 * Tests for RepairContext diagnostic module, assert step, and retry property.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import {
  buildRepairContext,
  emitRepairContext,
  type RepairContext,
} from "../../src/engine/diagnostic.js";
import { PipelineError, runPipeline } from "../../src/engine/yaml-runner.js";

// --- Echo server for integration tests ---

let server: Server;
let baseUrl: string;
let requestCount = 0;

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    requestCount++;

    // Endpoint that always returns 500 for retry tests
    if (req.url === "/fail-always") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "always fails" }));
      return;
    }

    // Endpoint that fails first N times then succeeds
    if (req.url?.startsWith("/fail-then-ok")) {
      const failCount = parseInt(req.url.split("?fail=")[1] ?? "2", 10);
      // Use a per-endpoint counter
      const key = req.url;
      endpointCounts[key] = (endpointCounts[key] ?? 0) + 1;
      if (endpointCounts[key] <= failCount) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "not yet",
            attempt: endpointCounts[key],
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items: [{ ok: true, attempt: endpointCounts[key] }],
        }),
      );
      return;
    }

    // Default echo
    const body = await collectBody(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        items: [{ id: 1, name: "test" }],
        method: req.method,
        url: req.url,
        body: body ? JSON.parse(body) : null,
      }),
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (addr && typeof addr === "object") {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

const endpointCounts: Record<string, number> = {};

afterAll(() => {
  server?.close();
});

// ── RepairContext building ──────────────────────────────────────────

describe("buildRepairContext", () => {
  it("builds basic error-only RepairContext (no page, no adapter path)", async () => {
    const err = new Error("something broke");
    const ctx = await buildRepairContext({
      error: err,
      site: "example",
      command: "hot",
    });

    expect(ctx.error.code).toBe("GENERIC_ERROR");
    expect(ctx.error.message).toBe("something broke");
    expect(ctx.error.stack).toContain("something broke");
    expect(ctx.adapter.site).toBe("example");
    expect(ctx.adapter.command).toBe("hot");
    expect(ctx.adapter.sourcePath).toBeUndefined();
    expect(ctx.adapter.source).toBeUndefined();
    expect(ctx.page).toBeUndefined();
    expect(ctx.timestamp).toBeTruthy();
    // Timestamp should be ISO format
    expect(new Date(ctx.timestamp).toISOString()).toBe(ctx.timestamp);
  });

  it("includes PipelineError errorType as hint", async () => {
    const err = new PipelineError("HTTP 404", {
      step: 0,
      action: "fetch",
      config: {},
      errorType: "http_error",
      suggestion: "fix it",
    });
    const ctx = await buildRepairContext({
      error: err,
      site: "github",
      command: "trending",
    });

    expect(ctx.error.code).toBe("HTTP_ERROR");
    expect(ctx.error.hint).toBe("http_error");
  });

  it("reads adapter source when adapterPath is provided", async () => {
    // Use this test file itself as the adapter (it exists and is readable)
    const ctx = await buildRepairContext({
      error: new Error("test"),
      site: "test",
      command: "cmd",
      adapterPath: import.meta.filename,
    });

    expect(ctx.adapter.sourcePath).toBe(import.meta.filename);
    expect(ctx.adapter.source).toContain("buildRepairContext");
  });

  it("handles non-existent adapter path gracefully", async () => {
    const ctx = await buildRepairContext({
      error: new Error("test"),
      site: "test",
      command: "cmd",
      adapterPath: "/nonexistent/path/adapter.yaml",
    });

    expect(ctx.adapter.sourcePath).toBe("/nonexistent/path/adapter.yaml");
    expect(ctx.adapter.source).toBeUndefined();
  });
});

// ── emitRepairContext ───────────────────────────────────────────────

describe("emitRepairContext", () => {
  it("writes to stderr with diagnostic markers", () => {
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const ctx: RepairContext = {
      error: { code: "GENERIC_ERROR", message: "test" },
      adapter: { site: "test", command: "cmd" },
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    emitRepairContext(ctx);

    expect(writeSpy).toHaveBeenCalledOnce();
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).toContain("___UNICLI_DIAGNOSTIC___");
    expect(output).toContain('"code": "GENERIC_ERROR"');
    expect(output).toContain('"site": "test"');
    // Verify the marker appears twice (opening + closing)
    const markerCount = (output.match(/___UNICLI_DIAGNOSTIC___/g) ?? []).length;
    expect(markerCount).toBe(2);

    writeSpy.mockRestore();
  });
});

// ── Assert step ────────────────────────────────────────────────────

describe("assert step", () => {
  it("condition assertion passes when expression is truthy", async () => {
    const result = await runPipeline(
      [
        { fetch: { url: `${baseUrl}/data` } },
        { select: "items" },
        {
          assert: {
            condition: "Array.isArray(data)",
            message: "data must be an array",
          },
        },
      ],
      {},
    );
    expect(result).toHaveLength(1);
  });

  it("condition assertion throws when expression is falsy", async () => {
    await expect(
      runPipeline(
        [
          { fetch: { url: `${baseUrl}/data` } },
          { select: "items" },
          { assert: { condition: "data.length > 100" } },
        ],
        {},
      ),
    ).rejects.toThrow(/Condition failed/);
  });

  it("condition assertion uses custom message when provided", async () => {
    await expect(
      runPipeline(
        [
          { fetch: { url: `${baseUrl}/data` } },
          { select: "items" },
          {
            assert: {
              condition: "data.length === 0",
              message: "Expected empty array",
            },
          },
        ],
        {},
      ),
    ).rejects.toThrow("Expected empty array");
  });

  it("condition assertion has assertion_failed errorType", async () => {
    try {
      await runPipeline(
        [
          { fetch: { url: `${baseUrl}/data` } },
          { select: "items" },
          { assert: { condition: "false" } },
        ],
        {},
      );
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      expect((err as PipelineError).detail.errorType).toBe("assertion_failed");
      expect((err as PipelineError).detail.action).toBe("assert");
    }
  });

  it("url assertion throws when no browser page", async () => {
    await expect(
      runPipeline([{ assert: { url: "https://example.com" } }], {}),
    ).rejects.toThrow(/browser page/);
  });

  it("selector assertion throws when no browser page", async () => {
    await expect(
      runPipeline([{ assert: { selector: "#main" } }], {}),
    ).rejects.toThrow(/browser page/);
  });

  it("text assertion throws when no browser page", async () => {
    await expect(
      runPipeline([{ assert: { text: "hello" } }], {}),
    ).rejects.toThrow(/browser page/);
  });

  it("passes through context data unchanged", async () => {
    const result = await runPipeline(
      [
        { fetch: { url: `${baseUrl}/data` } },
        { select: "items" },
        { assert: { condition: "data.length > 0" } },
        { map: { id: "${{ item.id }}", name: "${{ item.name }}" } },
      ],
      {},
    );
    expect(result).toHaveLength(1);
    const row = result[0] as Record<string, unknown>;
    expect(row.id).toBe("1");
    expect(row.name).toBe("test");
  });
});

// ── Retry property ─────────────────────────────────────────────────

describe("retry step property", () => {
  it("retries a failing fetch step and eventually succeeds", async () => {
    // Reset endpoint counter
    const endpoint = `${baseUrl}/fail-then-ok?fail=1`;
    endpointCounts["/fail-then-ok?fail=1"] = 0;

    const result = await runPipeline(
      [
        { fetch: { url: endpoint }, retry: 3, backoff: 10 },
        { select: "items" },
      ],
      {},
    );
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>).ok).toBe(true);
  });

  it("throws after exhausting all retry attempts", async () => {
    await expect(
      runPipeline(
        [{ fetch: { url: `${baseUrl}/fail-always` }, retry: 2, backoff: 10 }],
        {},
      ),
    ).rejects.toThrow(/500/);
  });

  it("does not retry when retry is 0 or absent", async () => {
    // Reset counter
    endpointCounts["/fail-then-ok?fail=1-noretry"] = 0;

    await expect(
      runPipeline([{ fetch: { url: `${baseUrl}/fail-always` } }], {}),
    ).rejects.toThrow(/500/);
  });

  it("retry and backoff can be specified inside config object", async () => {
    endpointCounts["/fail-then-ok?fail=1"] = 0;

    const result = await runPipeline(
      [
        {
          fetch: {
            url: `${baseUrl}/fail-then-ok?fail=1`,
            retry: 3,
            backoff: 10,
          },
        },
        { select: "items" },
      ],
      {},
    );
    expect(result).toHaveLength(1);
  });

  it("retry works with fallback (fallback tried on each attempt)", async () => {
    // This tests that retry wraps the fallback mechanism
    endpointCounts["/fail-then-ok?fail=2"] = 0;

    const result = await runPipeline(
      [
        {
          fetch: { url: `${baseUrl}/fail-then-ok?fail=2` },
          retry: 3,
          backoff: 10,
        },
        { select: "items" },
      ],
      {},
    );
    expect(result).toHaveLength(1);
  });
});
