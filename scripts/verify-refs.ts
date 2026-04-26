/**
 * verify-refs.ts — resolve every arXiv ID in `internal/refs.bib` against
 * `https://arxiv.org/abs/<id>` and fail the CI job on 404s.
 *
 * Run: npm run refs:verify
 *
 * Behaviour:
 *  - Parses `@<type>{<key>, ... eprint = {<arxivid>} ... }` blocks.
 *  - Skips blocks without an `eprint` field (non-arXiv sources).
 *  - HEAD request each URL with a 5s timeout.
 *  - Parallel with p-limit style concurrency (8) — no external dep, inline.
 *  - Prints a summary. Non-zero exit code if any HEAD returns non-2xx/3xx.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { request } from "node:https";

interface Entry {
  key: string;
  eprint: string;
}

interface Result {
  key: string;
  eprint: string;
  status: number | "timeout" | "error";
  message?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REFS_BIB = join(HERE, "..", "internal", "refs.bib");
const TIMEOUT_MS = 5_000;
const CONCURRENCY = 8;

function parseRefsBib(source: string): Entry[] {
  const entries: Entry[] = [];

  // Split on lines beginning with `@`; each block ends at the next `@` or EOF.
  const blocks = source.split(/(?=^\s*@)/m);
  for (const block of blocks) {
    const headerMatch = block.match(/^\s*@\w+\s*\{\s*([a-zA-Z0-9_]+)\s*,/);
    if (!headerMatch) continue;
    const key = headerMatch[1];

    const eprintMatch = block.match(/eprint\s*=\s*\{([^}]+)\}/);
    if (!eprintMatch) continue;
    const eprint = eprintMatch[1].trim();
    if (!eprint) continue;

    entries.push({ key, eprint });
  }
  return entries;
}

function headArxiv(eprint: string): Promise<Result["status"]> {
  return new Promise((resolve) => {
    const url = `https://arxiv.org/abs/${encodeURIComponent(eprint)}`;
    let settled = false;
    const req = request(url, { method: "HEAD", timeout: TIMEOUT_MS }, (res) => {
      if (settled) return;
      settled = true;
      resolve(res.statusCode ?? 0);
      res.resume(); // drain
    });
    req.on("timeout", () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve("timeout");
    });
    req.on("error", () => {
      if (settled) return;
      settled = true;
      resolve("error");
    });
    req.end();
  });
}

async function runWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    runners.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= items.length) return;
          results[idx] = await worker(items[idx]);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}

function isOk(status: Result["status"]): boolean {
  return typeof status === "number" && status >= 200 && status < 400;
}

async function main(): Promise<void> {
  const source = readFileSync(REFS_BIB, "utf-8");
  const entries = parseRefsBib(source);

  if (entries.length === 0) {
    console.error(`[verify-refs] no arXiv entries found in ${REFS_BIB}`);
    process.exit(2);
  }

  console.log(`[verify-refs] checking ${entries.length} arXiv entries...`);

  const results = await runWithLimit(entries, CONCURRENCY, async (entry) => {
    const status = await headArxiv(entry.eprint);
    const result: Result = { key: entry.key, eprint: entry.eprint, status };
    const symbol = isOk(status) ? "ok" : "FAIL";
    console.log(
      `  [${symbol}] ${entry.key.padEnd(32)} ${entry.eprint.padEnd(14)} ${status}`,
    );
    return result;
  });

  const failures = results.filter((r) => !isOk(r.status));
  const ok = results.length - failures.length;
  console.log(
    `\n[verify-refs] ${ok}/${results.length} entries verified against arxiv.org`,
  );

  if (failures.length > 0) {
    console.error(`[verify-refs] ${failures.length} FAILED:`);
    for (const f of failures) {
      console.error(`  ${f.key} (${f.eprint}): ${f.status}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[verify-refs] unexpected error:`, err);
  process.exit(1);
});
