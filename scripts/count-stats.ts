/**
 * @owner   scripts/count-stats.ts
 * @does    Compute stats.json counts used by README, docs, AGENTS, and release copy with bounded test enumeration.
 * @needs   repo adapters/tests/manifest/MCP files, executable step surface, vitest list, dist manifest categories
 * @feeds   stats.json, scripts/build-readme.ts, scripts/build-agents.ts, npm run build, npm run stats:check
 * @breaks  Missing or malformed repo count sources produce zero counts or explicit test-count degradation warnings.
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
import { getBuiltInStepSurface } from "../src/engine/step-surface.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ADAPTERS_DIR = join(ROOT, "src", "adapters");
const TESTS_DIR = join(ROOT, "tests");
const CAPABILITY_MATRIX_FILE = join(ROOT, "src", "transport", "capability.ts");
const MCP_DIR = join(ROOT, "src", "mcp");
const BUILD_MANIFEST = join(ROOT, "scripts", "build-manifest.js");
const DIST_MANIFEST = join(ROOT, "dist", "manifest.json");
const STATS_JSON = join(ROOT, "stats.json");
const ELECTRON_DESKTOP_BASE_COMMAND_COUNT = 7;
const ELECTRON_DESKTOP_MEDIA_COMMAND_COUNT = 6;
const AI_CHAT_BASE_COMMAND_COUNT = 6;
const DEFAULT_VITEST_LIST_TIMEOUT_MS = 90_000;

export interface Stats {
  adapter_count_yaml: number;
  adapter_count_ts: number;
  adapter_count_total: number;
  site_count: number;
  command_count: number;
  test_count: number;
  /** Executable built-in actions: registered pipeline plus transport-native. */
  pipeline_step_count: number;
  /** Actions owned by the main step registry. */
  pipeline_registered_step_count: number;
  /** Low-level actions owned directly by visual/AX/UIA/AT-SPI transports. */
  pipeline_transport_step_count: number;
  /**
   * Transport surfaces the MCP server exposes (stdio, streamable-http,
   * http). Distinct from {@link app_transport_count}.
   */
  transport_count: number;
  /**
   * Application-layer transports registered on the TransportBus
   * (http, cdp-browser, subprocess, desktop-ax, desktop-uia,
   * desktop-atspi, visual). Derived from `TRANSPORT_KINDS` in
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
  let commandCount = 0;
  const countedSites = new Set<string>();
  const dynamicSites = new Set<string>();

  function countElectronDesktopRegistrations(source: string): number {
    let dynamicCommandCount = 0;
    const re =
      /registerElectronDesktopCommands\(\s*["'`]([^"'`]+)["'`]\s*(?:,\s*(\{[\s\S]*?\})\s*)?\)/g;
    for (const match of source.matchAll(re)) {
      dynamicSites.add(match[1]);
      const options = match[2] ?? "";
      const hasMedia = /\bmedia\s*:/.test(options);
      dynamicCommandCount +=
        ELECTRON_DESKTOP_BASE_COMMAND_COUNT +
        (hasMedia ? ELECTRON_DESKTOP_MEDIA_COMMAND_COUNT : 0);
    }
    return dynamicCommandCount;
  }

  function countAIChatRegistrations(source: string): number {
    let dynamicCommandCount = 0;
    const re =
      /registerAIChatCommands\(\s*["'`][^"'`]+["'`]\s*,\s*(\{[\s\S]*?\})\s*\)/g;
    for (const match of source.matchAll(re)) {
      const options = match[1] ?? "";
      dynamicCommandCount += AI_CHAT_BASE_COMMAND_COUNT;
      if (/\bmodelSelector\s*:/.test(options)) dynamicCommandCount++;
      if (/\bnewChatSelector\s*:/.test(options)) dynamicCommandCount++;
    }
    return dynamicCommandCount;
  }

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
          const hasStaticCli = source.includes("cli(");
          const dynamicCommandCount = countElectronDesktopRegistrations(source);
          const aiChatCommandCount = countAIChatRegistrations(source);
          if (
            !hasStaticCli &&
            dynamicCommandCount === 0 &&
            aiChatCommandCount === 0
          ) {
            continue;
          }
          tsCount++;
          if (hasStaticCli) {
            commandCount++;
            siteHasCommand = true;
          }
          commandCount += dynamicCommandCount + aiChatCommandCount;
        } catch {
          // unreadable — skip
        }
      }
    }

    if (siteHasCommand) countedSites.add(site);
  }
  for (const site of dynamicSites) countedSites.add(site);

  return {
    yaml: yamlCount,
    ts: tsCount,
    sites: countedSites.size,
    commands: commandCount,
  };
}

function countManifestCatalog(): {
  sites: number;
  commands: number;
  categories: number;
} | null {
  if (!existsSync(DIST_MANIFEST)) return null;
  try {
    const manifest = JSON.parse(readFileSync(DIST_MANIFEST, "utf-8")) as {
      sites?: Record<string, { category?: string; commands?: unknown[] }>;
    };
    const sites = manifest.sites ?? {};
    return {
      sites: Object.keys(sites).length,
      commands: Object.values(sites).reduce(
        (sum, site) => sum + (site.commands?.length ?? 0),
        0,
      ),
      categories: new Set(
        Object.values(sites).map((site) => site.category ?? "other"),
      ).size,
    };
  } catch {
    return null;
  }
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
    const timeout = resolveVitestListTimeoutMs(process.env);
    const result = spawnSync(
      "npx",
      ["vitest", "list", "--json", `--project=${project}`],
      {
        cwd: ROOT,
        encoding: "utf-8",
        env: { ...process.env, UNICLI_STATS_PUBLIC: "1" },
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
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

export function resolveVitestListTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.UNICLI_STATS_VITEST_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_VITEST_LIST_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1_000 && n <= 300_000
    ? n
    : DEFAULT_VITEST_LIST_TIMEOUT_MS;
}

function readCommittedTestCount(): number | null {
  if (!existsSync(STATS_JSON)) return null;
  try {
    const stats = JSON.parse(readFileSync(STATS_JSON, "utf-8")) as {
      test_count?: unknown;
    };
    return typeof stats.test_count === "number" ? stats.test_count : null;
  } catch {
    return null;
  }
}

function isInsideVitest(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.VITEST_WORKER_ID !== undefined ||
    process.env.VITEST_POOL_ID !== undefined
  );
}

/**
 * Test-count strategy:
 *   1. If `UNICLI_STATS_TEST_STRATEGY=regex`, force the regex counter.
 *      (Useful in CI sandboxes where vitest cannot spawn.)
 *   2. Inside Vitest, reuse committed stats.json for test_count so the unit
 *      suite never recursively spawns `vitest list` and deadlocks or times out
 *      on slower CI runners.
 *   3. Otherwise try `vitest list --json` per project in public-stats mode; it
 *      expands parametrised tests while excluding ignored local references.
 *   4. On vitest failure, preserve committed stats.json's test_count if
 *      present; this avoids publishing a lower regex count when one project
 *      hangs or times out.
 *   5. Only without committed stats, fall back to the regex counter with a
 *      stderr note so the drift is visible.
 */
function countTests(): number {
  if (process.env.UNICLI_STATS_TEST_STRATEGY === "regex") {
    return countTestsByRegex();
  }
  if (isInsideVitest()) {
    const committed = readCommittedTestCount();
    if (committed !== null) return committed;
  }
  const fromVitest = countTestsViaVitest();
  if (fromVitest !== null) return fromVitest;
  const committed = readCommittedTestCount();
  if (committed !== null) {
    console.error(
      "count-stats: vitest list failed, preserving stats.json test_count",
    );
    return committed;
  }
  console.error(
    "count-stats: vitest list failed, falling back to regex counter",
  );
  return countTestsByRegex();
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
  const transports = new Set<string>();
  if (existsSync(join(MCP_DIR, "server.ts"))) transports.add("stdio");
  if (existsSync(join(MCP_DIR, "http-transport.ts"))) transports.add("http");
  if (existsSync(join(MCP_DIR, "streamable-http.ts"))) {
    transports.add("streamable");
  }
  return transports.size;
}

function countCategories(): number {
  const catalog = countManifestCatalog();
  if (catalog) return catalog.categories;

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
  const catalog = countManifestCatalog();
  const stepSurface = getBuiltInStepSurface();
  return {
    adapter_count_yaml: adapters.yaml,
    adapter_count_ts: adapters.ts,
    adapter_count_total: adapters.yaml + adapters.ts,
    site_count: catalog?.sites ?? adapters.sites,
    command_count: catalog?.commands ?? adapters.commands,
    test_count: countTests(),
    pipeline_step_count: stepSurface.totalCount,
    pipeline_registered_step_count: stepSurface.registeredCount,
    pipeline_transport_step_count: stepSurface.transportNativeCount,
    transport_count: countTransports(),
    app_transport_count: countAppTransports(),
    category_count: catalog?.categories ?? countCategories(),
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
      `${stats.test_count} tests, ${stats.pipeline_step_count} actions ` +
      `(${stats.pipeline_registered_step_count} registered + ${stats.pipeline_transport_step_count} transport-native), ` +
      `${stats.transport_count} MCP transports, ${stats.app_transport_count} app transports, ${stats.category_count} categories`,
  );
}

// Run only when invoked directly
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main();
}
