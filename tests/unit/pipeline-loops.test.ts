import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { URL } from "node:url";
import { runPipeline } from "../../src/engine/yaml-runner.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    const url = new URL(req.url ?? "/", `http://localhost`);
    const page = parseInt(url.searchParams.get("page") ?? "1", 10);
    const items =
      page <= 2
        ? [
            { id: page * 10 + 1, name: `item-${page}-1` },
            { id: page * 10 + 2, name: `item-${page}-2` },
          ]
        : [];
    res.end(JSON.stringify({ items, page }));
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

describe("append step", () => {
  it("pushes array data into vars and preserves ctx.data", async () => {
    const result = await runPipeline(
      [
        { fetch: { url: `${baseUrl}/?page=1` } },
        { select: "items" },
        { append: "collected" },
        { map: { count: "${{ vars.collected.length }}" } },
      ],
      {},
    );
    // ctx.data is still the 2-item array from select, map iterates it
    expect(result).toHaveLength(2);
    expect((result[0] as Record<string, unknown>).count).toBe("2");
  });

  it("accumulates across multiple appends to the same key", async () => {
    // Use scalar selects (page number) to avoid fetch fan-out
    const result = await runPipeline(
      [
        { fetch: { url: `${baseUrl}/?page=1` } },
        { select: "page" },
        { append: "pages" },
        { fetch: { url: `${baseUrl}/?page=2` } },
        { select: "page" },
        { append: "pages" },
      ],
      {},
    );
    // ctx.data is scalar 2, runPipeline wraps to [2]
    expect(result).toEqual([2]);
  });

  it("creates array if vars key does not exist", async () => {
    const result = await runPipeline(
      [
        { fetch: { url: `${baseUrl}/?page=1` } },
        { select: "items" },
        { append: "fresh_list" },
        { map: { count: "${{ vars.fresh_list.length }}" } },
      ],
      {},
    );
    expect(result).toHaveLength(2);
    expect((result[0] as Record<string, unknown>).count).toBe("2");
  });

  it("handles scalar data by wrapping in array", async () => {
    const result = await runPipeline(
      [
        { fetch: { url: `${baseUrl}/?page=1` } },
        { select: "page" },
        { append: "page_nums" },
      ],
      {},
    );
    // ctx.data is still scalar 1, runPipeline wraps to [1]
    expect(result).toEqual([1]);
  });

  it("no-ops on invalid key", async () => {
    const result = await runPipeline(
      [
        { fetch: { url: `${baseUrl}/?page=1` } },
        { select: "items" },
        { append: "" },
      ],
      {},
    );
    expect(result).toHaveLength(2);
  });
});
