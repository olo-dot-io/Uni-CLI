import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fetchTextResource } from "../src/engine/steps/fetch-text.js";
import { htmlToMarkdown } from "../src/engine/html-to-markdown.js";

const runs = Number(process.env.BENCH_RUNS ?? 3);
if (!Number.isInteger(runs) || runs < 1 || runs > 100)
  throw new Error("BENCH_RUNS must be an integer from 1 through 100");
const documentUrl =
  "https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/";
const modes = [
  { name: "html-first", accept: "text/html", convert: true },
  {
    name: "native-markdown",
    accept: "text/markdown,text/html;q=0.9",
    convert: false,
  },
];
const measurements: Array<Record<string, unknown>> = [];
for (let run = 0; run < runs; run++) {
  for (const mode of run % 2 ? [...modes].reverse() : modes) {
    const started = performance.now();
    try {
      const resource = await fetchTextResource(
        documentUrl,
        { url: documentUrl },
        { Accept: mode.accept },
        0,
        { signal: AbortSignal.timeout(30_000) },
      );
      const networkMs = performance.now() - started;
      const content = mode.convert
        ? htmlToMarkdown(resource.text)
        : resource.text;
      measurements.push({
        run,
        mode: mode.name,
        ok:
          content.includes("Markdown for Agents") &&
          content.includes("text/markdown"),
        content_type: resource.contentType,
        received_utf8_bytes: Buffer.byteLength(resource.text),
        content_chars: content.length,
        network_ms: networkMs,
        total_ms: performance.now() - started,
      });
    } catch (error) {
      measurements.push({
        run,
        mode: mode.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        total_ms: performance.now() - started,
      });
    }
  }
}
const modelQuery = "gpt-5";
const modelRequests: Array<Record<string, unknown>> = [];
for (const path of [
  "/models",
  `/models?q=${modelQuery}&limit=2&offset=0&sort=newest`,
]) {
  const url = `https://openrouter.ai/api/v1${path}`;
  const started = performance.now();
  try {
    const resource = await fetchTextResource(
      url,
      { url },
      { Accept: "application/json" },
      0,
      { signal: AbortSignal.timeout(30_000) },
    );
    const payload = JSON.parse(resource.text);
    const selected =
      path === "/models"
        ? payload.data
            .filter((row: { id: string; name?: string }) =>
              `${row.id} ${row.name ?? ""}`.toLowerCase().includes(modelQuery),
            )
            .slice(0, 2)
        : payload.data;
    modelRequests.push({
      path,
      ok: selected.length === 2,
      returned_records: payload.data.length,
      selected_ids: selected.map((row: { id: string }) => row.id),
      received_utf8_bytes: Buffer.byteLength(resource.text),
      wall_ms: performance.now() - started,
    });
  } catch (error) {
    modelRequests.push({
      path,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
const report = {
  generated_at: new Date().toISOString(),
  node_version: process.version,
  platform: `${process.platform}-${process.arch}`,
  runs,
  document_url: documentUrl,
  measurement_boundary:
    "Sequential interleaved live HTTP plus local conversion; bytes count decoded UTF-8 bodies, not compressed wire traffic. OpenRouter compares full-catalog client filtering with current native search; source ordering may differ.",
  measurements,
  model_requests: modelRequests,
};
const outputIndex = process.argv.indexOf("--output");
const serialized = JSON.stringify(report, null, 2) + "\n";
if (outputIndex >= 0 && process.argv[outputIndex + 1])
  writeFileSync(process.argv[outputIndex + 1], serialized);
console.log(serialized);
if ([...measurements, ...modelRequests].some((row) => !row.ok))
  process.exitCode = 1;
