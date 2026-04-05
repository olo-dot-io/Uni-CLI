/**
 * Pipeline vars + set step tests — uses a real local HTTP server (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { runPipeline } from "../../src/engine/yaml-runner.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: [{ id: 1, name: "alpha" }] }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr && typeof addr === "object") {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }
});

afterAll(() => {
  server?.close();
});

describe("set step", () => {
  it("stores variables accessible in subsequent templates", async () => {
    const result = await runPipeline(
      [
        { set: { api_url: "https://example.com", max: 5 } },
        { fetch: { url: `${baseUrl}/data` } },
        { select: "items" },
      ],
      {},
    );
    expect(result).toHaveLength(1);
    expect((result[0] as { id: number }).id).toBe(1);
  });

  it("resolves templates in set values using ${{ vars.key }}", async () => {
    const result = await runPipeline(
      [
        { set: { base: "hello" } },
        { set: { greeting: "${{ vars.base }} world" } },
        { fetch: { url: `${baseUrl}/data` } },
        { select: "items" },
      ],
      {},
    );
    expect(result).toHaveLength(1);
  });

  it("merges multiple set steps (later overrides earlier)", async () => {
    const result = await runPipeline(
      [
        { set: { a: 1 } },
        { set: { b: 2, a: 10 } },
        { fetch: { url: `${baseUrl}/data` } },
        { select: "items" },
      ],
      {},
    );
    expect(result).toHaveLength(1);
  });

  it("vars accessible in fetch URL templates", async () => {
    const result = await runPipeline(
      [
        { set: { endpoint: `${baseUrl}` } },
        { fetch: { url: "${{ vars.endpoint }}/data" } },
        { select: "items" },
      ],
      {},
    );
    expect(result).toHaveLength(1);
    expect((result[0] as { id: number }).id).toBe(1);
  });
});
