/**
 * @owner       src/adapters/twitter/operations.ts
 * @does        Resolves the current X web GraphQL query id of an operation from the logged-in web client bundles.
 * @needs       The twitter cookie loader, the logged-in https://x.com/home HTML and the abs.twimg.com client chunks.
 * @feeds       twitterFetch and twitterPostFetch in src/adapters/twitter/client.ts.
 * @breaks      A new chunk map layout or a new `queryId:"…",operationName:"…"` literal form stops resolution; callers keep their hard-coded ids.
 * @invariants  The cache file holds the operations found in one main bundle; a new main bundle replaces the entry.
 * @side-effects Reads x.com and abs.twimg.com; writes ~/.unicli/cache/twitter-graphql-operations.json.
 * @perf        A cached name costs one HTML request. A cold name scans main, then chunks with bounded concurrency, and stops once the name is found.
 * @concurrency Concurrent processes may scan the same bundle; the atomic cache write keeps the last complete record.
 * @stability   experimental
 * @since       2026-11-02
 */

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  formatCookieHeader,
  loadCookiesWithCDP,
} from "../../engine/cookies.js";
import { writeFileTransactionally } from "../../engine/transactional-file.js";
import { USER_AGENT } from "../../constants.js";

const HOME_URL = "https://x.com/home";
const CACHE_PATH = join(
  homedir(),
  ".unicli",
  "cache",
  "twitter-graphql-operations.json",
);
const SCAN_CONCURRENCY = 16;
const MAIN_BUNDLE =
  /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"'\s]*\/main\.[0-9a-z]+\.js/;
const CHUNK_NAME =
  /(\d+):"((?:shared~|bundle\.|ondemand\.|loader\.|i18n\/)[^"]*)"/g;
const CHUNK_HASH = /(\d+):"([0-9a-f]{12,})"/g;
const CHUNK_SUFFIX = /\[\w+\]\+"(\w*\.js)"/;
const OPERATION = /queryId:"([^"]+)",operationName:"([^"]+)"/g;
// Chunk classes in the order they held operations in the 2026-11 client; i18n chunks hold translations.
const CHUNK_PRIORITY = ["shared~", "bundle.", "loader.", "ondemand."];

interface OperationCache {
  bundle: string;
  operations: Record<string, string>;
  scanned: string[];
}

function fileName(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

function operationLookupError(message: string): Error {
  return Object.assign(new Error(message), {
    code: "upstream_error",
    retryable: false,
    suggestion:
      "Open https://x.com/home in the signed-in Chrome profile, then retry. Run `unicli repair twitter <command>` if X no longer ships the operation.",
  });
}

/** Main bundle and lazy chunk URLs named by the logged-in home page, chunks in scan order. */
async function readClientBundles(): Promise<{
  main: string;
  chunks: string[];
}> {
  const cookies = await loadCookiesWithCDP("twitter", "x.com");
  const resp = await fetch(HOME_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      ...(cookies ? { Cookie: formatCookieHeader(cookies) } : {}),
    },
  });
  const html = await resp.text();
  const main = MAIN_BUNDLE.exec(html)?.[0];
  if (!main) {
    throw operationLookupError(
      `x.com/home answered HTTP ${resp.status} without a main.<hash>.js client bundle`,
    );
  }
  const base = main.slice(0, main.lastIndexOf("/") + 1);
  const suffix = CHUNK_SUFFIX.exec(html)?.[1] ?? "a.js";
  const names = new Map(
    Array.from(html.matchAll(CHUNK_NAME), (m) => [m[1], m[2]] as const),
  );
  const rank = (name: string) => {
    const index = CHUNK_PRIORITY.findIndex((prefix) => name.startsWith(prefix));
    return index === -1 ? CHUNK_PRIORITY.length : index;
  };
  const chunks = Array.from(html.matchAll(CHUNK_HASH), (m) => ({
    name: names.get(m[1]) ?? m[1],
    hash: m[2],
  }))
    .filter((chunk) => !chunk.name.startsWith("i18n/"))
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map((chunk) => `${base}${chunk.name}.${chunk.hash}${suffix}`);
  return { main, chunks };
}

function readCache(): OperationCache | null {
  try {
    const cache = JSON.parse(
      readFileSync(CACHE_PATH, "utf-8"),
    ) as Partial<OperationCache>;
    return typeof cache.bundle === "string" &&
      cache.operations !== null &&
      typeof cache.operations === "object" &&
      Array.isArray(cache.scanned)
      ? (cache as OperationCache)
      : null;
  } catch {
    return null;
  }
}

async function writeCache(cache: OperationCache): Promise<void> {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    await writeFileTransactionally(
      CACHE_PATH,
      Buffer.from(JSON.stringify(cache)),
      { mode: 0o600 },
    );
  } catch {
    /* the ids are already in memory; the next process scans again */
  }
}

/** Reads `urls` with bounded concurrency into `cache` until `name` is found. */
async function scan(
  urls: string[],
  name: string,
  cache: OperationCache,
  scanned: Set<string>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < urls.length && !cache.operations[name]) {
      const url = urls[next++];
      const resp = await fetch(url).catch(() => null);
      const text = resp ? await resp.text().catch(() => null) : null;
      // 404 is permanent for this bundle; other failures leave the file to the next lookup.
      if (text === null || (!resp?.ok && resp?.status !== 404)) continue;
      for (const m of text.matchAll(OPERATION)) cache.operations[m[2]] = m[1];
      scanned.add(fileName(url));
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
}

/** Current query id of a GraphQL operation in the logged-in X web client. */
export async function resolveOperation(name: string): Promise<string> {
  const { main, chunks } = await readClientBundles();
  const bundle = fileName(main);
  const cached = readCache();
  const cache: OperationCache =
    cached?.bundle === bundle
      ? cached
      : { bundle, operations: {}, scanned: [] };
  if (cache.operations[name]) return cache.operations[name];

  const scanned = new Set(cache.scanned);
  for (const urls of [[main], chunks]) {
    await scan(
      urls.filter((url) => !scanned.has(fileName(url))),
      name,
      cache,
      scanned,
    );
    if (cache.operations[name]) break;
  }
  cache.scanned = [...scanned];
  await writeCache(cache);
  const id = cache.operations[name];
  if (id) return id;
  throw operationLookupError(
    `X web client ${bundle} has no GraphQL operation ${name} (${scanned.size} of ${chunks.length + 1} files read)`,
  );
}
