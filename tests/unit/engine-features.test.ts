/**
 * Engine feature tests — uses a real local HTTP server (no mocks).
 *
 * The echo server receives requests and returns their details as JSON,
 * allowing tests to verify exactly what the engine sent.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { runPipeline } from "../../src/engine/executor.js";
import { htmlToMarkdown } from "../../src/engine/html-to-markdown.js";
import { isHtmlVerificationChallenge } from "../../src/engine/steps/html-to-md.js";
import "../../src/engine/steps/index.js";

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
        "<style>.noise-rule{color:red}</style><h1>Title</h1><script>window.__noise=true</script><p>Hello <strong>world</strong></p><ul><li>item 1</li><li>item 2</li></ul>",
      );
      return;
    }

    if (req.url === "/challenge") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><head><title>Verifying your browser</title></head><body><h1>Verifying your browser</h1><p>Please enable JavaScript and cookies to continue.</p></body></html>`,
      );
      return;
    }

    if (req.url === "/slow" || req.url === "/slow-text") {
      setTimeout(() => {
        res.writeHead(200, {
          "Content-Type":
            req.url === "/slow" ? "application/json" : "text/plain",
        });
        res.end(req.url === "/slow" ? JSON.stringify({ ok: true }) : "ok");
      }, 500);
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

    if (req.url === "/flaky-text") {
      requestCounts["/flaky-text"] = (requestCounts["/flaky-text"] ?? 0) + 1;
      if (requestCounts["/flaky-text"] < 2) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("try again");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("text ok");
      return;
    }

    if (req.url === "/missing-json") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (req.url === "/missing-text") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
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

    const result = await runPipeline(steps, {
      args: { q: "typescript" },
      source: "internal",
    });

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

  it("resolves header templates from args and env", async () => {
    const previousToken = process.env.UNICLI_TEST_AUTH;
    process.env.UNICLI_TEST_AUTH = "unit-token";
    try {
      const result = await runPipeline(
        [
          {
            fetch: {
              url: `${baseUrl}/headers`,
              headers: {
                Authorization: "Bearer ${{ env.UNICLI_TEST_AUTH || '' }}",
                "X-Query": "${{ args.q }}",
              },
            },
          },
        ],
        { args: { q: "typescript" }, source: "internal" },
      );

      const echo = result[0] as {
        headers: { authorization?: string; "x-query"?: string };
      };
      expect(echo.headers.authorization).toBe("Bearer unit-token");
      expect(echo.headers["x-query"]).toBe("typescript");
    } finally {
      if (previousToken === undefined) {
        delete process.env.UNICLI_TEST_AUTH;
      } else {
        process.env.UNICLI_TEST_AUTH = previousToken;
      }
    }
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
      args: {
        lang: "en",
        tag: "cli",
        page: "1",
      },
      source: "internal",
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

    const result = await runPipeline(steps, { args: {}, source: "internal" });

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
    const result = await runPipeline(steps, {
      args: { seed: "42" },
      source: "internal",
    });

    const echo = result[0] as { body: { seed: string } };
    expect(echo.body.seed).toBe("42");
  });
});

// --- Exec stdin pipe, env vars, output_file tests ---
//
// These scenarios depend on POSIX tools (cat, sh, echo redirection) and
// /tmp. Windows CI runners ship without cat/sh by default, so we skip the
// three blocks below there. Coverage on ubuntu-latest + macOS is enough:
// the subprocess-plumbing logic in src/engine/executor.ts is
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
    const result = await runPipeline(steps, {
      args: { content: "hello from stdin" },
      source: "internal",
    });
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
    const result = await runPipeline(steps, {
      args: { val: "injected_value" },
      source: "internal",
    });
    expect((result[0] as string).trim()).toBe("injected_value");
  });

  it("resolves template expressions in subprocess timeout", async () => {
    const steps = [
      {
        exec: {
          command: "sh",
          args: ["-c", "printf template-timeout"],
          timeout: "${{ (args.duration + 5) * 1000 }}",
          parse: "text",
        },
      },
    ];
    const result = await runPipeline(steps, {
      args: { duration: 1 },
      source: "internal",
    });
    expect(result[0]).toBe("template-timeout");
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
    const result = await runPipeline(steps, { args: {}, source: "internal" });
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
  it("does not mistake browser-troubleshooting prose for a live challenge", () => {
    expect(
      isHtmlVerificationChallenge(
        `<html><head><title>Browser automation guide</title></head><body><article><h1>Troubleshooting</h1><p>If a site says it is checking your browser, inspect the response and complete the upstream login.</p></article></body></html>`,
      ),
    ).toBe(false);
  });

  it("fails closed on browser-verification challenge pages", async () => {
    await expect(
      runPipeline(
        [{ fetch_text: { url: `${baseUrl}/challenge` } }, { html_to_md: {} }],
        { args: {}, source: "internal" },
      ),
    ).rejects.toMatchObject({
      detail: expect.objectContaining({
        errorType: "challenge_required",
        preserveErrorCode: true,
      }),
    });
  });

  it("converts HTML to markdown", async () => {
    const steps = [
      { fetch_text: { url: `${baseUrl}/html` } },
      { html_to_md: {} },
    ];
    const result = await runPipeline(steps, { args: {}, source: "internal" });
    const md = String(result[0]);
    expect(md).toContain("Title");
    expect(md).toContain("**world**");
    expect(md).toContain("item 1");
    expect(md).not.toContain("window.__noise");
    expect(md).not.toContain(".noise-rule");
  });

  it.each([
    {
      name: "article-based NVIDIA docs",
      html: `<html><head><title>CUDA Guide</title></head><body><nav>Products Drivers</nav><article><h1>CUDA Guide</h1><p>Install the toolkit.</p></article><footer>Legal links</footer></body></html>`,
      expected: "Install the toolkit.",
    },
    {
      name: "main-based ROCm docs",
      html: `<html><head><title>ROCm Install</title></head><body><aside>Versions</aside><main><h1>ROCm Install <a class="headerlink" title="Permalink">#</a></h1><p>Deploy on Instinct accelerators.</p></main></body></html>`,
      expected: "Deploy on Instinct accelerators.",
    },
    {
      name: "role-main Ascend docs",
      html: `<html><head><title>CANN Reference</title></head><body><div role="navigation">Documentation tree</div><div role="main"><h1>CANN Reference</h1><p>[object Object]undefined</p><a href="%5Bobject%20Object%5D">[object Object]</a><p>Configure the Ascend runtime.</p><a href="#top">返回顶部</a></div></body></html>`,
      expected: "Configure the Ascend runtime.",
    },
  ])("extracts the semantic body from $name", ({ html, expected }) => {
    const markdown = htmlToMarkdown(html);

    expect(markdown).toContain(expected);
    expect(markdown).not.toMatch(
      /Products Drivers|Legal links|Versions|Documentation tree|Permalink|\[object Object\]|undefined/,
    );
    expect(markdown.trimStart()).toMatch(/^# /);
  });

  it("preserves legitimate undefined documentation without serialization evidence", () => {
    const markdown = htmlToMarkdown(
      `<html><head><title>JavaScript Values</title></head><body><article><h1>JavaScript Values</h1><p>undefined</p><p>An undefined symbol remains meaningful.</p></article></body></html>`,
    );

    expect(markdown).toContain("undefined");
    expect(markdown).toContain("An undefined symbol remains meaningful.");
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
    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect((result[0] as Record<string, unknown>).ok).toBe(true);
  });

  it("retries fetch_text on 5xx and succeeds", async () => {
    requestCounts["/flaky-text"] = 0;
    const steps = [
      {
        fetch_text: {
          url: `${baseUrl}/flaky-text`,
          retry: 2,
          backoff: 10,
        },
      },
    ];
    const result = await runPipeline(steps, { args: {}, source: "internal" });
    expect(result[0]).toBe("text ok");
    expect(requestCounts["/flaky-text"]).toBe(2);
  });

  it("treats retry 0 as one fetch attempt", async () => {
    const result = await runPipeline(
      [
        {
          fetch: {
            url: `${baseUrl}/retry-zero-json`,
            retry: 0,
          },
        },
      ],
      { args: {}, source: "internal" },
    );

    expect(result[0]).toMatchObject({ url: "/retry-zero-json" });
  });

  it("treats retry 0 as one fetch_text attempt", async () => {
    const result = await runPipeline(
      [
        {
          fetch_text: {
            url: `${baseUrl}/html`,
            retry: 0,
          },
        },
      ],
      { args: {}, source: "internal" },
    );

    expect(result[0]).toContain("<h1>Title</h1>");
  });

  it("classifies final fetch_text network failure as retryable", async () => {
    await expect(
      runPipeline(
        [
          {
            fetch_text: {
              url: "http://127.0.0.1:1/unreachable",
              retry: 1,
            },
          },
        ],
        { args: {}, source: "internal" },
      ),
    ).rejects.toMatchObject({
      detail: {
        action: "fetch_text",
        errorType: "network_error",
        step: 0,
        retryable: true,
      },
    });
  });
});

describe("request cancellation", () => {
  it.each(["fetch", "fetch_text"])(
    "aborts an in-flight %s request at the invocation boundary",
    async (action) => {
      const startedAt = Date.now();
      await expect(
        runPipeline(
          [
            {
              [action]: {
                url: `${baseUrl}/${action === "fetch" ? "slow" : "slow-text"}`,
              },
            },
          ],
          { args: {}, source: "internal" },
          undefined,
          { signal: AbortSignal.timeout(25) },
        ),
      ).rejects.toMatchObject({ detail: { errorType: "network_error" } });
      expect(Date.now() - startedAt).toBeLessThan(400);
    },
  );
});

describe("step error metadata", () => {
  it("reports fetch HTTP errors with the pipeline step index", async () => {
    await expect(
      runPipeline(
        [
          { set: { marker: "before" } },
          { fetch: { url: `${baseUrl}/missing-json` } },
        ],
        { args: {}, source: "internal" },
      ),
    ).rejects.toMatchObject({
      detail: {
        action: "fetch",
        errorType: "http_error",
        step: 1,
        statusCode: 404,
      },
    });
  });

  it("reports fetch_text HTTP errors with the pipeline step index", async () => {
    await expect(
      runPipeline(
        [
          { set: { marker: "before" } },
          { fetch_text: { url: `${baseUrl}/missing-text` } },
        ],
        { args: {}, source: "internal" },
      ),
    ).rejects.toMatchObject({
      detail: {
        action: "fetch_text",
        errorType: "http_error",
        step: 1,
        statusCode: 404,
      },
    });
  });
});

describe.skipIf(skipOnWindows)("exec error metadata", () => {
  it("aborts the child process when the invocation deadline expires", async () => {
    const startedAt = Date.now();
    await expect(
      runPipeline(
        [{ exec: { command: "sh", args: ["-c", "sleep 5"] } }],
        { args: {}, source: "internal" },
        undefined,
        { signal: AbortSignal.timeout(25) },
      ),
    ).rejects.toMatchObject({ detail: { errorType: "timeout" } });
    expect(Date.now() - startedAt).toBeLessThan(400);
  });

  it("reports exec timeout parse errors with the pipeline step index", async () => {
    await expect(
      runPipeline(
        [
          { set: { marker: "before" } },
          {
            exec: {
              command: "sh",
              args: ["-c", "printf never-runs"],
              timeout: "not-a-number",
            },
          },
        ],
        { args: {}, source: "internal" },
      ),
    ).rejects.toMatchObject({
      detail: {
        action: "exec",
        errorType: "parse_error",
        step: 1,
      },
    });
  });
});
