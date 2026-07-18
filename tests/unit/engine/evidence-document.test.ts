import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAiContent } from "../../../src/commands/ai.js";
import {
  canonicalizeUrl,
  structureEvidenceDocument,
} from "../../../src/engine/evidence-document.js";
import { readEvidenceDocument } from "../../../src/engine/evidence-reader.js";

let server: Server;
let baseUrl = "";
const previousAllowLocal = process.env.UNICLI_ALLOW_LOCAL;

beforeAll(async () => {
  process.env.UNICLI_ALLOW_LOCAL = "1";
  server = createServer((request, response) => {
    if (request.url === "/json") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ title: "Trial NCT0001", status: "RECRUITING" }),
      );
      return;
    }
    if (request.url === "/json-without-title") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ protocolSection: { status: "ACTIVE" } }));
      return;
    }
    if (request.url === "/redirect") {
      response.statusCode = 302;
      response.setHeader("location", "/document?utm_source=redirect");
      response.end();
      return;
    }
    if (request.url?.startsWith("/document")) {
      response.setHeader("content-type", "text/html");
      response.end(
        "<html><body><h1>Primary document</h1><p>Body</p></body></html>",
      );
      return;
    }
    if (request.url === "/shell") {
      response.setHeader("content-type", "text/html");
      response.end(
        '<html><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
      );
      return;
    }
    if (request.url === "/classic-shell") {
      response.setHeader("content-type", "text/html");
      response.end(
        '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
      );
      return;
    }
    response.statusCode = 404;
    response.end("missing");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (previousAllowLocal === undefined) {
    delete process.env.UNICLI_ALLOW_LOCAL;
  } else {
    process.env.UNICLI_ALLOW_LOCAL = previousAllowLocal;
  }
});

describe("EvidenceDocument", () => {
  it("canonicalizes redirect wrappers, tracking parameters, fragments, and default ports", () => {
    const yahoo =
      "https://r.search.yahoo.com/_ylt=x/RU=https%3A%2F%2Fexample.com%3A443%2Fguide%3Futm_source%3Dy/RK=2/RS=x";
    expect(canonicalizeUrl(yahoo)).toBe("https://example.com/guide");
    expect(
      canonicalizeUrl("https://example.com:443/guide?fbclid=x#section"),
    ).toBe("https://example.com/guide");
  });

  it("hashes exactly the returned content and retains source/final provenance", () => {
    const document = structureEvidenceDocument({
      sourceUrl: "https://example.com/source",
      finalUrl: "https://example.com/final",
      content: "# Title\n\n1234567890",
      contentType: "text/markdown",
      contentFormat: "markdown",
      sourceAdapter: "fixture",
      sourceCommand: "read",
      reader: "direct",
      retrievedAt: "2026-07-17T00:00:00.000Z",
      maxChars: 10,
      maxLinks: 10,
    });
    const sameReturnedContent = structureEvidenceDocument({
      sourceUrl: "https://example.com/source",
      finalUrl: "https://example.com/final",
      content: "# Title\n\n1DIFFERENT",
      contentType: "text/markdown",
      contentFormat: "markdown",
      sourceAdapter: "fixture",
      sourceCommand: "read",
      reader: "direct",
      retrievedAt: "2026-07-17T00:00:00.000Z",
      maxChars: 10,
      maxLinks: 10,
    });

    expect(document).toMatchObject({
      schema_version: "evidence-document.v1",
      source_url: "https://example.com/source",
      url: "https://example.com/final",
      truncated: true,
      char_count: 10,
    });
    expect(document.content_sha256).toBe(sameReturnedContent.content_sha256);
  });

  it("does not let structured payloads or outlines bypass maxChars", () => {
    const document = structureEvidenceDocument({
      sourceUrl: "https://github.com/org/repo/issues/1",
      content: JSON.stringify({ comments: [{ body: "x".repeat(20_000) }] }),
      outline: `# ${"title".repeat(1_000)}\n${"x".repeat(20_000)}`,
      contentType: "application/vnd.github+json",
      contentFormat: "github-thread",
      sourceAdapter: "gh",
      sourceCommand: "issue-thread",
      reader: "github-api",
      retrievedAt: "2026-07-17T00:00:00.000Z",
      maxChars: 1_000,
      maxLinks: 10,
      structuredData: { comments: [{ body: "x".repeat(20_000) }] },
    });

    expect(document).toMatchObject({
      char_count: 1_000,
      truncated: true,
      structured_data_truncated: true,
    });
    expect(document.structured_data).toBeUndefined();
    expect(document.title.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(document).length).toBeLessThan(4_000);
  });

  it("preserves an upstream original length after a format reader truncates", () => {
    const document = structureEvidenceDocument({
      sourceUrl: "https://example.com/large.pdf",
      content: "x".repeat(50_033),
      contentType: "application/pdf",
      contentFormat: "pdf-text",
      sourceAdapter: "scholar-artifacts",
      sourceCommand: "read-pdf",
      reader: "pdftotext",
      retrievedAt: "2026-07-17T00:00:00.000Z",
      maxChars: 50_000,
      maxLinks: 10,
      originalCharCount: 500_000,
      textChars: 500_000,
      textTruncated: true,
    });

    expect(document).toMatchObject({
      original_char_count: 500_000,
      text_chars: 500_000,
      char_count: 50_000,
      truncated: true,
    });
  });

  it("propagates the caller's exact cancellation reason before reader dispatch", async () => {
    const controller = new AbortController();
    const reason = new Error("evidence-read-cancelled");
    controller.abort(reason);

    await expect(
      readEvidenceDocument("https://github.com/example/repo/issues/1", {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("parses JSON as structured evidence and follows redirects without losing the request URL", async () => {
    const json = await readEvidenceDocument(`${baseUrl}/json`);
    expect(json).toMatchObject({
      content_format: "json",
      content_type: "application/json",
      title: "Trial NCT0001",
      http_status: 200,
      structured_data: { title: "Trial NCT0001", status: "RECRUITING" },
    });

    const redirected = await readEvidenceDocument(`${baseUrl}/redirect`);
    expect(redirected.source_url).toBe(`${baseUrl}/redirect`);
    expect(redirected.url).toBe(`${baseUrl}/document`);
    expect(redirected.content).toContain("Primary document");
  });

  it("uses URL identity instead of JSON punctuation when structured data has no title", async () => {
    const document = await readEvidenceDocument(
      `${baseUrl}/json-without-title`,
    );

    expect(document.title).toBe(`json-without-title — 127.0.0.1`);
  });

  it("gives generic and AI overlays the same evidence identity and content hash", async () => {
    const direct = await readEvidenceDocument(`${baseUrl}/document`);
    const ai = await readAiContent(`${baseUrl}/document`);

    expect(ai).toMatchObject({
      schema_version: direct.schema_version,
      id: direct.id,
      source_url: direct.source_url,
      url: direct.url,
      content_sha256: direct.content_sha256,
      source_adapter: "web",
      source_command: "read",
    });
  });

  it("fails closed on an unrendered application shell", async () => {
    await expect(readEvidenceDocument(`${baseUrl}/shell`)).rejects.toEqual(
      expect.objectContaining({
        code: "dynamic_content_required",
        retryable: false,
      }),
    );
    await expect(
      readEvidenceDocument(`${baseUrl}/classic-shell`),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "dynamic_content_required",
        retryable: false,
      }),
    );
  });
});
