/**
 * `unicli extract <url>` — end-to-end test via a real loopback HTTP server.
 *
 * Per rule 03: prefers E2E across the real network boundary over mocking
 * `fetch`. `UNICLI_ALLOW_LOCAL=1` is set so the SSRF guard permits 127.0.0.1.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { Command } from "commander";
import { createServer, type Server } from "node:http";
import { registerExtractCommand } from "../../../src/commands/extract.js";
import { validateEnvelope } from "../../../src/output/envelope.js";

interface RouteResponse {
  status?: number;
  contentType?: string;
  body: string;
  headers?: Record<string, string>;
}

let server: Server;
let baseUrl = "";
const routes = new Map<string, RouteResponse>();
const prevAllowLocal = process.env.UNICLI_ALLOW_LOCAL;

function captureStdout(): {
  getStdout: () => string;
  restore: () => void;
} {
  let out = "";
  const origLog = console.log;
  console.log = ((...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  }) as typeof console.log;
  return {
    getStdout: () => out,
    restore: () => {
      console.log = origLog;
    },
  };
}

function newProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("-f, --format <fmt>", "output format");
  registerExtractCommand(program);
  return program;
}

beforeAll(async () => {
  process.env.UNICLI_ALLOW_LOCAL = "1";
  server = createServer((req, res) => {
    const route = routes.get(req.url ?? "/");
    if (!route) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain");
      res.end("not found");
      return;
    }
    res.statusCode = route.status ?? 200;
    res.setHeader(
      "content-type",
      route.contentType ?? "text/html; charset=utf-8",
    );
    if (route.headers) {
      for (const [k, v] of Object.entries(route.headers)) {
        res.setHeader(k, v);
      }
    }
    res.end(route.body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "string" || addr === null) {
    throw new Error("unexpected server address");
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  if (prevAllowLocal === undefined) {
    delete process.env.UNICLI_ALLOW_LOCAL;
  } else {
    process.env.UNICLI_ALLOW_LOCAL = prevAllowLocal;
  }
});

beforeEach(() => {
  routes.clear();
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe("unicli extract <url> — success path", () => {
  it("renders HTML to Markdown by default and emits a valid envelope", async () => {
    routes.set("/page", {
      body: "<html><body><h1>Hello</h1><p>World</p></body></html>",
    });
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "extract",
        `${baseUrl}/page`,
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(true);
    expect(env.command).toBe("core.extract");
    expect(env.data.url).toBe(`${baseUrl}/page`);
    expect(env.data.format).toBe("markdown");
    expect(env.data.http_status).toBe(200);
    expect(env.data.truncated).toBe(false);
    expect(env.data.content).toMatch(/^# Hello/);
    expect(env.data.content).toContain("World");
    expect(env.next_actions).toBeDefined();
    expect(env.next_actions.length).toBeGreaterThan(0);
  });

  it("renders plain text when --as text is set", async () => {
    routes.set("/plain", {
      body: "<html><body><h1>Title</h1><script>x=1</script><p>Body</p></body></html>",
    });
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "extract",
        `${baseUrl}/plain`,
        "--as",
        "text",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    expect(env.data.format).toBe("text");
    expect(env.data.content).toContain("Title");
    expect(env.data.content).toContain("Body");
    expect(env.data.content).not.toContain("x=1");
    expect(env.data.content).not.toContain("<");
  });

  it("truncates at --max-chars and surfaces a re-extract next_action", async () => {
    routes.set("/long", { body: `<p>${"a".repeat(5000)}</p>` });
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "extract",
        `${baseUrl}/long`,
        "--max-chars",
        "100",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    expect(env.data.truncated).toBe(true);
    expect(env.data.length).toBe(100);
    expect(env.data.original_length).toBeGreaterThan(100);
    const hasResumeHint = (env.next_actions as Array<{ command: string }>).some(
      (a) => a.command.includes("--max-chars"),
    );
    expect(hasResumeHint).toBe(true);
  });

  it("preserves raw HTML when --as html", async () => {
    routes.set("/raw", { body: "<html><body><h1>Raw</h1></body></html>" });
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "extract",
        `${baseUrl}/raw`,
        "--as",
        "html",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    expect(env.data.format).toBe("html");
    expect(env.data.content).toContain("<h1>Raw</h1>");
  });
});

describe("unicli extract <url> — error path", () => {
  it("emits not_found envelope on HTTP 404", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "extract",
        `${baseUrl}/missing`,
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("not_found");
    expect(env.error.retryable).toBe(false);
    expect(process.exitCode).toBe(2);
    expect(env.next_actions).toBeDefined();
  });

  it("emits invalid_input envelope on non-numeric --max-chars", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "extract",
        `${baseUrl}/missing`,
        "--max-chars",
        "abc",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("invalid_input");
    expect(env.error.message).toMatch(/--max-chars/);
    expect(process.exitCode).toBe(2);
  });

  it("emits invalid_input envelope on --max-chars over the hard limit", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "extract",
        `${baseUrl}/missing`,
        "--max-chars",
        "99999999",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("invalid_input");
    expect(env.error.message).toMatch(/exceeds hard limit/);
    expect(process.exitCode).toBe(2);
  });

  it("emits upstream_error envelope when Content-Length exceeds hard byte cap", async () => {
    // 6 MB declared in Content-Length but a tiny body — exercises the
    // pre-read header check so the test stays fast.
    routes.set("/huge", {
      body: "<p>tiny</p>",
      headers: { "content-length": "6000001" },
    });
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "extract",
        `${baseUrl}/huge`,
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("upstream_error");
    expect(env.error.retryable).toBe(false);
    expect(process.exitCode).toBe(69);
  });

  it("emits upstream_error and marks retryable on 5xx", async () => {
    routes.set("/boom", { status: 503, body: "service down" });
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "extract",
        `${baseUrl}/boom`,
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("upstream_error");
    expect(env.error.retryable).toBe(true);
    expect(process.exitCode).toBe(69);
  });

  it("emits auth_required envelope on 401", async () => {
    routes.set("/private", { status: 401, body: "auth required" });
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "extract",
        `${baseUrl}/private`,
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.error.code).toBe("auth_required");
    expect(process.exitCode).toBe(77);
    const hasAuthHint = (env.next_actions as Array<{ command: string }>).some(
      (a) => a.command.startsWith("unicli auth"),
    );
    expect(hasAuthHint).toBe(true);
  });

  it("emits invalid_input envelope for non-http URL schemes", async () => {
    const cap = captureStdout();
    try {
      const program = newProgram();
      await program.parseAsync([
        "node",
        "unicli",
        "extract",
        "file:///etc/passwd",
        "-f",
        "json",
      ]);
    } finally {
      cap.restore();
    }
    const env = JSON.parse(cap.getStdout());
    validateEnvelope(env);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("invalid_input");
    expect(env.error.retryable).toBe(false);
    expect(process.exitCode).toBe(2);
  });
});
