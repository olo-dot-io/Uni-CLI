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
import { registerAdapter } from "../registry.js";
import type {
  AdapterManifest,
  AdapterCommand,
  AdapterArg,
  AdapterType,
  PipelineStep,
} from "../types.js";

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
}

interface YamlArg {
  type?: string;
  default?: unknown;
  required?: boolean;
  positional?: boolean;
  choices?: string[];
  description?: string;
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

    for (const file of readdirSync(siteDir)) {
      const ext = extname(file);
      const cmdName = basename(file, ext);

      if (ext === ".yaml" || ext === ".yml") {
        let parsed: YamlAdapter;
        try {
          const raw = readFileSync(join(siteDir, file), "utf-8");
          parsed = yaml.load(raw) as YamlAdapter;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (process.env.UNICLI_DEBUG) {
            console.error(
              `Warning: Failed to parse ${join(siteDir, file)}: ${msg}`,
            );
          }
          continue;
        }

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
            }),
          );
        }

        commands[cmdName] = {
          name: cmdName,
          description: parsed.description,
          pipeline: parsed.pipeline,
          adapterArgs,
          columns: parsed.columns,
          method: parsed.method as AdapterCommand["method"],
          path: parsed.path,
          url: parsed.url,
          params: parsed.params,
          navigate: parsed.navigate,
          wait: parsed.wait,
          extract: parsed.extract,
          execArgs: parsed.execArgs,
        };
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
  return total;
}

/** Load TS/JS adapters that self-register via cli() */
export async function loadTsAdapters(): Promise<number> {
  const files = [
    ...collectTsFiles(BUILTIN_TS_DIR),
    ...collectTsFiles(USER_DIR),
  ];
  let count = 0;
  for (const file of files) {
    try {
      await import(pathToFileURL(file).href);
      count++;
    } catch (err) {
      if (process.env.UNICLI_DEBUG) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Warning: Failed to import ${file}: ${msg}`);
      }
    }
  }
  return count;
}

/**
 * Exposed for diagnostics / tests: resolved built-in adapter directories.
 */
export function getBuiltinDirs(): { yamlDir: string; tsDir: string } {
  return { yamlDir: BUILTIN_YAML_DIR, tsDir: BUILTIN_TS_DIR };
}
