/**
 * @owner src/discovery/loader.ts
 * @does Discovers YAML and TypeScript adapters, validates adapter metadata, stamps source paths, and registers commands.
 * @needs fs, path, js-yaml, src/registry, src/core/schema-v2, src/engine/kernel/compile, src/discovery/macos-dynamic
 * @feeds src/cli.ts, src/discovery/search.ts, MCP and ACP command surfaces, tests/unit/loader.test.ts
 * @breaks Strict loads fail with typed aggregate diagnostics; non-strict runtime loads retain the same diagnostics for doctor without corrupting command output.
 * @invariants Registered file-backed commands carry repairable source paths; YAML files are size bounded before parsing.
 * @side-effects Reads adapter files, imports TS/JS adapter modules, mutates the registry, and primes the invocation kernel cache.
 * @perf O(adapter files) startup scan; YAML parsing is capped by MAX_YAML_BYTES.
 * @concurrency Loader imports TS adapters sequentially so registry source-path context cannot cross-contaminate commands.
 * @test tests/unit/loader.test.ts, tests/unit/loader-parity.test.ts
 * @stability stable
 * @since 2026-05-26
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, extname, basename, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";
import {
  getAllAdapters,
  registerAdapter,
  withAdapterSourcePath,
} from "../registry.js";
import { compileAll } from "../engine/kernel/compile.js";
import { registerMacosDynamicCommands } from "./macos-dynamic.js";
import {
  normalizeYamlAdapterDocument,
  yamlSiteMetadata,
  type YamlAdapterDocument,
} from "../core/yaml-adapter.js";
import { userAdapterRoot } from "../engine/user-home.js";

/**
 * Upper bound on YAML adapter file size. A legitimate YAML adapter is
 * under 4 KiB; 256 KiB leaves headroom for generated or commented files
 * while capping the worst case where a pathological file (billion-laughs
 * anchor expansion, runaway template, attacker-controlled user dir) could
 * OOM the loader. Files above this threshold are skipped with a stderr
 * warning rather than parsed.
 */
const MAX_YAML_BYTES = 256 * 1024;
let tsAdapterLoadGeneration = 0;
let lastTsAdapterLoadFailures: AdapterLoadFailure[] = [];
let lastYamlAdapterLoadFailures: AdapterLoadFailure[] = [];
import type { AdapterManifest, AdapterCommand, AdapterType } from "../types.js";

export class AdapterLoadError extends Error {
  constructor(
    readonly code: AdapterLoadFailureCode,
    message: string,
    readonly adapter_path: string,
  ) {
    super(message);
    this.name = "AdapterLoadError";
  }
}

export type AdapterLoadFailureCode =
  | "adapter_schema_invalid"
  | "adapter_metadata_invalid"
  | "adapter_import_failed";

export interface AdapterLoadFailure {
  code: AdapterLoadFailureCode;
  adapter_path: string;
  message: string;
}

/**
 * Environment flag — when set to `warn`, a failed schema-v2 validation
 * during adapter load emits a stderr warning but keeps loading. Default
 * `strict` aborts with exit code 78 (CONFIG_ERROR) on any violation —
 * the hard gate guarantees every registered adapter carries all five
 * required v2 metadata fields. Set `UNICLI_SCHEMA=warn` to relax during
 * a migration window.
 */
const SCHEMA_MODE = (process.env.UNICLI_SCHEMA ?? "strict").toLowerCase();

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Directory resolution — two different concerns:
 *
 *   1. YAML adapters are source-only assets. They ship in `src/adapters/`
 *      per the package.json `files` field, NOT in `dist/`, because `tsc`
 *      does not copy YAML files. We therefore prefer `src/adapters/`
 *      whenever it exists, which works both in dev (running from the repo)
 *      and in a globally installed package (`node_modules/@zenalexa/unicli/src/adapters/`).
 *
 *   2. TS adapters need to be imported as ES modules. In dev the source
 *      lives at `src/adapters/*.ts` and is loaded via tsx. In production
 *      the compiled `.js` files live at `dist/adapters/*.js`. We pick
 *      whichever directory has the matching extension available.
 *
 * The `__dirname` trick: in dev, `import.meta.url` resolves inside
 * `src/discovery/`; in prod it resolves inside `dist/discovery/`. We
 * climb out to the package root and look for siblings.
 */
function findAdapterDirs(): { yamlDir: string; tsDir: string } {
  // Dev layout: <pkg>/src/discovery → <pkg>/src/adapters
  // Prod layout: <pkg>/dist/discovery → <pkg>/src/adapters (for yaml)
  //                                   → <pkg>/dist/adapters (for js)
  const candidates = [
    join(__dirname, "..", "adapters"), // dev: src/adapters OR prod: dist/adapters
    join(__dirname, "..", "..", "src", "adapters"), // prod: src/adapters sibling
  ];

  // YAML dir: prefer whichever candidate actually contains yaml files.
  let yamlDir = candidates[0];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const hasYaml = readdirSync(dir, { withFileTypes: true }).some((e) => {
      if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith("."))
        return false;
      try {
        return readdirSync(join(dir, e.name)).some(
          (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
        );
      } catch {
        return false;
      }
    });
    if (hasYaml) {
      yamlDir = dir;
      break;
    }
  }

  // TS/JS dir: first candidate that exists. This is the same as dev for both
  // paths and becomes `dist/adapters` in prod builds.
  const tsDir = candidates.find((d) => existsSync(d)) ?? candidates[0];

  return { yamlDir, tsDir };
}

const { yamlDir: BUILTIN_YAML_DIR, tsDir: BUILTIN_TS_DIR } = findAdapterDirs();
function userDirectory(): string {
  return userAdapterRoot();
}

function adapterSourcePath(absPath: string): string {
  const normalized = absPath.split(sep).join("/");
  const sourceMarker = "/src/adapters/";
  const sourceIndex = normalized.lastIndexOf(sourceMarker);
  if (sourceIndex >= 0) {
    return `src/adapters/${normalized.slice(sourceIndex + sourceMarker.length)}`;
  }
  const distMarker = "/dist/adapters/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    return `dist/adapters/${normalized.slice(distIndex + distMarker.length)}`;
  }
  const userMarker = "/.unicli/adapters/";
  const userIndex = normalized.lastIndexOf(userMarker);
  if (userIndex >= 0) {
    return normalized;
  }
  return absPath;
}

// detect: field is stored on the adapter manifest for informational purposes.
// It does NOT gate registration. All adapters are always visible and available.
// If a desktop adapter requires a missing binary, the exec step gives a clear
// runtime error with install instructions.

/** Load all adapters from a directory */
export function loadAdaptersFromDir(
  dir: string,
  sourceTier?: AdapterCommand["source_tier"],
  options: { strict?: boolean } = {},
): number {
  if (!existsSync(dir)) {
    lastYamlAdapterLoadFailures = [];
    return 0;
  }
  const resolvedSourceTier =
    sourceTier ??
    (dir === BUILTIN_YAML_DIR || dir === BUILTIN_TS_DIR
      ? "packaged"
      : dir === userDirectory() ||
          dir.split(sep).join("/").includes("/.unicli/adapters")
        ? "user"
        : "runtime");
  let count = 0;
  const failures: AdapterLoadFailure[] = [];

  siteLoop: for (const site of readdirSync(dir)) {
    if (site.startsWith("_") || site.startsWith(".")) continue;
    const siteDir = join(dir, site);
    if (!statSync(siteDir).isDirectory()) continue;

    const commands: Record<string, AdapterCommand> = {};
    let siteType: AdapterType = "web-api" as AdapterType;
    let siteMeta: Partial<AdapterManifest> = {};

    // Load site-level metadata from _site.json if present
    const siteJsonPath = join(siteDir, "_site.json");
    if (existsSync(siteJsonPath)) {
      try {
        const meta = JSON.parse(readFileSync(siteJsonPath, "utf-8"));
        if (meta.type) siteType = meta.type as AdapterType;
        if (meta.domain) siteMeta.domain = meta.domain;
        if (meta.strategy)
          siteMeta.strategy = meta.strategy as AdapterManifest["strategy"];
        if (meta.binary) siteMeta.binary = meta.binary;
        if (meta.detect) siteMeta.detect = meta.detect;
        if (meta.auth_cookies) siteMeta.authCookies = meta.auth_cookies;
      } catch (error) {
        failures.push({
          code: "adapter_metadata_invalid",
          message: `Invalid adapter metadata ${siteJsonPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          adapter_path: adapterSourcePath(siteJsonPath),
        });
        continue siteLoop;
      }
    }

    for (const file of readdirSync(siteDir)) {
      const ext = extname(file);
      const cmdName = basename(file, ext);

      if (ext === ".yaml" || ext === ".yml") {
        let parsed: YamlAdapterDocument;
        const absPath = join(siteDir, file);
        try {
          // Enforce a file-size upper bound BEFORE reading into memory so a
          // hostile adapter can't OOM the loader through a gigabyte-sized
          // YAML. `statSync` is one syscall and avoids touching contents.
          const fileSize = statSync(absPath).size;
          if (fileSize > MAX_YAML_BYTES) {
            failures.push({
              code: "adapter_schema_invalid",
              adapter_path: adapterSourcePath(absPath),
              message: `Adapter YAML exceeds ${MAX_YAML_BYTES} bytes (${fileSize} bytes).`,
            });
            continue;
          }
          const raw = readFileSync(absPath, "utf-8");
          // Use CORE_SCHEMA (no JS type tags) + strict schema-style loading.
          // js-yaml exposes anchor/alias expansion in all schemas, but
          // CORE_SCHEMA blocks `!!js/function`/`!!js/regexp`/`!!js/undefined`
          // tags that would let a YAML author execute arbitrary JS on load.
          // Anchor-expansion bombs (billion-laughs) are defused by the size
          // cap above — the expanded tree can't exceed the input size by
          // more than the alias depth, so 256 KiB input → bounded RAM use.
          parsed = yaml.load(raw, {
            schema: yaml.CORE_SCHEMA,
            filename: absPath,
          }) as YamlAdapterDocument;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failures.push({
            code: "adapter_schema_invalid",
            adapter_path: adapterSourcePath(absPath),
            message: `Failed to parse adapter YAML: ${msg}`,
          });
          continue;
        }

        // detect: field is stored on the adapter manifest for runtime checks,
        // but does NOT gate registration. All adapters are always visible.
        // Runtime exec step checks binary availability and gives clear errors.

        const normalizedSite = yamlSiteMetadata(parsed);
        if (normalizedSite.type) siteType = normalizedSite.type;
        siteMeta = {
          ...siteMeta,
          ...Object.fromEntries(
            Object.entries(normalizedSite.meta).filter(
              ([, value]) => value !== undefined,
            ),
          ),
        };

        // Skip underscore-prefixed files (internal/metadata, not commands)
        if (cmdName.startsWith("_")) continue;

        const normalized = normalizeYamlAdapterDocument(
          parsed,
          cmdName,
          adapterSourcePath(absPath),
          resolvedSourceTier,
        );
        if (!normalized.ok) {
          const rel = join(site, file);
          const msg = `schema-v2 violation in ${rel}: ${normalized.error}`;
          failures.push({
            code: "adapter_schema_invalid",
            adapter_path: adapterSourcePath(absPath),
            message: msg,
          });
          continue;
        }
        commands[cmdName] = normalized.command;
        count++;
      }
    }

    if (Object.keys(commands).length > 0) {
      registerAdapter({
        name: site,
        type: siteType,
        commands,
        ...siteMeta,
      });
    }
  }

  lastYamlAdapterLoadFailures = failures;
  const strict = options.strict ?? SCHEMA_MODE === "strict";
  if (strict && failures.length > 0) throw aggregateLoadError(failures);
  return count;
}

/**
 * Collect adapter entry-point files for dynamic import.
 *
 * In dev (src/adapters) we want `.ts` files. In prod (dist/adapters) we want
 * `.js` files. Critically we MUST exclude `.d.ts` declaration files:
 * `extname('foo.d.ts')` returns `.ts`, so a naive check catches them and
 * imports them as empty ES modules — silently inflating the "loaded
 * adapters" count while registering nothing.
 */
function collectTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  // Pick the entry-point extension by probing the first site directory.
  // If we find `.js` files, we're in prod (dist/adapters); otherwise use `.ts`.
  let entryExt: ".ts" | ".js" = ".ts";
  for (const probe of readdirSync(dir)) {
    if (probe.startsWith("_") || probe.startsWith(".")) continue;
    const probeDir = join(dir, probe);
    if (!statSync(probeDir).isDirectory()) continue;
    const hasJs = readdirSync(probeDir).some(
      (f) =>
        f.endsWith(".js") && !f.endsWith(".d.ts") && !f.endsWith(".test.js"),
    );
    if (hasJs) {
      entryExt = ".js";
      break;
    }
  }

  for (const site of readdirSync(dir)) {
    if (site.startsWith("_") || site.startsWith(".")) continue;
    const siteDir = join(dir, site);
    if (!statSync(siteDir).isDirectory()) continue;
    for (const file of readdirSync(siteDir)) {
      // Always skip declaration files and sourcemaps
      if (file.endsWith(".d.ts")) continue;
      if (file.endsWith(".d.ts.map")) continue;
      if (file.endsWith(".js.map")) continue;
      if (file.endsWith(".test.ts")) continue;
      if (file.endsWith(".test.js")) continue;
      if (extname(file) === entryExt) {
        files.push(join(siteDir, file));
      }
    }
  }
  return files;
}

/** Load all adapters: built-in YAML → user YAML → TS adapters (async) */
export function loadAllAdapters(options: { strict?: boolean } = {}): number {
  let total = 0;
  const failures: AdapterLoadFailure[] = [];
  total += loadAdaptersFromDir(BUILTIN_YAML_DIR, "packaged", {
    strict: false,
  });
  failures.push(...lastYamlAdapterLoadFailures);
  total += loadAdaptersFromDir(userDirectory(), "user", { strict: false });
  failures.push(...lastYamlAdapterLoadFailures);
  lastYamlAdapterLoadFailures = failures;
  const strict = options.strict ?? SCHEMA_MODE === "strict";
  if (strict && failures.length > 0) throw aggregateLoadError(failures);
  total += registerMacosDynamicCommands();
  // Prime the kernel cache for every registered adapter so CLI / MCP / ACP
  // surfaces look up CompiledCommand entries in O(1). Safe to run again
  // after loadTsAdapters — compileAll clears + refills.
  primeKernelCache();
  return total;
}

/** Load TS/JS adapters that self-register via cli() */
export async function loadTsAdapters(
  options: { strict?: boolean } = {},
): Promise<number> {
  tsAdapterLoadGeneration++;
  const files = [
    ...collectTsFiles(BUILTIN_TS_DIR),
    ...collectTsFiles(userDirectory()),
  ];
  let count = 0;
  const failures: AdapterLoadFailure[] = [];
  for (const file of files) {
    try {
      await withAdapterSourcePath(
        adapterSourcePath(file),
        () =>
          import(
            `${pathToFileURL(file).href}?unicli_ts_load=${tsAdapterLoadGeneration}`
          ),
      );
      count++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({
        code: "adapter_import_failed",
        adapter_path: adapterSourcePath(file),
        message: msg,
      });
    }
  }
  lastTsAdapterLoadFailures = failures;
  if (options.strict && failures.length > 0) {
    throw new AdapterLoadError(
      "adapter_import_failed",
      `Failed to import ${failures.length} adapter module(s): ${failures
        .map((failure) => `${failure.adapter_path}: ${failure.message}`)
        .join("; ")}`,
      failures[0].adapter_path,
    );
  }
  // Re-prime now that TS-registered adapters are in the registry too.
  primeKernelCache();
  return count;
}

export function getAdapterLoadFailures(): readonly AdapterLoadFailure[] {
  return [...lastYamlAdapterLoadFailures, ...lastTsAdapterLoadFailures].map(
    (failure) => ({ ...failure }),
  );
}

function aggregateLoadError(
  failures: readonly AdapterLoadFailure[],
): AdapterLoadError {
  const first = failures[0];
  return new AdapterLoadError(
    first?.code ?? "adapter_schema_invalid",
    `Failed to load ${String(failures.length)} adapter artifact(s): ${failures
      .map((failure) => `${failure.adapter_path}: ${failure.message}`)
      .join("; ")}`,
    first?.adapter_path ?? "unknown",
  );
}

/**
 * Eagerly compile every registered adapter command into the invocation
 * kernel cache. Called at the tail of each loader entry point so subsequent
 * CLI / MCP / ACP dispatch can do a pure Map lookup with no lazy compile.
 * Exposed so tests / long-running processes that mutate the registry can
 * re-prime without re-running the full discovery scan.
 */
export function primeKernelCache(): void {
  compileAll(getAllAdapters());
}

/**
 * Exposed for diagnostics / tests: resolved built-in adapter directories.
 */
export function getBuiltinDirs(): { yamlDir: string; tsDir: string } {
  return { yamlDir: BUILTIN_YAML_DIR, tsDir: BUILTIN_TS_DIR };
}
