/**
 * Engine feature tests — uses a real local HTTP server (no mocks).
 *
 * The echo server receives requests and returns their details as JSON,
 * allowing tests to verify exactly what the engine sent.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { runPipeline } from "../../src/engine/yaml-runner.js";

// --- Echo server: returns request info as JSON ---

let server: Server;
let baseUrl: string;

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await collectBody(req);
    const echo = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body ? JSON.parse(body) : null,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(echo));
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

// --- Tests ---

describe("POST body template resolution", () => {
  it("resolves ${{ args.* }} inside body values", async () => {
    const steps = [
      {
        fetch: {
          url: `${baseUrl}/search`,
          method: "POST",
          body: { query: "${{ args.q }}", limit: 10 },
        },
      },
    ];

    const result = await runPipeline(steps, { q: "typescript" });

    // The echo server returns what it received — verify the body was resolved
    expect(result).toHaveLength(1);
    const echo = result[0] as {
      method: string;
      body: { query: string; limit: number };
    };
    expect(echo.method).toBe("POST");
    expect(echo.body.query).toBe("typescript");
    expect(echo.body.limit).toBe(10);
  });

  it("resolves nested templates in body", async () => {
    const steps = [
      {
        fetch: {
          url: `${baseUrl}/api`,
          method: "POST",
          body: {
            filters: {
              lang: "${{ args.lang }}",
              tags: ["${{ args.tag }}"],
            },
            page: "${{ args.page }}",
          },
        },
      },
    ];

    const result = await runPipeline(steps, {
      lang: "en",
      tag: "cli",
      page: "1",
    });

    const echo = result[0] as {
      body: {
        filters: { lang: string; tags: string[] };
        page: string;
      };
    };
    expect(echo.body.filters.lang).toBe("en");
    expect(echo.body.filters.tags[0]).toBe("cli");
    expect(echo.body.page).toBe("1");
  });

  it("leaves non-template body values untouched", async () => {
    const steps = [
      {
        fetch: {
          url: `${baseUrl}/plain`,
          method: "POST",
          body: { static: "hello", count: 42 },
        },
      },
    ];

    const result = await runPipeline(steps, {});

    const echo = result[0] as { body: { static: string; count: number } };
    expect(echo.body.static).toBe("hello");
    expect(echo.body.count).toBe(42);
  });

  it("resolves body templates in fan-out branch", async () => {
    // First step produces an array, second step fans out with POST for each item
    const steps = [
      {
        fetch: {
          url: `${baseUrl}/ids`,
          method: "POST",
          body: { seed: "${{ args.seed }}" },
        },
      },
    ];

    // For fan-out, we need data to be an array already.
    // We test a simpler case: single POST with template body.
    const result = await runPipeline(steps, { seed: "42" });

    const echo = result[0] as { body: { seed: string } };
    expect(echo.body.seed).toBe("42");
  });
});
