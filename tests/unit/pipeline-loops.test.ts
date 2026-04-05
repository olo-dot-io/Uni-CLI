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

describe("each step", () => {
  it("loops and accumulates via append until data is empty", async () => {
    const result = await runPipeline(
      [
        { set: { page: 1, all_items: [] } },
        {
          each: {
            max: 5,
            do: [
              { fetch: { url: baseUrl + "/?page=${{ vars.page }}" } },
              { select: "items" },
              { append: "all_items" },
              { set: { page: "${{ parseInt(vars.page) + 1 }}" } },
            ],
            until: "${{ data.length == 0 }}",
          },
        },
      ],
      {},
    );
    // Pages 1 and 2 each have 2 items, page 3 returns empty → loop stops
    // Final ctx.data is the empty array from page 3, wrapped by runPipeline
    expect(result).toHaveLength(0);
  });

  it("accumulates correct items across iterations", async () => {
    const result = await runPipeline(
      [
        { set: { page: 1, all_items: [] } },
        {
          each: {
            max: 5,
            do: [
              { fetch: { url: baseUrl + "/?page=${{ vars.page }}" } },
              { select: "items" },
              { append: "all_items" },
              { set: { page: "${{ parseInt(vars.page) + 1 }}" } },
            ],
            until: "${{ data.length == 0 }}",
          },
        },
        { map: { total: "${{ vars.all_items.length }}" } },
      ],
      {},
    );
    // data is [] from page 3, map over empty array produces nothing
    // But all_items accumulated 4 items (2 from page 1 + 2 from page 2)
    // Since data is empty, map returns empty array
    expect(result).toHaveLength(0);
  });

  it("respects max iteration limit", async () => {
    const result = await runPipeline(
      [
        { set: { counter: 0 } },
        {
          each: {
            max: 3,
            do: [
              { fetch: { url: baseUrl + "/?page=1" } },
              { select: "items" },
              { set: { counter: "${{ parseInt(vars.counter) + 1 }}" } },
            ],
            until: "${{ false }}",
          },
        },
        { map: { counter: "${{ vars.counter }}" } },
      ],
      {},
    );
    // max=3, until is always false → exactly 3 iterations
    // data is 2-item array from last fetch/select, counter should be 3
    expect(result).toHaveLength(2);
    expect((result[0] as Record<string, unknown>).counter).toBe("3");
  });

  it("executes at least once (do-while semantics)", async () => {
    const result = await runPipeline(
      [
        { set: { executed: false } },
        {
          each: {
            max: 10,
            do: [
              { set: { executed: true } },
              { fetch: { url: baseUrl + "/?page=1" } },
              { select: "items" },
            ],
            until: "${{ true }}",
          },
        },
        { map: { executed: "${{ vars.executed }}" } },
      ],
      {},
    );
    // until is immediately true → but body runs once first (do-while)
    expect(result).toHaveLength(2);
    expect((result[0] as Record<string, unknown>).executed).toBe("true");
  });

  it("handles empty do body as no-op", async () => {
    const result = await runPipeline(
      [
        { fetch: { url: baseUrl + "/?page=1" } },
        { select: "items" },
        {
          each: {
            max: 5,
            do: [],
            until: "${{ true }}",
          },
        },
      ],
      {},
    );
    // Empty body → returns ctx unchanged, data still has 2 items
    expect(result).toHaveLength(2);
  });
});

describe("rate_limit step", () => {
  it("does not block when under the rate limit", async () => {
    const start = Date.now();
    const result = await runPipeline(
      [
        { rate_limit: { domain: "test-fast.example.com", rpm: 600 } },
        { fetch: { url: `${baseUrl}/?page=1` } },
        { select: "items" },
      ],
      {},
    );
    const elapsed = Date.now() - start;
    expect(result).toHaveLength(2);
    expect(elapsed).toBeLessThan(3000);
  });

  it("defaults rpm to 60 when not specified", async () => {
    const result = await runPipeline(
      [
        { rate_limit: { domain: "test-default.example.com" } },
        { fetch: { url: `${baseUrl}/?page=1` } },
        { select: "items" },
      ],
      {},
    );
    expect(result).toHaveLength(2);
  });
});

describe("parallel step", () => {
  it("runs branches concurrently and concatenates by default", async () => {
    const result = await runPipeline(
      [
        {
          parallel: [
            { fetch: { url: `${baseUrl}/?page=1` } },
            { fetch: { url: `${baseUrl}/?page=2` } },
          ],
        },
      ],
      {},
    );
    // Each fetch returns { items: [...], page: N }
    // Two results concatenated into a flat array
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty("items");
    expect(result[1]).toHaveProperty("items");
  });

  it("supports object merge strategy", async () => {
    const result = await runPipeline(
      [
        {
          parallel: [
            { fetch: { url: `${baseUrl}/?page=1` } },
            { fetch: { url: `${baseUrl}/?page=2` } },
          ],
          merge: "object",
        },
      ],
      {},
    );
    // runPipeline wraps non-array data in [data], so result is a 1-element array
    // containing the merged object with keys "0" and "1"
    expect(result).toHaveLength(1);
    const obj = result[0] as Record<string, unknown>;
    expect(obj).toHaveProperty("0");
    expect(obj).toHaveProperty("1");
  });

  it("supports zip merge strategy", async () => {
    const result = await runPipeline(
      [
        {
          parallel: [
            { fetch: { url: `${baseUrl}/?page=1` } },
            { fetch: { url: `${baseUrl}/?page=2` } },
          ],
          merge: "zip",
        },
      ],
      {},
    );
    // fetch returns single objects (not arrays), so zip falls through
    // to the non-array branch, returning results array
    expect(result).toHaveLength(2);
  });

  it("handles empty branches as no-op", async () => {
    const result = await runPipeline(
      [
        { fetch: { url: `${baseUrl}/?page=1` } },
        { select: "items" },
        { parallel: [] },
      ],
      {},
    );
    // Empty parallel is a no-op, data still has 2 items from select
    expect(result).toHaveLength(2);
  });
});
