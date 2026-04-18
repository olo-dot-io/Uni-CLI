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
  it("stores variables accessible via ${{ vars.key }} in templates", async () => {
    const result = await runPipeline(
      [
        { set: { endpoint: `${baseUrl}` } },
        { fetch: { url: "${{ vars.endpoint }}/data" } },
        { select: "items" },
        { map: { id: "${{ item.id }}", endpoint: "${{ vars.endpoint }}" } },
      ],
      { args: {}, source: "internal" },
    );
    expect(result).toHaveLength(1);
    const row = result[0] as Record<string, unknown>;
    expect(row.id).toBe("1");
    expect(row.endpoint).toBe(baseUrl);
  });

  it("resolves templates in set values using earlier vars", async () => {
    const result = await runPipeline(
      [
        { set: { base: "hello" } },
        { set: { greeting: "${{ vars.base }} world" } },
        { fetch: { url: `${baseUrl}/data` } },
        { select: "items" },
        { map: { greeting: "${{ vars.greeting }}" } },
      ],
      { args: {}, source: "internal" },
    );
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>).greeting).toBe("hello world");
  });

  it("merges multiple set steps (later overrides earlier)", async () => {
    const result = await runPipeline(
      [
        { set: { a: 1, b: 2 } },
        { set: { b: 99, c: 3 } },
        { fetch: { url: `${baseUrl}/data` } },
        { select: "items" },
        { map: { a: "${{ vars.a }}", b: "${{ vars.b }}", c: "${{ vars.c }}" } },
      ],
      { args: {}, source: "internal" },
    );
    expect(result).toHaveLength(1);
    const row = result[0] as Record<string, unknown>;
    expect(row.a).toBe("1");
    expect(row.b).toBe("99");
    expect(row.c).toBe("3");
  });

  it("passes non-string values through unchanged", async () => {
    const result = await runPipeline(
      [
        { set: { count: 42, active: true } },
        { fetch: { url: `${baseUrl}/data` } },
        { select: "items" },
        { map: { count: "${{ vars.count }}", active: "${{ vars.active }}" } },
      ],
      { args: {}, source: "internal" },
    );
    expect(result).toHaveLength(1);
    const row = result[0] as Record<string, unknown>;
    expect(row.count).toBe("42");
    expect(row.active).toBe("true");
  });

  it("handles empty set as no-op", async () => {
    const result = await runPipeline(
      [{ set: {} }, { fetch: { url: `${baseUrl}/data` } }, { select: "items" }],
      { args: {}, source: "internal" },
    );
    expect(result).toHaveLength(1);
  });

  it("handles invalid config shapes gracefully", async () => {
    // set: "string" should be a no-op, not crash
    const result = await runPipeline(
      [
        { set: "invalid" as unknown },
        { fetch: { url: `${baseUrl}/data` } },
        { select: "items" },
      ],
      { args: {}, source: "internal" },
    );
    expect(result).toHaveLength(1);
  });
});

describe("fallback", () => {
  it("tries fallback URL when primary fetch fails", async () => {
    const result = await runPipeline(
      [
        {
          fetch: {
            url: "http://127.0.0.1:1/will-fail",
            fallback: [{ url: `${baseUrl}/data` }],
          },
        },
        { select: "items" },
        { map: { id: "${{ item.id }}" } },
      ],
      { args: {}, source: "internal" },
    );
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>).id).toBe("1");
  });

  it("tries fallback select paths when primary misses", async () => {
    const result = await runPipeline(
      [
        { fetch: { url: `${baseUrl}/data` } },
        { select: "nonexistent", fallback: ["also_missing", "items"] },
      ],
      { args: {}, source: "internal" },
    );
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>).id).toBe(1);
  });

  it("throws last error when all fallbacks fail", async () => {
    await expect(
      runPipeline(
        [
          { fetch: { url: `${baseUrl}/data` } },
          { select: "no_path", fallback: ["also_no", "still_no"] },
        ],
        { args: {}, source: "internal" },
      ),
    ).rejects.toThrow();
  });

  it("uses primary when it succeeds (fallback ignored)", async () => {
    const result = await runPipeline(
      [
        {
          fetch: {
            url: `${baseUrl}/data`,
            fallback: [{ url: "http://127.0.0.1:1/should-not-reach" }],
          },
        },
        { select: "items" },
      ],
      { args: {}, source: "internal" },
    );
    expect(result).toHaveLength(1);
  });
});

describe("if step", () => {
  it("executes then branch when condition is truthy", async () => {
    const result = await runPipeline(
      [
        { set: { mode: "detailed" } },
        {
          if: "${{ vars.mode == 'detailed' }}",
          then: [{ fetch: { url: `${baseUrl}/data` } }, { select: "items" }],
        },
        { map: { id: "${{ item.id }}" } },
      ],
      { args: {}, source: "internal" },
    );
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>).id).toBe("1");
  });

  it("executes else branch when condition is falsy", async () => {
    const result = await runPipeline(
      [
        { set: { mode: "brief" } },
        {
          if: "${{ vars.mode == 'detailed' }}",
          then: [{ set: { result: "detailed" } }],
          else: [{ set: { result: "brief" } }],
        },
        { fetch: { url: `${baseUrl}/data` } },
        { select: "items" },
        { map: { result: "${{ vars.result }}" } },
      ],
      { args: {}, source: "internal" },
    );
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>).result).toBe("brief");
  });

  it("skips when condition is falsy and no else branch", async () => {
    const result = await runPipeline(
      [
        { fetch: { url: `${baseUrl}/data` } },
        { select: "items" },
        {
          if: "${{ false }}",
          then: [{ select: "nonexistent_will_error" }],
        },
      ],
      { args: {}, source: "internal" },
    );
    expect(result).toHaveLength(1);
  });

  it("supports args in condition", async () => {
    const result = await runPipeline(
      [
        {
          if: "${{ args.verbose }}",
          then: [{ set: { detail: "yes" } }],
          else: [{ set: { detail: "no" } }],
        },
        { fetch: { url: `${baseUrl}/data` } },
        { select: "items" },
        { map: { detail: "${{ vars.detail }}" } },
      ],
      { args: { verbose: true }, source: "internal" },
    );
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>).detail).toBe("yes");
  });

  it("supports nested if steps", async () => {
    const result = await runPipeline(
      [
        { set: { a: true, b: true } },
        {
          if: "${{ vars.a }}",
          then: [
            {
              if: "${{ vars.b }}",
              then: [{ set: { nested: "both_true" } }],
            },
          ],
        },
        { fetch: { url: `${baseUrl}/data` } },
        { select: "items" },
        { map: { nested: "${{ vars.nested }}" } },
      ],
      { args: {}, source: "internal" },
    );
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>).nested).toBe("both_true");
  });
});
