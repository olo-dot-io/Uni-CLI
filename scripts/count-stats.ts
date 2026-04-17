/**
 * stats.json — Single Source of Truth for every count surfaced in docs.
 *
 * Produces `<repo-root>/stats.json`. Public docs (README.md, AGENTS.md,
 * docs/ROADMAP.md, docs/TASTE.md) must reference these numbers via
 * `<!-- STATS:key -->NNN<!-- /STATS -->` markers — inject at build time
 * via `scripts/build-readme.ts` and `scripts/build-agents.ts`.
 *
 * CLAUDE.md is .gitignored and internal-only; its numbers stay manual.
 *
 * Fields:
 *   adapter_count_yaml   — YAML files under src/adapters/<site>/*.yaml
 *   adapter_count_ts     — TS adapter files (excluding .d.ts, .test.ts)
 *   adapter_count_total  — yaml + ts
 *   site_count           — site directories that registered >=1 command
 *                          (matches the dist/manifest.json emission)
 *   command_count        — total commands across all sites
 *   test_count           — discovered vitest test cases. Enumerated via
 *                          `npx vitest list --json` per project, so
 *                          parametrised (`it.each`) and loop-generated
 *                          tests are counted exactly. Regex fallback if
 *                          vitest is unavailable.
 *   pipeline_step_count  — top-level step keys in `CAPABILITY_MATRIX`
 *                          (src/transport/capability.ts). Source of truth
 *                          for the "N pipeline steps" claim in the docs.
 *   transport_count      — MCP transports shipped (stdio + streamable-http
 *                          + sse + ...); read from src/mcp/ entry files
 *   app_transport_count  — application-layer transports registered on
 *                          TransportBus (http, cdp-browser, subprocess,
 *                          desktop-ax, desktop-uia, desktop-atspi, cua).
 *                          Derived from `TRANSPORT_KINDS`.
 *   category_count       — categories declared in build-manifest.js
 *   built_at             — ISO timestamp of stats.json generation
 *
 * Regenerate manually:   npm run stats
 * Regenerate in build:   wired into `npm run build` (after manifest).
 */

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ADAPTERS_DIR = join(ROOT, "src", "adapters");
const TESTS_DIR = join(ROOT, "tests");
const CAPABILITY_MATRIX_FILE = join(ROOT, "src", "transport", "capability.ts");
const MCP_DIR = join(ROOT, "src", "mcp");
const BUILD_MANIFEST = join(ROOT, "scripts", "build-manifest.js");

export interface Stats {
  adapter_count_yaml: number;
  adapter_count_ts: number;
  adapter_count_total: number;
  site_count: number;
  command_count: number;
  test_count: number;
  /**
   * Distinct pipeline step names declared in the capability matrix
   * (src/transport/capability.ts). This counts every step the runner
   * knows about — API, browser, CUA, desktop-ax — not just the root
   * `executeStep` switch arms, so the number matches the spec promise.
   */
  pipeline_step_count: number;
  /**
   * Transport surfaces the MCP server exposes (stdio, streamable-http,
   * sse). Distinct from {@link app_transport_count}.
   */
  transport_count: number;
  /**
   * Application-layer transports registered on the TransportBus
   * (http, cdp-browser, subprocess, desktop-ax, desktop-uia,
   * desktop-atspi, cua). Derived from `TRANSPORT_KINDS` in
   * src/transport/capability.ts so it tracks the bus capability surface.
   */
  app_transport_count: number;
  category_count: number;
  built_at: string;
}

function countAdapters(): {
  yaml: number;
  ts: number;
  sites: number;
  commands: number;
} {
  if (!existsSync(ADAPTERS_DIR)) {
    return { yaml: 0, ts: 0, sites: 0, commands: 0 };
  }
  let yamlCount = 0;
  let tsCount = 0;
  let siteCount = 0;
  let commandCount = 0;

  for (const site of readdirSync(ADAPTERS_DIR)) {
    if (site.startsWith("_") || site.startsWith(".")) continue;
    const siteDir = join(ADAPTERS_DIR, site);
    if (!statSync(siteDir).isDirectory()) continue;

    let siteHasCommand = false;
    for (const file of readdirSync(siteDir)) {
      if (file.startsWith("_") || file.startsWith(".")) continue;
      const ext = extname(file);
      if (ext === ".yaml" || ext === ".yml") {
        try {
          const raw = readFileSync(join(siteDir, file), "utf-8");
          const parsed = yaml.load(raw) as { name?: string };
          if (!parsed || !parsed.name) continue;
          yamlCount++;
          commandCount++;
          siteHasCommand = true;
        } catch {
          // malformed yaml — don't count
        }
      } else if (ext === ".ts") {
        if (file.endsWith(".d.ts")) continue;
        if (file.endsWith(".test.ts")) continue;
        try {
          const source = readFileSync(join(siteDir, file), "utf-8");
          if (!source.includes("cli(")) continue;
          tsCount++;
          commandCount++;
          siteHasCommand = true;
        } catch {
          // unreadable — skip
        }
      }
    }

    if (siteHasCommand) siteCount++;
  }

  return {
    yaml: yamlCount,
    ts: tsCount,
    sites: siteCount,
    commands: commandCount,
  };
}

/**
 * Regex fallback — sums `it(...)` / `test(...)` literals across every
 * `.test.ts` file under `tests/` and `src/adapters/`. Used when vitest is
 * unavailable (e.g. fresh clone before `npm install`). Undercounts
 * parametrised (`it.each([...])`) and loop-generated tests, so prefer
 * {@link countTestsViaVitest} whenever vitest is on disk.
 */
function countTestsByRegex(): number {
  let count = 0;
  const IT = /\b(?:it|test)\s*\(\s*["'`]/g;

  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules / dist inside src/adapters if any.
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".test.ts")) continue;
      try {
        const source = readFileSync(full, "utf-8");
        const matches = source.match(IT);
        if (matches) count += matches.length;
      } catch {
        // ignore unreadable
      }
    }
  }
  walk(TESTS_DIR);
  walk(ADAPTERS_DIR);
  return count;
}

/**
 * Runs `npx vitest list --json --project <name>` for each project declared
 * in `vitest.config.ts` and sums the enumerated test cases. vitest expands
 * `it.each([...])` parametrised tests and loop-generated `describe`/`it`
 * blocks before emitting the list, so the result matches the runtime
 * counter within vitest's own precision.
 *
 * Returns `null` if vitest is unavailable or the spawn fails — caller
 * falls back to the regex-based counter.
 */
function countTestsViaVitest(): number | null {
  const projects = ["unit", "adapter"];
  let total = 0;
  for (const project of projects) {
    const result = spawnSync(
      "npx",
      ["vitest", "list", "--json", `--project=${project}`],
      {
        cwd: ROOT,
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.status !== 0) return null;
    try {
      const arr = JSON.parse(result.stdout) as unknown[];
      if (!Array.isArray(arr)) return null;
      total += arr.length;
    } catch {
      return null;
    }
  }
  return total;
}

/**
 * Test-count strategy:
 *   1. If `UNICLI_STATS_TEST_STRATEGY=regex`, force the regex counter.
 *      (Useful in CI sandboxes where vitest cannot spawn.)
 *   2. Otherwise try `vitest list --json` per project; it expands
 *      parametrised tests and matches the runtime count.
 *   3. On vitest failure, fall back to the regex counter with a stderr
 *      note so the drift is visible.
 */
function countTests(): number {
  if (process.env.UNICLI_STATS_TEST_STRATEGY === "regex") {
    return countTestsByRegex();
  }
  const fromVitest = countTestsViaVitest();
  if (fromVitest !== null) return fromVitest;
  console.error(
    "count-stats: vitest list failed, falling back to regex counter",
  );
  return countTestsByRegex();
}

const OPEN_BRACE = String.fromCharCode(0x7b);
const CLOSE_BRACE = String.fromCharCode(0x7d);

function extractBalancedObject(
  source: string,
  declPrefix: string,
): string | null {
  const startIdx = source.indexOf(declPrefix);
  if (startIdx < 0) return null;
  const openIdx = source.indexOf(OPEN_BRACE, startIdx);
  if (openIdx < 0) return null;
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    if (ch === 0x7b) depth++;
    else if (ch === 0x7d) {
      depth--;
      if (depth === 0) return source.slice(openIdx + 1, i);
    }
  }
  return null;
}

function countPipelineSteps(): number {
  // Source of truth: the capability matrix. Every step the runner can
  // possibly dispatch — http, cdp-browser, subprocess, desktop-ax,
  // desktop-uia, desktop-atspi, cua — lives as a top-level key of
  // `CAPABILITY_MATRIX`. Counting this file rather than the root switch
  // captures steps that moved into `src/engine/steps/*` modules as part
  // of the v0.212 rewrite.
  if (!existsSync(CAPABILITY_MATRIX_FILE)) return 0;
  const source = readFileSync(CAPABILITY_MATRIX_FILE, "utf-8");
  const body = extractBalancedObject(source, "export const CAPABILITY_MATRIX");
  if (!body) return 0;
  // Top-level keys only: two-space-indented "step_name:" followed by an
  // object-literal open-brace. The matrix is an object; nested config (e.g.
  // the transports tuple) lives one level deeper.
  const keyRe = new RegExp(
    "^ " + "{2}" + "([a-z_][a-z0-9_]*)\\s*:\\s*" + OPEN_BRACE,
    "gm",
  );
  const seen = new Set<string>();
  let km: RegExpExecArray | null;
  while ((km = keyRe.exec(body)) !== null) {
    seen.add(km[1]);
  }
  return seen.size;
}

/**
 * Application-layer transports registered on the TransportBus. Read from
 * `TRANSPORT_KINDS` in capability.ts — the canonical 7-transport tuple
 * that every capability row references.
 */
function countAppTransports(): number {
  if (!existsSync(CAPABILITY_MATRIX_FILE)) return 0;
  const source = readFileSync(CAPABILITY_MATRIX_FILE, "utf-8");
  const m = source.match(
    /export const TRANSPORT_KINDS[^=]*=\s*\[([\s\S]*?)\]\s*as const/,
  );
  if (!m) return 0;
  const body = m[1];
  const re = /"([a-z-]+)"/g;
  const seen = new Set<string>();
  let km: RegExpExecArray | null;
  while ((km = re.exec(body)) !== null) {
    seen.add(km[1]);
  }
  return seen.size;
}

function countTransports(): number {
  if (!existsSync(MCP_DIR)) return 0;
  // Known transport surfaces shipped today. We key on filenames rather than
  // implementation details so this count stays stable while v0.212
  // rewrites internals.
  const known = new Set<string>();
  for (const file of readdirSync(MCP_DIR)) {
    if (file === "server.ts" || file === "index.ts") continue;
    if (!file.endsWith(".ts")) continue;
    if (file.endsWith(".d.ts")) continue;
    if (file.endsWith(".test.ts")) continue;
    // stdio is the implicit default transport bundled into server.ts
    if (
      file === "stdio.ts" ||
      file === "streamable-http.ts" ||
      file === "sse-transport.ts"
    ) {
      known.add(file);
    }
  }
  // stdio lives inline in server.ts but is always present — count it.
  const hasStdio =
    existsSync(join(MCP_DIR, "server.ts")) ||
    existsSync(join(MCP_DIR, "stdio.ts"));
  if (hasStdio) known.add("stdio");
  return known.size;
}

function countCategories(): number {
  if (!existsSync(BUILD_MANIFEST)) return 0;
  const source = readFileSync(BUILD_MANIFEST, "utf-8");
  // Parse the `const CATEGORIES = { ... };` object-literal keys.
  const m = source.match(/const\s+CATEGORIES\s*=\s*\{([\s\S]*?)\n\};/);
  if (!m) return 0;
  const body = m[1];
  // Top-level keys are lines like `  social: [`.
  const keyRe = /^\s{2}([a-z][a-z0-9_]*)\s*:\s*\[/gm;
  const seen = new Set<string>();
  let km: RegExpExecArray | null;
  while ((km = keyRe.exec(body)) !== null) {
    seen.add(km[1]);
  }
  return seen.size;
}

/**
 * `built_at` uses UTC date (YYYY-MM-DD) rather than a full timestamp so the
 * committed `stats.json` only churns when counts actually change. This keeps
 * CI diffs clean — running `npm run stats` twice the same day is a no-op.
 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function computeStats(): Stats {
  const adapters = countAdapters();
  return {
    adapter_count_yaml: adapters.yaml,
    adapter_count_ts: adapters.ts,
    adapter_count_total: adapters.yaml + adapters.ts,
    site_count: adapters.sites,
    command_count: adapters.commands,
    test_count: countTests(),
    pipeline_step_count: countPipelineSteps(),
    transport_count: countTransports(),
    app_transport_count: countAppTransports(),
    category_count: countCategories(),
    built_at: todayUtc(),
  };
}

function main(): void {
  const stats = computeStats();
  const out = join(ROOT, "stats.json");
  writeFileSync(out, JSON.stringify(stats, null, 2) + "\n", "utf-8");
  console.log(
    `stats.json: ${stats.site_count} sites, ${stats.command_count} commands, ` +
      `${stats.adapter_count_total} adapters (${stats.adapter_count_yaml} YAML + ${stats.adapter_count_ts} TS), ` +
      `${stats.test_count} tests, ${stats.pipeline_step_count} steps, ` +
      `${stats.transport_count} MCP transports, ${stats.app_transport_count} app transports, ${stats.category_count} categories`,
  );
}

// Run only when invoked directly
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main();
}
