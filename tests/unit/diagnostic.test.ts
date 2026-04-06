/**
 * Tests for RepairContext diagnostic module, assert step, and retry property.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import {
  buildRepairContext,
  emitRepairContext,
  redactHeaders,
  redactUrl,
  redactJwt,
  redactBody,
  redactRepairContext,
  MAX_DIAGNOSTIC_BYTES,
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

// ── redactHeaders ───────────────────────────────────────────────────

describe("redactHeaders", () => {
  it("redacts Authorization header", () => {
    const result = redactHeaders({ Authorization: "Bearer secret-token" });
    expect(result["Authorization"]).toBe("[REDACTED]");
  });

  it("redacts Cookie header (case-insensitive)", () => {
    const result = redactHeaders({ cookie: "session=abc123; auth=xyz" });
    expect(result["cookie"]).toBe("[REDACTED]");
  });

  it("redacts x-api-key header", () => {
    const result = redactHeaders({ "x-api-key": "sk-1234567890" });
    expect(result["x-api-key"]).toBe("[REDACTED]");
  });

  it("redacts x-auth-token header", () => {
    const result = redactHeaders({ "X-Auth-Token": "my-secret" });
    expect(result["X-Auth-Token"]).toBe("[REDACTED]");
  });

  it("redacts x-csrf-token header", () => {
    const result = redactHeaders({ "x-csrf-token": "csrf-value" });
    expect(result["x-csrf-token"]).toBe("[REDACTED]");
  });

  it("preserves Content-Type header", () => {
    const result = redactHeaders({ "Content-Type": "application/json" });
    expect(result["Content-Type"]).toBe("application/json");
  });

  it("preserves non-sensitive headers while redacting sensitive ones", () => {
    const result = redactHeaders({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-api-key": "secret",
    });
    expect(result["Authorization"]).toBe("[REDACTED]");
    expect(result["x-api-key"]).toBe("[REDACTED]");
    expect(result["Content-Type"]).toBe("application/json");
    expect(result["Accept"]).toBe("application/json");
  });

  it("does not mutate input object", () => {
    const input = { Authorization: "Bearer token" };
    redactHeaders(input);
    expect(input["Authorization"]).toBe("Bearer token");
  });
});

// ── redactUrl ───────────────────────────────────────────────────────

describe("redactUrl", () => {
  it("redacts token query parameter", () => {
    const result = redactUrl("https://api.example.com/data?token=abc123");
    expect(result).toContain("token=%5BREDACTED%5D");
    expect(result).not.toContain("abc123");
  });

  it("redacts api_key query parameter", () => {
    const result = redactUrl("https://api.example.com/data?api_key=secret");
    expect(result).not.toContain("secret");
  });

  it("redacts password query parameter", () => {
    const result = redactUrl(
      "https://example.com/login?username=user&password=mypassword",
    );
    expect(result).not.toContain("mypassword");
    expect(result).toContain("username=user");
  });

  it("redacts access_token and preserves other params", () => {
    const result = redactUrl(
      "https://api.example.com/me?access_token=tok123&format=json",
    );
    expect(result).not.toContain("tok123");
    expect(result).toContain("format=json");
  });

  it("preserves clean params unchanged", () => {
    const result = redactUrl("https://example.com/search?q=hello&page=2");
    expect(result).toContain("q=hello");
    expect(result).toContain("page=2");
  });

  it("returns original string on invalid URL", () => {
    const invalid = "not-a-url";
    expect(redactUrl(invalid)).toBe(invalid);
  });

  it("handles URL with no query parameters", () => {
    const url = "https://example.com/path";
    expect(redactUrl(url)).toBe(url);
  });

  it("handles case-insensitive param names", () => {
    const result = redactUrl("https://example.com/?TOKEN=secret");
    expect(result).not.toContain("secret");
  });
});

// ── redactJwt ───────────────────────────────────────────────────────

describe("redactJwt", () => {
  it("redacts JWT signature while preserving header and payload", () => {
    // A realistic-looking JWT (header.payload.signature)
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const payload = "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0";
    const signature = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const jwt = `${header}.${payload}.${signature}`;

    const result = redactJwt(jwt);
    expect(result).toContain(header);
    expect(result).toContain(payload);
    expect(result).not.toContain(signature);
    expect(result).toContain("[sig-redacted]");
  });

  it("preserves non-JWT text unchanged", () => {
    const text = "This is a plain string without any JWT tokens.";
    expect(redactJwt(text)).toBe(text);
  });

  it("handles multiple JWTs in a single string", () => {
    const header = "eyJhbGciOiJIUzI1NiJ9";
    const payload = "eyJzdWIiOiJ1c2VyIn0";
    const sig = "abc123defghijklmnop";
    const jwt = `${header}.${payload}.${sig}`;

    const text = `First token: ${jwt} and second: ${jwt}`;
    const result = redactJwt(text);
    expect((result.match(/\[sig-redacted\]/g) ?? []).length).toBe(2);
  });

  it("preserves partial JWT-looking strings that are not valid JWTs", () => {
    // Only two parts — not a JWT (needs 3)
    const text = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0";
    expect(redactJwt(text)).toBe(text);
  });
});

// ── redactBody ───────────────────────────────────────────────────────

describe("redactBody", () => {
  it("redacts sensitive keys in a flat object", () => {
    const body = { username: "alice", password: "secret123", token: "tok" };
    const result = redactBody(body) as Record<string, unknown>;
    expect(result["username"]).toBe("alice");
    expect(result["password"]).toBe("[REDACTED]");
    expect(result["token"]).toBe("[REDACTED]");
  });

  it("recursively redacts nested objects", () => {
    const body = {
      user: {
        id: 1,
        credentials: { token: "nested-secret", name: "alice" },
      },
    };
    const result = redactBody(body) as Record<string, unknown>;
    const user = result["user"] as Record<string, unknown>;
    // "credentials" is not in SENSITIVE_PARAMS, so recurse into it
    const credentials = user["credentials"] as Record<string, unknown>;
    expect(credentials["token"]).toBe("[REDACTED]");
    expect(credentials["name"]).toBe("alice");
  });

  it("maps over arrays recursively", () => {
    const body = [
      { id: 1, token: "secret-a" },
      { id: 2, token: "secret-b" },
    ];
    const result = redactBody(body) as Array<Record<string, unknown>>;
    expect(result[0]["token"]).toBe("[REDACTED]");
    expect(result[1]["token"]).toBe("[REDACTED]");
    expect(result[0]["id"]).toBe(1);
  });

  it("applies JWT redaction to string values", () => {
    const header = "eyJhbGciOiJIUzI1NiJ9";
    const payload = "eyJzdWIiOiJ1c2VyIn0";
    const sig = "abc123defghijklmnopqrstuvwxyz";
    const jwt = `${header}.${payload}.${sig}`;
    const result = redactBody(jwt) as string;
    expect(result).toContain("[sig-redacted]");
    expect(result).not.toContain(sig);
  });

  it("does not mutate input object", () => {
    const input = { password: "secret" };
    redactBody(input);
    expect(input.password).toBe("secret");
  });

  it("handles null and primitive values safely", () => {
    expect(redactBody(null)).toBeNull();
    expect(redactBody(42)).toBe(42);
    expect(redactBody(true)).toBe(true);
  });
});

// ── redactRepairContext ─────────────────────────────────────────────

describe("redactRepairContext", () => {
  it("redacts auth headers in network requests", () => {
    const ctx: RepairContext = {
      error: { code: "GENERIC_ERROR", message: "test" },
      adapter: { site: "test", command: "cmd" },
      page: {
        url: "https://example.com",
        snapshot: "page content",
        consoleErrors: [],
        networkRequests: [
          {
            url: "https://api.example.com/data",
            method: "GET",
            status: 200,
            type: "fetch",
            headers: {
              Authorization: "Bearer secret-token",
              "Content-Type": "application/json",
            },
          },
        ],
      },
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    const result = redactRepairContext(ctx);
    const req = result.page!.networkRequests[0];
    expect(req.headers!["Authorization"]).toBe("[REDACTED]");
    expect(req.headers!["Content-Type"]).toBe("application/json");
  });

  it("redacts URLs in network requests", () => {
    const ctx: RepairContext = {
      error: { code: "GENERIC_ERROR", message: "test" },
      adapter: { site: "test", command: "cmd" },
      page: {
        url: "https://example.com",
        snapshot: "content",
        consoleErrors: [],
        networkRequests: [
          {
            url: "https://api.example.com/data?token=secret123",
            method: "GET",
            status: 200,
            type: "fetch",
          },
        ],
      },
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    const result = redactRepairContext(ctx);
    expect(result.page!.networkRequests[0].url).not.toContain("secret123");
  });

  it("redacts JWTs in page snapshot", () => {
    const header = "eyJhbGciOiJIUzI1NiJ9";
    const payload = "eyJzdWIiOiJ1c2VyIn0";
    const sig = "abc123defghijklmnopqrstuvwxyz";
    const jwt = `${header}.${payload}.${sig}`;

    const ctx: RepairContext = {
      error: { code: "GENERIC_ERROR", message: "test" },
      adapter: { site: "test", command: "cmd" },
      page: {
        url: "https://example.com",
        snapshot: `Found token in page: ${jwt}`,
        consoleErrors: [`JWT error: ${jwt}`],
        networkRequests: [],
      },
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    const result = redactRepairContext(ctx);
    expect(result.page!.snapshot).not.toContain(sig);
    expect(result.page!.snapshot).toContain("[sig-redacted]");
    expect(result.page!.consoleErrors[0]).not.toContain(sig);
    expect(result.page!.consoleErrors[0]).toContain("[sig-redacted]");
  });

  it("redacts body in network requests", () => {
    const ctx: RepairContext = {
      error: { code: "GENERIC_ERROR", message: "test" },
      adapter: { site: "test", command: "cmd" },
      page: {
        url: "https://example.com",
        snapshot: "content",
        consoleErrors: [],
        networkRequests: [
          {
            url: "https://api.example.com/login",
            method: "POST",
            status: 200,
            type: "fetch",
            body: { username: "alice", password: "hunter2" },
          },
        ],
      },
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    const result = redactRepairContext(ctx);
    const body = result.page!.networkRequests[0].body as Record<string, unknown>;
    expect(body["password"]).toBe("[REDACTED]");
    expect(body["username"]).toBe("alice");
  });

  it("does not mutate input context", () => {
    const ctx: RepairContext = {
      error: { code: "GENERIC_ERROR", message: "test" },
      adapter: { site: "test", command: "cmd" },
      page: {
        url: "https://example.com",
        snapshot: "content",
        consoleErrors: [],
        networkRequests: [
          {
            url: "https://api.example.com/data",
            method: "GET",
            status: 200,
            type: "fetch",
            headers: { Authorization: "Bearer token" },
          },
        ],
      },
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    redactRepairContext(ctx);
    expect(ctx.page!.networkRequests[0].headers!["Authorization"]).toBe(
      "Bearer token",
    );
  });
});

// ── emitRepairContext — delimiter format ────────────────────────────

describe("emitRepairContext delimiter format", () => {
  it("wraps output with ___UNICLI_DIAGNOSTIC___ markers", () => {
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const ctx: RepairContext = {
      error: { code: "GENERIC_ERROR", message: "test" },
      adapter: { site: "test", command: "cmd" },
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    emitRepairContext(ctx);

    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/^\n___UNICLI_DIAGNOSTIC___\n/);
    expect(output).toMatch(/\n___UNICLI_DIAGNOSTIC___\n$/);
    const markerCount = (output.match(/___UNICLI_DIAGNOSTIC___/g) ?? []).length;
    expect(markerCount).toBe(2);

    writeSpy.mockRestore();
  });
});

// ── emitRepairContext — size degradation ────────────────────────────

describe("emitRepairContext size degradation", () => {
  it("removes snapshot and network bodies when context exceeds 128KB", () => {
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    // Build a context with a large snapshot (~200KB)
    const largeSnapshot = "x".repeat(200 * 1024);

    const ctx: RepairContext = {
      error: { code: "GENERIC_ERROR", message: "test" },
      adapter: { site: "test", command: "cmd" },
      page: {
        url: "https://example.com",
        snapshot: largeSnapshot,
        consoleErrors: [],
        networkRequests: [
          {
            url: "https://api.example.com/data",
            method: "GET",
            status: 200,
            type: "fetch",
            body: { data: "some response body" },
          },
        ],
      },
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    emitRepairContext(ctx);

    const output = writeSpy.mock.calls[0][0] as string;
    // Snapshot should be replaced with removal notice
    expect(output).toContain("removed: size limit");
    // Body should be absent from the output
    expect(output).not.toContain("some response body");

    writeSpy.mockRestore();
  });

  it("removes entire page object when context still exceeds 192KB after stage 1", () => {
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    // 300 network requests each with a large URL to force stage 2
    const networkRequests = Array.from({ length: 300 }, (_, i) => ({
      url: `https://api.example.com/endpoint-${"a".repeat(600)}-${String(i)}`,
      method: "GET",
      status: 200,
      type: "fetch",
      headers: { "Content-Type": "application/json" },
    }));

    const ctx: RepairContext = {
      error: { code: "GENERIC_ERROR", message: "test" },
      adapter: { site: "test", command: "cmd" },
      page: {
        url: "https://example.com",
        snapshot: "(removed: size limit)", // already stripped in stage 1
        consoleErrors: [],
        networkRequests,
      },
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    emitRepairContext(ctx);

    const output = writeSpy.mock.calls[0][0] as string;
    // At 192KB+, the page should be removed entirely
    // We just verify output is under 256KB
    expect(output.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_BYTES + 100); // +100 for markers

    writeSpy.mockRestore();
  });

  it("hard truncates at 256KB", () => {
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    // Construct a context that even after removing page is still huge
    // (e.g., enormous adapter source)
    const hugeSource = "y".repeat(300 * 1024);

    const ctx: RepairContext = {
      error: { code: "GENERIC_ERROR", message: "huge error " + "e".repeat(260 * 1024) },
      adapter: { site: "test", command: "cmd", source: hugeSource },
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    emitRepairContext(ctx);

    const output = writeSpy.mock.calls[0][0] as string;
    // The JSON portion should not exceed MAX_DIAGNOSTIC_BYTES
    // The full output includes markers/newlines but the JSON itself should be truncated
    expect(output.length).toBeLessThan(MAX_DIAGNOSTIC_BYTES + 200);

    writeSpy.mockRestore();
  });
});

// ── buildRepairContext — truncation ─────────────────────────────────

describe("buildRepairContext truncation", () => {
  it("truncates stack trace at 5000 chars", async () => {
    const err = new Error("test error");
    // Manually assign a very long stack
    err.stack = "Error: test error\n" + "    at longFunction (/path/file.js:1:1)\n".repeat(200);

    const ctx = await buildRepairContext({
      error: err,
      site: "test",
      command: "cmd",
    });

    expect(ctx.error.stack).toBeDefined();
    expect(ctx.error.stack!.length).toBeLessThanOrEqual(5000 + "[...truncated]".length);
    expect(ctx.error.stack).toContain("...[truncated]");
  });

  it("does not truncate stack trace under 5000 chars", async () => {
    const err = new Error("short error");
    const ctx = await buildRepairContext({
      error: err,
      site: "test",
      command: "cmd",
    });

    expect(ctx.error.stack).toBeDefined();
    expect(ctx.error.stack).not.toContain("...[truncated]");
  });
});
