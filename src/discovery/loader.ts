/**
 * Adapter loader — discovers and registers YAML + TS adapters.
 *
 * Scan order:
 *   1. Built-in adapters from src/adapters/
 *   2. User adapters from ~/.unicli/adapters/
 *   3. Plugin adapters from ~/.unicli/plugins/
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { getAllAdapters, registerAdapter } from "../registry.js";
import { validateAdapterV2 } from "../core/schema-v2.js";
import { compileAll } from "../engine/kernel/compile.js";

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
import type {
  AdapterManifest,
  AdapterCommand,
  AdapterArg,
  AdapterType,
  PipelineStep,
} from "../types.js";

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
const USER_DIR = join(process.env.HOME ?? "~", ".unicli", "adapters");

// detect: field is stored on the adapter manifest for informational purposes.
// It does NOT gate registration. All adapters are always visible and available.
// If a desktop adapter requires a missing binary, the exec step gives a clear
// runtime error with install instructions.

interface YamlAdapter {
  site: string;
  name: string;
  description?: string;
  domain?: string;
  strategy?: string;
  browser?: boolean;
  type?: string;
  binary?: string;
  detect?: string;
  base?: string;
  health?: string;
  auth?: string;
  autoInstall?: string;
  passthrough?: boolean;
  auth_cookies?: string[];
  args?: Record<string, YamlArg>;
  pipeline?: PipelineStep[];
  columns?: string[];
  // Adapter health
  quarantine?: boolean;
  quarantineReason?: string;
  // v0.213.3 Phase 4 — pagination hint emitted by the kernel's next_actions
  // when the command surfaces `meta.pagination.next_cursor`.
  paginated?: boolean;
  // Desktop
  execArgs?: string[];
  // Web
  method?: string;
  path?: string;
  url?: string;
  params?: Record<string, unknown>;
  // Browser
  navigate?: string;
  wait?: string;
  extract?: string;
  output?: string | Record<string, unknown>;
  // schema-v2 required metadata
  capabilities?: string[];
  minimum_capability?: string;
  trust?: string;
  confidentiality?: string;
}

interface YamlArg {
  type?: string;
  default?: unknown;
  required?: boolean;
  positional?: boolean;
  choices?: string[];
  description?: string;
  // v0.213.3 Phase 4 — schema-driven hardening annotations. Propagate these
  // untouched to AdapterArg so the kernel's ajv validator sees the declared
  // format / x-unicli-kind dispatch tokens.
  format?: AdapterArg["format"];
  "x-unicli-kind"?: AdapterArg["x-unicli-kind"];
  "x-unicli-accepts"?: AdapterArg["x-unicli-accepts"];
}

function extractBalancedLiteral(
  source: string,
  openIndex: number,
): string | null {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return null;
}

function objectStringProp(body: string, prop: string): string | undefined {
  const re = new RegExp(`${prop}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`);
  return re.exec(body)?.[1];
}

function objectStrategyProp(body: string): AdapterCommand["strategy"] {
  const literal = objectStringProp(body, "strategy");
  if (literal) return literal as AdapterCommand["strategy"];
  const enumMatch = /\bstrategy\s*:\s*Strategy\.([A-Z_]+)/.exec(body);
  return enumMatch?.[1]?.toLowerCase() as AdapterCommand["strategy"];
}

function objectBoolProp(body: string, prop: string): boolean | undefined {
  const match = new RegExp(`${prop}\\s*:\\s*(true|false)`).exec(body);
  return match ? match[1] === "true" : undefined;
}

function objectStringArrayProp(
  body: string,
  prop: string,
): string[] | undefined {
  const match = new RegExp(`${prop}\\s*:\\s*\\[([\\s\\S]*?)\\]`).exec(body);
  if (!match) return undefined;
  return Array.from(match[1].matchAll(/["'`]([^"'`]+)["'`]/g)).map((m) => m[1]);
}

function objectArgsProp(body: string): AdapterArg[] | undefined {
  const match = /\bargs\s*:\s*\[([\s\S]*?)\]\s*,\s*columns\b/.exec(body);
  if (!match) return undefined;
  const names = Array.from(
    match[1].matchAll(/\bname\s*:\s*["'`]([^"'`]+)["'`]/g),
  ).map((m) => m[1]);
  return names.length > 0
    ? names.map((name) => ({ name, type: "str" }))
    : undefined;
}

function findNextCliCall(source: string, from: number): number {
  let index = from;
  while (true) {
    const candidate = source.indexOf("cli(", index);
    if (candidate < 0) return -1;
    const prev = candidate > 0 ? source[candidate - 1] : "";
    if (!/[A-Za-z0-9_$-]/.test(prev)) return candidate;
    index = candidate + 4;
  }
}

function extractTsCommandStubs(
  site: string,
  siteDir: string,
): {
  commands: Record<string, AdapterCommand>;
  meta: Partial<AdapterManifest>;
} {
  const commands: Record<string, AdapterCommand> = {};
  const meta: Partial<AdapterManifest> = {};
  for (const file of readdirSync(siteDir)) {
    if (!file.endsWith(".ts")) continue;
    if (file.endsWith(".d.ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(join(siteDir, file), "utf-8");
    let index = 0;
    while (true) {
      const callIndex = findNextCliCall(source, index);
      if (callIndex < 0) break;
      const openIndex = source.indexOf("{", callIndex);
      if (openIndex < 0) break;
      const body = extractBalancedLiteral(source, openIndex);
      index = openIndex + Math.max(body?.length ?? 1, 1);
      if (!body) continue;
      const commandSite = objectStringProp(body, "site") ?? site;
      if (commandSite !== site) continue;
      const name = objectStringProp(body, "name");
      if (!name) continue;
      const strategy = objectStrategyProp(body);
      const browser = objectBoolProp(body, "browser");
      const domain = objectStringProp(body, "domain");
      if (domain) meta.domain = domain;
      if (strategy) meta.strategy = strategy;
      if (browser !== undefined) meta.browser = browser;
      commands[name] = {
        name,
        description: objectStringProp(body, "description"),
        strategy,
        browser,
        adapterArgs: objectArgsProp(body),
        columns: objectStringArrayProp(body, "columns"),
      };
    }
  }
  return { commands, meta };
}

/** Load all adapters from a directory */
export function loadAdaptersFromDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;

  for (const site of readdirSync(dir)) {
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
      } catch {
        /* ignore malformed _site.json */
      }
    }

    for (const file of readdirSync(siteDir)) {
      const ext = extname(file);
      const cmdName = basename(file, ext);

      if (ext === ".yaml" || ext === ".yml") {
        let parsed: YamlAdapter;
        const absPath = join(siteDir, file);
        try {
          // Enforce a file-size upper bound BEFORE reading into memory so a
          // hostile adapter can't OOM the loader through a gigabyte-sized
          // YAML. `statSync` is one syscall and avoids touching contents.
          const fileSize = statSync(absPath).size;
          if (fileSize > MAX_YAML_BYTES) {
            console.error(
              `Warning: Skipping oversized YAML ${absPath} (${fileSize} bytes > ${MAX_YAML_BYTES})`,
            );
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
          }) as YamlAdapter;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Warning: Failed to parse ${absPath}: ${msg}`);
          continue;
        }

        // detect: field is stored on the adapter manifest for runtime checks,
        // but does NOT gate registration. All adapters are always visible.
        // Runtime exec step checks binary availability and gives clear errors.

        if (parsed.type) siteType = parsed.type as AdapterType;
        if (parsed.domain) siteMeta.domain = parsed.domain;
        if (parsed.strategy)
          siteMeta.strategy = parsed.strategy as AdapterManifest["strategy"];
        if (parsed.browser !== undefined) siteMeta.browser = parsed.browser;
        if (parsed.binary) siteMeta.binary = parsed.binary;
        if (parsed.base) siteMeta.base = parsed.base;
        if (parsed.detect) siteMeta.detect = parsed.detect;
        if (parsed.auth) siteMeta.auth = parsed.auth as AdapterManifest["auth"];
        if (parsed.autoInstall) siteMeta.autoInstall = parsed.autoInstall;
        if (parsed.passthrough !== undefined)
          siteMeta.passthrough = parsed.passthrough;
        if (parsed.auth_cookies) siteMeta.authCookies = parsed.auth_cookies;

        // Skip underscore-prefixed files (internal/metadata, not commands)
        if (cmdName.startsWith("_")) continue;

        // schema-v2 hard gate: every YAML must satisfy the v2 contract
        // before it's registered. We validate the FULL parsed object (not a
        // five-field projection) so legacy fields like `pipeline`, `url`,
        // `params` get type-checked too — a `pipeline:"string"` typo is a
        // runtime crash and must fail the gate, not be silently carried
        // through. The defaults for `capabilities`, `minimum_capability`,
        // `trust`, `confidentiality`, `quarantine` are filled via
        // {@link migrateToV2} for backward compatibility; if the YAML
        // already has them, they win.
        const v2Candidate: Record<string, unknown> = {
          ...(parsed as unknown as Record<string, unknown>),
          name: cmdName,
          capabilities: Array.isArray(parsed.capabilities)
            ? parsed.capabilities
            : [],
          minimum_capability:
            typeof parsed.minimum_capability === "string"
              ? parsed.minimum_capability
              : "http.fetch",
          trust: typeof parsed.trust === "string" ? parsed.trust : "public",
          confidentiality:
            typeof parsed.confidentiality === "string"
              ? parsed.confidentiality
              : "public",
          quarantine:
            typeof parsed.quarantine === "boolean" ? parsed.quarantine : false,
        };
        const v2Result = validateAdapterV2(v2Candidate);
        if (!v2Result.ok) {
          const rel = join(site, file);
          const msg = `schema-v2 violation in ${rel}: ${v2Result.error}`;
          if (SCHEMA_MODE === "strict") {
            console.error(msg);
            process.exit(78); // sysexits.h EX_CONFIG
          }
          // warn mode: ALWAYS write to stderr — the hard-gate claim in
          // §1.7 of the FINAL plan (2026-04-14-v212-rethink) is that
          // operators see every violation, not just those running with
          // UNICLI_DEBUG=1. Silent warnings are what let the "gate is
          // theatre" regression slip through the first time.
          console.error(`Warning: ${msg}`);
        }

        // Parse args from YAML into AdapterArg[]
        let adapterArgs: AdapterArg[] | undefined;
        if (parsed.args) {
          adapterArgs = Object.entries(parsed.args).map(
            ([argName, argDef]) => ({
              name: argName,
              type: (argDef.type as AdapterArg["type"]) ?? "str",
              default: argDef.default,
              required: argDef.required ?? false,
              positional: argDef.positional ?? false,
              choices: argDef.choices,
              description: argDef.description,
              format: argDef.format,
              "x-unicli-kind": argDef["x-unicli-kind"],
              "x-unicli-accepts": argDef["x-unicli-accepts"],
            }),
          );
        }

        commands[cmdName] = {
          name: cmdName,
          description: parsed.description,
          pipeline: parsed.pipeline,
          adapterArgs,
          strategy: parsed.strategy as AdapterCommand["strategy"],
          browser: parsed.browser,
          columns: parsed.columns,
          method: parsed.method as AdapterCommand["method"],
          path: parsed.path,
          url: parsed.url,
          params: parsed.params,
          navigate: parsed.navigate,
          wait: parsed.wait,
          extract: parsed.extract,
          execArgs: parsed.execArgs,
          quarantine: parsed.quarantine === true ? true : undefined,
          quarantineReason: parsed.quarantineReason,
          minimum_capability: parsed.minimum_capability,
          paginated: parsed.paginated === true ? true : undefined,
        };
        count++;
      }
    }

    const tsStubs = extractTsCommandStubs(site, siteDir);
    for (const [name, command] of Object.entries(tsStubs.commands)) {
      commands[name] = command;
      count++;
    }
    siteMeta = { ...siteMeta, ...tsStubs.meta };

    if (Object.keys(commands).length > 0) {
      registerAdapter({
        name: site,
        type: siteType,
        commands,
        ...siteMeta,
      });
    }
  }

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
export function loadAllAdapters(): number {
  let total = 0;
  total += loadAdaptersFromDir(BUILTIN_YAML_DIR);
  total += loadAdaptersFromDir(USER_DIR);
  // Prime the kernel cache for every registered adapter so CLI / MCP / ACP
  // surfaces look up CompiledCommand entries in O(1). Safe to run again
  // after loadTsAdapters — compileAll clears + refills.
  primeKernelCache();
  return total;
}

/** Load TS/JS adapters that self-register via cli() */
export async function loadTsAdapters(): Promise<number> {
  tsAdapterLoadGeneration++;
  const files = [
    ...collectTsFiles(BUILTIN_TS_DIR),
    ...collectTsFiles(USER_DIR),
  ];
  let count = 0;
  for (const file of files) {
    try {
      await import(
        `${pathToFileURL(file).href}?unicli_ts_load=${tsAdapterLoadGeneration}`
      );
      count++;
    } catch (err) {
      if (process.env.UNICLI_DEBUG) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: Failed to import ${file}: ${msg}`);
      }
    }
  }
  // Re-prime now that TS-registered adapters are in the registry too.
  primeKernelCache();
  return count;
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
