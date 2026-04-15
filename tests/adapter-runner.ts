/**
 * Fixture-based adapter test harness.
 *
 * Purpose: let colocated `src/adapters/<site>/<cmd>.test.ts` files exercise
 * a YAML (or simple TS) adapter's pipeline against a captured HTTP fixture,
 * without touching the network. CI stays hermetic; failing a test means the
 * pipeline logic or the fixture is genuinely out of sync, not that an
 * upstream API happened to be flaky.
 *
 * Two modes:
 *   - Replay (default, UNICLI_TEST unset): fetch is mocked; each request
 *     is matched against fixture entries (exact URL or regex pattern) and
 *     returns the canned response. Fixture MUST exist.
 *   - Record (UNICLI_TEST=record): the real fetch runs, every request is
 *     captured, and the fixture is written to disk. Used manually by
 *     humans to bootstrap a new fixture against a live endpoint.
 *
 * The harness intentionally handles HTTP-strategy adapters only. Browser /
 * desktop / CUA strategies are skipped with a clear exception — their
 * fixture shape is different enough to deserve its own phase.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import yaml from "js-yaml";
import { runPipeline, PipelineError } from "../src/engine/executor.js";
import type { PipelineStep } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ADAPTERS_DIR = join(ROOT, "src", "adapters");
const FIXTURES_DIR = join(ROOT, "tests", "fixtures");

export interface AdapterFixture {
  version: 1;
  recorded_at: string;
  args?: Record<string, unknown>;
  http_requests: FixtureRequest[];
  expected: {
    columns: string[];
    minItems?: number;
    sampleRow?: Record<string, string>;
  };
}

export interface FixtureRequest {
  method?: string;
  /** Exact URL match — highest priority. */
  url?: string;
  /** Regex to match against the full request URL. */
  url_pattern?: string;
  response: {
    status: number;
    headers?: Record<string, string>;
    /** Base64-encoded body — allows binary or large text. */
    body_b64?: string;
    /** Plain text body — convenience for hand-authored fixtures. */
    body_text?: string;
    /** JSON body — convenience for hand-authored fixtures. */
    body_json?: unknown;
  };
}

interface ParsedYaml {
  site: string;
  name: string;
  type?: string;
  strategy?: string;
  args?: Record<
    string,
    { type?: string; default?: unknown; required?: boolean }
  >;
  pipeline?: PipelineStep[];
  columns?: string[];
  quarantine?: boolean;
  quarantineReason?: string;
  base?: string;
}

const HTTP_TYPES = new Set(["web-api", "service"]);

/**
 * Locate the adapter manifest. YAML takes precedence; TS adapters are out
 * of scope for Phase 2 fixture testing because their behaviour lives in
 * JS code, not a declarative pipeline.
 */
function resolveAdapterPath(
  site: string,
  cmd: string,
): { path: string; kind: "yaml" | "ts" } {
  for (const ext of [".yaml", ".yml"] as const) {
    const p = join(ADAPTERS_DIR, site, `${cmd}${ext}`);
    if (existsSync(p)) return { path: p, kind: "yaml" };
  }
  const tsPath = join(ADAPTERS_DIR, site, `${cmd}.ts`);
  if (existsSync(tsPath)) return { path: tsPath, kind: "ts" };
  throw new Error(
    `adapter not found: src/adapters/${site}/${cmd}.{yaml,yml,ts}`,
  );
}

function loadYamlAdapter(path: string): ParsedYaml {
  const raw = readFileSync(path, "utf-8");
  return yaml.load(raw, { schema: yaml.CORE_SCHEMA }) as ParsedYaml;
}

/**
 * Materialise default values for declared args so the pipeline has the
 * scope it expects (e.g. `${{ args.limit }}` resolves to the default when
 * a fixture does not override it).
 */
function buildArgs(
  adapter: ParsedYaml,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (adapter.args) {
    for (const [name, def] of Object.entries(adapter.args)) {
      if (def?.default !== undefined) {
        args[name] = def.default;
      }
    }
  }
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) args[k] = v;
  }
  return args;
}

/** Decode a fixture response body to a Uint8Array. */
function decodeResponseBody(resp: FixtureRequest["response"]): {
  body: Uint8Array;
  contentType: string;
} {
  const headers = resp.headers ?? {};
  const contentType =
    headers["content-type"] ??
    headers["Content-Type"] ??
    "application/octet-stream";

  if (resp.body_json !== undefined) {
    const text = JSON.stringify(resp.body_json);
    return {
      body: new TextEncoder().encode(text),
      contentType: contentType.includes("json")
        ? contentType
        : "application/json",
    };
  }
  if (resp.body_text !== undefined) {
    return {
      body: new TextEncoder().encode(resp.body_text),
      contentType,
    };
  }
  if (resp.body_b64 !== undefined) {
    return { body: Buffer.from(resp.body_b64, "base64"), contentType };
  }
  return { body: new Uint8Array(), contentType };
}

function matchFixtureRequest(
  fixture: AdapterFixture,
  url: string,
  method: string,
): FixtureRequest | undefined {
  const upperMethod = method.toUpperCase();
  const methodMatches = (req: FixtureRequest): boolean => {
    // Convention: entries that declare no `method` match any method. This
    // keeps synthetic fixtures portable across GET/POST adapters without
    // hand-authoring a method per entry.
    if (!req.method) return true;
    return req.method.toUpperCase() === upperMethod;
  };
  // Exact-URL matches first so a specific entry can override a generic
  // catch-all pattern declared later in the fixture.
  const exact = fixture.http_requests.find(
    (req) => methodMatches(req) && req.url === url,
  );
  if (exact) return exact;
  return fixture.http_requests.find(
    (req) =>
      methodMatches(req) &&
      !!req.url_pattern &&
      new RegExp(req.url_pattern).test(url),
  );
}

function buildMockFetch(fixture: AdapterFixture): typeof fetch {
  return (async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const match = matchFixtureRequest(fixture, url, method);
    if (!match) {
      throw new Error(
        `[adapter-runner] no fixture match for ${method} ${url}. ` +
          `Add an entry to http_requests (url or url_pattern) or record with ` +
          `UNICLI_TEST=record.`,
      );
    }
    const { body, contentType } = decodeResponseBody(match.response);
    const headers = new Headers({
      "content-type": contentType,
      ...match.response.headers,
    });
    return new Response(body, {
      status: match.response.status,
      headers,
    });
  }) as typeof fetch;
}

/**
 * Absolute fixture path for `<site>/<cmd>`. Exposed so both the runner and
 * the bootstrap script agree on the layout.
 */
export function fixturePathFor(site: string, cmd: string): string {
  return join(FIXTURES_DIR, site, `${cmd}.json`);
}

export function loadFixture(site: string, cmd: string): AdapterFixture {
  const path = fixturePathFor(site, cmd);
  if (!existsSync(path)) {
    throw new Error(
      `[adapter-runner] fixture missing: ${path}. ` +
        `Record with: UNICLI_TEST=record npx tsx scripts/record-fixture.ts ${site} ${cmd}`,
    );
  }
  return JSON.parse(readFileSync(path, "utf-8")) as AdapterFixture;
}

export interface RunResult {
  exitCode: number;
  output: unknown[];
  columns: string[];
  rowCount: number;
}

/**
 * Run a YAML adapter's pipeline against its fixture and return the shape
 * the caller needs for assertions.
 */
export async function runAdapterWithFixture(
  site: string,
  cmd: string,
): Promise<RunResult> {
  const { path, kind } = resolveAdapterPath(site, cmd);
  if (kind !== "yaml") {
    throw new Error(
      `[adapter-runner] only YAML adapters supported in Phase 2 — ${site}/${cmd} is ${kind}`,
    );
  }
  const adapter = loadYamlAdapter(path);
  if (adapter.quarantine === true) {
    throw new Error(
      `[adapter-runner] ${site}/${cmd} is quarantined: ${adapter.quarantineReason ?? "(no reason)"}`,
    );
  }
  const type = adapter.type ?? "web-api";
  if (!HTTP_TYPES.has(type)) {
    throw new Error(
      `[adapter-runner] ${site}/${cmd} has type=${type}; only web-api/service supported`,
    );
  }
  if (!adapter.pipeline) {
    throw new Error(
      `[adapter-runner] ${site}/${cmd} has no pipeline; cannot run`,
    );
  }

  const fixture = loadFixture(site, cmd);
  const args = buildArgs(adapter, fixture.args);
  const columns = adapter.columns ?? fixture.expected.columns ?? [];

  const mockFetch = buildMockFetch(fixture);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(mockFetch) as unknown as typeof fetch;

  try {
    const output = await runPipeline(adapter.pipeline, args, adapter.base);
    const rows = Array.isArray(output) ? output : [];
    return {
      exitCode: 0,
      output: rows,
      columns,
      rowCount: rows.length,
    };
  } catch (err) {
    if (err instanceof PipelineError) {
      throw new Error(
        `[adapter-runner] pipeline failed: ${err.message} (step ${err.detail.step}, ${err.detail.action})`,
      );
    }
    throw err;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/**
 * Assert the pipeline output conforms to the adapter's declared columns.
 * Narrow: checks rowCount ≥ minItems, every expected column is present on
 * at least the first row, and optional sampleRow type hints match.
 */
export function expectAdapterShape(
  actual: unknown,
  expected: {
    columns: string[];
    minItems?: number;
    sampleRow?: Record<string, string>;
  },
): void {
  const rows = Array.isArray(actual) ? actual : [];
  const minItems = expected.minItems ?? 1;

  expect(
    rows.length,
    `expected ≥${minItems} rows, got ${rows.length}`,
  ).toBeGreaterThanOrEqual(minItems);

  if (rows.length > 0 && expected.columns.length > 0) {
    const first = rows[0] as Record<string, unknown>;
    for (const col of expected.columns) {
      expect(
        first,
        `row[0] missing expected column "${col}" — got keys ${Object.keys(first).join(",")}`,
      ).toHaveProperty(col);
    }
  }

  if (rows.length > 0 && expected.sampleRow) {
    const first = rows[0] as Record<string, unknown>;
    for (const [key, typeHint] of Object.entries(expected.sampleRow)) {
      const value = first[key];
      if (value === undefined || value === null) continue;
      expect(typeof value, `row[0].${key} should be ${typeHint}`).toBe(
        typeHint,
      );
    }
  }
}

/**
 * Record a fixture by running the adapter against the live endpoint and
 * capturing every fetch call. Invoked from a standalone CLI (not from
 * inside a test).
 */
export async function recordFixture(
  site: string,
  cmd: string,
  args?: Record<string, unknown>,
): Promise<void> {
  const { path, kind } = resolveAdapterPath(site, cmd);
  if (kind !== "yaml") {
    throw new Error(
      `recordFixture only supports YAML adapters — ${site}/${cmd} is ${kind}`,
    );
  }
  const adapter = loadYamlAdapter(path);
  if (!adapter.pipeline) {
    throw new Error(`${site}/${cmd} has no pipeline`);
  }
  const mergedArgs = buildArgs(adapter, args);
  const captured: FixtureRequest[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const resp = await originalFetch(input, init);
    const cloned = resp.clone();
    const buf = new Uint8Array(await cloned.arrayBuffer());
    captured.push({
      method,
      url,
      response: {
        status: resp.status,
        headers: Object.fromEntries(resp.headers.entries()),
        body_b64: Buffer.from(buf).toString("base64"),
      },
    });
    return resp;
  }) as typeof fetch;

  try {
    await runPipeline(adapter.pipeline, mergedArgs, adapter.base);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const fixture: AdapterFixture = {
    version: 1,
    recorded_at: new Date().toISOString(),
    args,
    http_requests: captured,
    expected: {
      columns: adapter.columns ?? [],
      minItems: 1,
    },
  };
  const outPath = fixturePathFor(site, cmd);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n", "utf-8");
}

/**
 * Enumerate testable adapters: YAML, web-api/service, not quarantined,
 * pipeline present. Used by coverage gate and bootstrap.
 */
export function listTestableAdapters(): Array<{
  site: string;
  cmd: string;
  path: string;
  columns: string[];
}> {
  const out: Array<{
    site: string;
    cmd: string;
    path: string;
    columns: string[];
  }> = [];
  if (!existsSync(ADAPTERS_DIR)) return out;
  for (const site of readdirSync(ADAPTERS_DIR)) {
    if (site.startsWith("_") || site.startsWith(".")) continue;
    const siteDir = join(ADAPTERS_DIR, site);
    if (!statSync(siteDir).isDirectory()) continue;
    for (const file of readdirSync(siteDir)) {
      const ext = extname(file);
      if (ext !== ".yaml" && ext !== ".yml") continue;
      const cmd = file.slice(0, -ext.length);
      if (cmd.startsWith("_")) continue;
      const path = join(siteDir, file);
      let parsed: ParsedYaml;
      try {
        parsed = loadYamlAdapter(path);
      } catch {
        continue;
      }
      if (parsed.quarantine === true) continue;
      const type = parsed.type ?? "web-api";
      if (!HTTP_TYPES.has(type)) continue;
      if (!parsed.pipeline) continue;
      out.push({ site, cmd, path, columns: parsed.columns ?? [] });
    }
  }
  return out;
}
