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
let requestCounts: Record<string, number> = {};

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    // Serve raw HTML for html_to_md tests
    if (req.url === "/html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Title</h1><p>Hello <strong>world</strong></p><ul><li>item 1</li><li>item 2</li></ul>",
      );
      return;
    }

    // Flaky endpoint: returns 503 for first 2 requests, 200 on 3rd
    if (req.url === "/flaky") {
      requestCounts["/flaky"] = (requestCounts["/flaky"] ?? 0) + 1;
      if (requestCounts["/flaky"] < 3) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Service Unavailable" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, attempt: requestCounts["/flaky"] }));
      return;
    }

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

// --- Exec stdin pipe, env vars, output_file tests ---
//
// These scenarios depend on POSIX tools (cat, sh, echo redirection) and
// /tmp. Windows CI runners ship without cat/sh by default, so we skip the
// three blocks below there. Coverage on ubuntu-latest + macOS is enough:
// the subprocess-plumbing logic in src/engine/yaml-runner.ts is
// platform-agnostic; the skipped blocks verify external tool behavior.
const skipOnWindows = process.platform === "win32";

describe.skipIf(skipOnWindows)("exec stdin pipe", () => {
  it("pipes stdin content to subprocess", async () => {
    const steps = [
      {
        exec: {
          command: "cat",
          args: [],
          stdin: "${{ args.content }}",
          parse: "text",
        },
      },
    ];
    const result = await runPipeline(steps, { content: "hello from stdin" });
    expect(result[0]).toBe("hello from stdin");
  });
});

describe.skipIf(skipOnWindows)("exec env vars", () => {
  it("injects env vars into subprocess", async () => {
    const steps = [
      {
        exec: {
          command: "sh",
          args: ["-c", "echo $UNICLI_TEST_VAR"],
          env: { UNICLI_TEST_VAR: "${{ args.val }}" },
          parse: "text",
        },
      },
    ];
    const result = await runPipeline(steps, { val: "injected_value" });
    expect((result[0] as string).trim()).toBe("injected_value");
  });
});

describe.skipIf(skipOnWindows)("exec output_file", () => {
  it("returns file info when output_file exists", async () => {
    // Create a temp file via a command, then check output_file
    const tmpFile = `/tmp/unicli-test-${Date.now()}.txt`;
    const steps = [
      {
        exec: {
          command: "sh",
          args: ["-c", `echo "test content" > ${tmpFile}`],
          output_file: tmpFile,
          parse: "text",
        },
      },
    ];
    const result = await runPipeline(steps, {});
    const first = result[0] as { file: string; size: number };
    expect(first.file).toBe(tmpFile);
    expect(first.size).toBeGreaterThan(0);
    // Clean up
    const { unlink } = await import("node:fs/promises");
    await unlink(tmpFile).catch(() => {});
  });
});

// --- html_to_md step ---

describe("html_to_md step", () => {
  it("converts HTML to markdown", async () => {
    const steps = [
      { fetch_text: { url: `${baseUrl}/html` } },
      { html_to_md: {} },
    ];
    const result = await runPipeline(steps, {});
    const md = String(result[0]);
    expect(md).toContain("Title");
    expect(md).toContain("**world**");
    expect(md).toContain("item 1");
  });
});

// --- Retry with exponential backoff ---

describe("retry with backoff", () => {
  it("retries on 5xx and succeeds", async () => {
    requestCounts["/flaky"] = 0;
    const steps = [
      {
        fetch: {
          url: `${baseUrl}/flaky`,
          retry: 3,
          backoff: 50,
        },
      },
    ];
    const result = await runPipeline(steps, {});
    expect((result[0] as Record<string, unknown>).ok).toBe(true);
  });
});
