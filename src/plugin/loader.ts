/**
 * Plugin Loader — discovers and loads third-party plugins from ~/.unicli/plugins/.
 *
 * Each plugin directory may contain a `unicli-plugin.json` manifest that declares:
 *   - adapters directory (YAML adapters loaded via discovery/loader)
 *   - steps directory (custom pipeline steps)
 *   - main entry point (JS file executed at startup)
 *
 * Plugins without a manifest are treated as legacy adapter-only plugins and
 * are loaded by the existing src/plugin.ts system.
 */

import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export interface PluginManifest {
  name: string;
  version: string;
  unicli?: string; // semver range for compatibility
  description?: string;
  adapters?: string; // relative path to adapters dir
  steps?: string; // relative path to steps dir
  main?: string; // entry point JS file
}

const PLUGINS_DIR = join(homedir(), ".unicli", "plugins");

/**
 * Discover and load all installed plugins that have a unicli-plugin.json manifest.
 * Returns names of loaded plugins and any errors encountered.
 */
export async function loadPlugins(): Promise<{
  loaded: string[];
  errors: string[];
}> {
  const loaded: string[] = [];
  const errors: string[] = [];

  if (!existsSync(PLUGINS_DIR)) return { loaded, errors };

  const dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => d.name);

  for (const dir of dirs) {
    const pluginDir = join(PLUGINS_DIR, dir);
    const manifestPath = join(pluginDir, "unicli-plugin.json");

    // Skip plugins without a manifest — they are handled by src/plugin.ts
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(raw) as PluginManifest;

      // Load adapters if the manifest declares an adapters directory
      if (manifest.adapters) {
        const adaptersDir = resolve(pluginDir, manifest.adapters);
        // Guard against path traversal
        if (
          !adaptersDir.startsWith(pluginDir + sep) &&
          adaptersDir !== pluginDir
        ) {
          errors.push(`${dir}: adapters path escapes plugin directory`);
          continue;
        }
        if (existsSync(adaptersDir)) {
          const { loadAdaptersFromDir } =
            await import("../discovery/loader.js");
          loadAdaptersFromDir(adaptersDir);
        }
      }

      // Load entry point if specified (registers hooks, steps, etc.)
      if (manifest.main) {
        const mainPath = resolve(pluginDir, manifest.main);
        // Guard against path traversal
        if (!mainPath.startsWith(pluginDir + sep) && mainPath !== pluginDir) {
          errors.push(`${dir}: main path escapes plugin directory`);
          continue;
        }
        if (existsSync(mainPath)) {
          await import(pathToFileURL(mainPath).href);
        }
      }

      loaded.push(manifest.name);
    } catch (err) {
      errors.push(
        `${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { loaded, errors };
}

/**
 * List plugins that have a unicli-plugin.json manifest.
 */
export function listManifestPlugins(): PluginManifest[] {
  if (!existsSync(PLUGINS_DIR)) return [];

  const plugins: PluginManifest[] = [];
  const dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true }).filter(
    (d) => d.isDirectory() || d.isSymbolicLink(),
  );

  for (const dir of dirs) {
    const manifestPath = join(PLUGINS_DIR, dir.name, "unicli-plugin.json");
    try {
      const raw = readFileSync(manifestPath, "utf-8");
      plugins.push(JSON.parse(raw) as PluginManifest);
    } catch {
      // Skip plugins without a valid manifest
    }
  }

  return plugins;
}

/**
 * Scaffold a new plugin directory with a unicli-plugin.json manifest.
 * Returns the absolute path to the created directory.
 */
export function createPlugin(name: string, destDir?: string): string {
  const dir = destDir ?? join(process.cwd(), `unicli-plugin-${name}`);
  mkdirSync(join(dir, "adapters"), { recursive: true });
  mkdirSync(join(dir, "steps"), { recursive: true });

  const manifest: PluginManifest = {
    name,
    version: "1.0.0",
    unicli: ">=0.206.0",
    description: `${name} plugin for Uni-CLI`,
    adapters: "adapters/",
    steps: "steps/",
  };

  writeFileSync(
    join(dir, "unicli-plugin.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
  writeFileSync(
    join(dir, "README.md"),
    `# unicli-plugin-${name}\n\nA Uni-CLI plugin.\n`,
    "utf-8",
  );

  return dir;
}
