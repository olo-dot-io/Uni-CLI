import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "unicli-retrieval-scenario-"));
process.env.HOME = home;
process.env.UNICLI_ALLOW_LOCAL = "1";
process.env.UNICLI_NO_LOG = "1";

const { cli, Strategy } = await import("../../src/registry.js");
const { buildInvocation, execute } =
  await import("../../src/engine/kernel/execute.js");
const { fetchTextResource } =
  await import("../../src/engine/steps/fetch-text.js");
const { readEvidenceDocument } =
  await import("../../src/engine/evidence-reader.js");
const { primeKernelCache } = await import("../../src/discovery/loader.js");
await import("../../src/adapters/retrieval/intelligence.js");

const old = {
  title: "Original guide",
  url: "https://docs.example/old",
  published_at: "2026-09-01",
};
const recent = {
  title: "Current guide",
  url: "https://docs.example/current",
  published_at: "2026-10-09",
};
let primary = [old, recent, recent];
let secondary = [
  {
    title: "Second source",
    url: "https://docs.example/secondary",
    published_at: "2026-09-02",
  },
];
let failing = new Set<string>();
let revision = 1;
const outcomes: Array<{ scenario: string; passed: boolean; detail?: unknown }> =
  [];

const server = createServer((request, response) => {
  const path = request.url ?? "/";
  if (failing.has(path)) {
    response.writeHead(429, {
      "content-type": "text/plain",
      "retry-after": "1",
    });
    response.end("Source is temporarily rate limited");
  } else if (path === "/redirect") {
    response.writeHead(302, { location: "/guide" });
    response.end();
  } else if (path === "/guide") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<html><head><title>Current guide</title></head><body><nav>Navigation</nav><article><h1>Current guide</h1><p>Revision ${revision}. Keep **literal** content and <strong>formatting</strong>.</p><h2>Installation</h2><p>Use the source instructions.</p><pre>user_id | flags\nx &gt; 2\nrate * count</pre><a href="/install">Install</a></article></body></html>`,
    );
  } else {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(path === "/primary" ? primary : secondary));
  }
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Scenario server did not bind");
  const base = `http://127.0.0.1:${address.port}`;

  for (const name of ["primary", "secondary"]) {
    cli({
      site: `scenario-${name}`,
      name: "search",
      description: "Read controlled retrieval source records",
      strategy: Strategy.PUBLIC,
      browser: false,
      operation_effect: "read",
      capabilities: ["http.fetch"],
      minimum_capability: "http.fetch",
      args: [{ name: "query", type: "str", required: true }],
      retrieval: {
        operation: "discover",
        result_kind: "docs",
        source_class: "official",
        arguments: { query: "query" },
      },
      func: async (_page, _args, context) => {
        const url = `${base}/${name}`;
        const resource = await fetchTextResource(
          url,
          { url, retry: 1 },
          {},
          -1,
          { signal: context.signal },
        );
        return JSON.parse(resource.text);
      },
    });
  }
  primeKernelCache();

  async function search(
    options: { sort?: string; limit?: number; sources?: string } = {},
  ) {
    const invocation = buildInvocation(
      "cli",
      "retrieval",
      "search",
      {
        args: {
          query: "guide",
          sources: "scenario-primary,scenario-secondary",
          ...options,
        },
        source: "internal",
      },
      { approved: true },
    );
    if (!invocation) throw new Error("Retrieval command was not registered");
    return execute(invocation);
  }

  const newest = await search({ sort: "latest", limit: 1 });
  const newestRow = newest.results[0] as Record<string, unknown> | undefined;
  outcomes.push({
    scenario: "latest selection precedes limit",
    passed: !newest.error && newestRow?.url === recent.url,
    detail: newest.error ?? newestRow?.url,
  });

  const ranked = await search({ limit: 3 });
  const rankedRows = ranked.results as Array<Record<string, unknown>>;
  const repeated = rankedRows.find((row) => row.url === recent.url);
  outcomes.push({
    scenario: "duplicate rows count once per source",
    passed:
      !ranked.error &&
      rankedRows[0]?.url === old.url &&
      repeated?.rrf_score === Number((1 / 62).toFixed(8)),
    detail:
      ranked.error ??
      rankedRows.map((row) => ({ url: row.url, rrf_score: row.rrf_score })),
  });

  secondary = [recent];
  const fused = await search({ limit: 1 });
  const fusedRow = fused.results[0] as Record<string, unknown> | undefined;
  outcomes.push({
    scenario: "independent sources contribute their best rank",
    passed:
      !fused.error &&
      fusedRow?.url === recent.url &&
      fusedRow?.rrf_score === Number((1 / 62 + 1 / 61).toFixed(8)) &&
      JSON.stringify(fusedRow?.source_refs) ===
        JSON.stringify([
          "scenario-primary.search",
          "scenario-secondary.search",
        ]),
    detail: fused.error ?? fusedRow,
  });

  primary = [old, { ...recent, title: "Revised guide" }];
  secondary = [];
  const updated = await search({ sort: "latest", limit: 1 });
  outcomes.push({
    scenario: "source changes reach the next invocation",
    passed:
      (updated.results[0] as Record<string, unknown> | undefined)?.title ===
      "Revised guide",
  });

  failing = new Set(["/secondary"]);
  const partial = await search({ limit: 1 });
  const partialRow = partial.results[0] as Record<string, unknown> | undefined;
  outcomes.push({
    scenario: "partial failure keeps evidence and provider diagnostics",
    passed:
      !partial.error &&
      partialRow?.partial_failure_count === 1 &&
      Array.isArray(partialRow.source_errors),
    detail: partial.error,
  });

  failing.add("/primary");
  const unavailable = await search({ limit: 1 });
  outcomes.push({
    scenario: "all-source failure retains its cause and retry routes",
    passed:
      unavailable.error?.code === "rate_limited" &&
      unavailable.error.retryable === true &&
      unavailable.error.message.includes("scenario-primary.search") &&
      unavailable.error.message.includes("scenario-secondary.search") &&
      (unavailable.error.alternatives?.length ?? 0) >= 2,
    detail: unavailable.error,
  });

  failing.clear();
  const recovered = await search({ limit: 1 });
  outcomes.push({
    scenario: "sources recover without cached failures",
    passed: !recovered.error && recovered.results.length === 1,
  });

  primary = [];
  const empty = await search({ limit: 1 });
  outcomes.push({
    scenario: "successful empty sources remain empty results",
    passed: empty.error?.code === "empty_result",
    detail: empty.error,
  });

  const markdown = await readEvidenceDocument(`${base}/redirect`);
  const plain = await readEvidenceDocument(`${base}/guide`, {
    representation: "text",
  });
  outcomes.push({
    scenario: "redirected reads preserve source, final URL, and content",
    passed:
      markdown.source_url === `${base}/redirect` &&
      markdown.url === `${base}/guide` &&
      markdown.content.includes("Revision 1") &&
      !markdown.content.includes("Navigation") &&
      markdown.links.some((link) => link.url === `${base}/install`),
  });
  outcomes.push({
    scenario:
      "plain text preserves literal syntax and code from the same content root",
    passed:
      plain.content_format === "text" &&
      plain.content.includes("Revision 1") &&
      plain.content.includes("Keep **literal** content and formatting.") &&
      plain.content.includes("user_id | flags\nx > 2\nrate * count") &&
      plain.content.includes("Installation") &&
      !plain.content.includes("Navigation") &&
      plain.headings.length === markdown.headings.length,
    detail: plain.content,
  });

  revision = 2;
  const reread = await readEvidenceDocument(`${base}/guide`, { maxChars: 40 });
  outcomes.push({
    scenario: "rereads and truncation reflect current source content",
    passed:
      reread.content.includes("Revision 2") &&
      reread.truncated &&
      reread.char_count === 40 &&
      reread.original_char_count > 40,
  });
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
}

const failures = outcomes.filter((outcome) => !outcome.passed);
console.log(
  JSON.stringify(
    {
      scenarios: outcomes.length,
      passed: outcomes.length - failures.length,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;
