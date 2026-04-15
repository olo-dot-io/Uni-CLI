/**
 * HttpTransport adapter tests.
 *
 * HttpTransport wraps Node's native `fetch` behind the TransportAdapter
 * interface. It is the transport for the `fetch`, `fetch_text`,
 * `parse_rss`, `html_to_md`, and `download` (via HTTP) pipeline steps.
 *
 * Contract:
 *  - action() never throws — all failures return an `err()` envelope
 *  - capability.steps lists exactly the steps this transport can execute
 *  - snapshot() returns the last response as JSON
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HttpTransport } from "../../../../src/transport/adapters/http.js";
import { createTransportBus } from "../../../../src/transport/bus.js";
import type { TransportContext } from "../../../../src/transport/types.js";

function makeCtx(): TransportContext {
  return {
    vars: {},
    bus: createTransportBus(),
  };
}

describe("HttpTransport", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("declares kind = http", () => {
    const t = new HttpTransport();
    expect(t.kind).toBe("http");
  });

  it("declares capability.steps including fetch, fetch_text, parse_rss, html_to_md, download", () => {
    const t = new HttpTransport();
    expect(t.capability.steps).toEqual(
      expect.arrayContaining([
        "fetch",
        "fetch_text",
        "parse_rss",
        "html_to_md",
        "download",
      ]),
    );
    expect(t.capability.mutatesHost).toBe(false);
    expect(t.capability.snapshotFormats).toEqual(
      expect.arrayContaining(["json", "text"]),
    );
  });

  it("returns ok envelope for successful fetch", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ hello: "world" }),
      text: async () => '{"hello":"world"}',
      headers: new Map([["content-type", "application/json"]]),
    }) as unknown as typeof fetch;

    const t = new HttpTransport();
    await t.open(makeCtx());
    const res = await t.action<{ hello: string }>({
      kind: "fetch",
      params: { url: "https://example.com" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ hello: "world" });
    }
  });

  it("returns err envelope for HTTP 404 (non-retryable)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "not found",
    }) as unknown as typeof fetch;

    const t = new HttpTransport();
    await t.open(makeCtx());
    const res = await t.action({
      kind: "fetch",
      params: { url: "https://example.com/missing" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.transport).toBe("http");
      expect(res.error.action).toBe("fetch");
      expect(res.error.reason).toMatch(/404/);
      expect(res.error.retryable).toBe(false);
    }
  });

  it("returns err envelope when url param missing (usage error)", async () => {
    const t = new HttpTransport();
    await t.open(makeCtx());
    const res = await t.action({ kind: "fetch", params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.reason).toMatch(/url/i);
      expect(res.error.exit_code).toBe(2); // USAGE_ERROR
    }
  });

  it("never throws on network error — returns err envelope", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    const t = new HttpTransport();
    await t.open(makeCtx());
    const res = await t.action({
      kind: "fetch",
      params: { url: "https://example.com" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.reason).toMatch(/ECONNREFUSED/);
      expect(res.error.retryable).toBe(true);
    }
  });

  it("fetch_text returns raw text body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "<rss>ok</rss>",
    }) as unknown as typeof fetch;

    const t = new HttpTransport();
    await t.open(makeCtx());
    const res = await t.action<string>({
      kind: "fetch_text",
      params: { url: "https://feed.example/rss" },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toBe("<rss>ok</rss>");
    }
  });

  it("unknown action returns err envelope", async () => {
    const t = new HttpTransport();
    await t.open(makeCtx());
    const res = await t.action({ kind: "not_a_step", params: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.reason).toMatch(/unsupported/i);
    }
  });

  it("snapshot returns last response envelope as json", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ hello: "world" }),
      text: async () => '{"hello":"world"}',
      headers: new Map(),
    }) as unknown as typeof fetch;

    const t = new HttpTransport();
    await t.open(makeCtx());
    await t.action({
      kind: "fetch",
      params: { url: "https://example.com" },
    });
    const snap = await t.snapshot();
    expect(snap.format).toBe("json");
  });

  it("close is idempotent", async () => {
    const t = new HttpTransport();
    await t.open(makeCtx());
    await t.close();
    await t.close();
  });
});
