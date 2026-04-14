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
 *   test_count           — vitest `it(...)` / `test(...)` invocations under
 *                          tests/ (unit + adapter projects)
 *   pipeline_step_count  — distinct step `case "..."` arms in
 *                          src/engine/yaml-runner.ts
 *   transport_count      — MCP transports shipped (stdio + streamable-http
 *                          + sse + ...); read from src/mcp/ entry files
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
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ADAPTERS_DIR = join(ROOT, "src", "adapters");
const TESTS_DIR = join(ROOT, "tests");
const YAML_RUNNER = join(ROOT, "src", "engine", "yaml-runner.ts");
const MCP_DIR = join(ROOT, "src", "mcp");
const BUILD_MANIFEST = join(ROOT, "scripts", "build-manifest.js");

export interface Stats {
  adapter_count_yaml: number;
  adapter_count_ts: number;
  adapter_count_total: number;
  site_count: number;
  command_count: number;
  test_count: number;
  pipeline_step_count: number;
  transport_count: number;
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

function countTests(): number {
  if (!existsSync(TESTS_DIR)) return 0;
  let count = 0;
  // Patterns:
  //   it("..."
  //   it('...'
  //   test("..."
  //   test('...'
  const IT = /\b(?:it|test)\s*\(\s*["'`]/g;

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
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
  return count;
}

function countPipelineSteps(): number {
  if (!existsSync(YAML_RUNNER)) return 0;
  const source = readFileSync(YAML_RUNNER, "utf-8");

  // Isolate the first big switch (the pipeline dispatcher) to avoid
  // counting `case` arms inside nested helper switches. The dispatcher
  // lives inside `executeStep` — scan until the matching closing brace
  // via a simple counter.
  const anchor = source.indexOf("async function executeStep");
  if (anchor < 0) return 0;
  const switchIdx = source.indexOf("switch", anchor);
  if (switchIdx < 0) return 0;
  const braceIdx = source.indexOf("{", switchIdx);
  if (braceIdx < 0) return 0;

  let depth = 0;
  let end = braceIdx;
  for (let i = braceIdx; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  const block = source.slice(braceIdx, end);
  const steps = new Set<string>();
  const re = /case\s+"([a-z_][a-z0-9_]*)":/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    steps.add(m[1]);
  }
  return steps.size;
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
      `${stats.transport_count} transports, ${stats.category_count} categories`,
  );
}

// Run only when invoked directly
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main();
}
