/**
 * HttpTransport adapter tests.
 *
 * HttpTransport wraps Node's native `fetch` behind the TransportAdapter
 * interface. It is the transport for the `fetch`, `fetch_text`,
 * `parse_rss`, `html_to_md`, and `download` (via HTTP) pipeline steps.
 *
 * Contract:
 *  - ordinary failures return an `err()` envelope; cancellation throws its exact reason
 *  - capability.steps lists exactly the steps this transport can execute
 *  - snapshot() returns the last response as JSON
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(t.capability.mutatesHost).toBe(true);
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
    expect(res.effect_verdict).toMatchObject({
      status: "not_applicable",
      evidence: "declared_read",
    });
  });

  it("confirms an authoritative HTTP 201 mutation response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      statusText: "Created",
      json: async () => ({ id: "created-1" }),
      headers: new Map(),
    }) as unknown as typeof fetch;

    const t = new HttpTransport();
    await t.open(makeCtx());
    const res = await t.action({
      kind: "fetch",
      params: {
        url: "https://example.com/resources",
        method: "POST",
        body: { name: "created" },
      },
    });

    expect(res.effect_verdict).toMatchObject({
      status: "confirmed",
      evidence: "authoritative_response",
      verification: "protocol-result",
    });
  });

  it("keeps a generic HTTP 200 mutation response unverifiable", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ accepted: true }),
      headers: new Map(),
    }) as unknown as typeof fetch;

    const t = new HttpTransport();
    await t.open(makeCtx());
    const res = await t.action({
      kind: "fetch",
      params: {
        url: "https://example.com/resources/1",
        method: "PATCH",
        body: { name: "changed" },
      },
    });

    expect(res.effect_verdict).toMatchObject({
      status: "unverifiable",
      evidence: "dispatch_receipt",
    });
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

  it("marks cancellation after an unsafe HTTP request is accepted outcome-ambiguous", async () => {
    const previousAllowLocal = process.env.UNICLI_ALLOW_LOCAL;
    process.env.UNICLI_ALLOW_LOCAL = "1";
    let requestAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => {
      requestAccepted = resolve;
    });
    const server = createServer((_request, response) => {
      requestAccepted();
      const timer = setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"committed":true}');
      }, 250);
      response.once("close", () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("local HTTP test server has no address");
    }
    const controller = new AbortController();
    const cancellation = new DOMException("cancel accepted POST", "AbortError");
    const transport = new HttpTransport();

    try {
      const action = transport.action({
        kind: "fetch",
        params: {
          url: `http://127.0.0.1:${String(address.port)}/mutate`,
          method: "POST",
          body: { value: 1 },
        },
        canMutate: false,
        signal: controller.signal,
      });
      await accepted;
      controller.abort(cancellation);

      await expect(action).rejects.toMatchObject({
        name: "OperationOutcomeAmbiguousError",
        operation: "HTTP POST",
        cancellationReason: cancellation,
        outcome_ambiguous: true,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousAllowLocal === undefined) {
        delete process.env.UNICLI_ALLOW_LOCAL;
      } else {
        process.env.UNICLI_ALLOW_LOCAL = previousAllowLocal;
      }
    }
  });

  it("preserves a prior download and removes staging after cancellation", async () => {
    const previousAllowLocal = process.env.UNICLI_ALLOW_LOCAL;
    const previousNoProxy = process.env.NO_PROXY;
    process.env.UNICLI_ALLOW_LOCAL = "1";
    process.env.NO_PROXY = "127.0.0.1,localhost";
    const root = await mkdtemp(join(tmpdir(), "unicli-http-cancel-"));
    const destination = join(root, "artifact.bin");
    await writeFile(destination, "prior");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write("first-");
      const timer = setTimeout(() => response.end("late"), 300);
      response.once("close", () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("local HTTP test server has no address");
    }
    const transport = new HttpTransport();
    await transport.open(makeCtx());
    const controller = new AbortController();
    const cancellation = new Error("cancel HTTP artifact");

    try {
      const action = transport.action({
        kind: "download",
        params: {
          url: `http://127.0.0.1:${String(address.port)}/artifact`,
          dest: destination,
        },
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(cancellation), 30);

      await expect(action).rejects.toBe(cancellation);
      expect(await readFile(destination, "utf8")).toBe("prior");
      expect(await readdir(root)).toEqual(["artifact.bin"]);
    } finally {
      await transport.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
      if (previousAllowLocal === undefined) {
        delete process.env.UNICLI_ALLOW_LOCAL;
      } else {
        process.env.UNICLI_ALLOW_LOCAL = previousAllowLocal;
      }
      if (previousNoProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = previousNoProxy;
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
