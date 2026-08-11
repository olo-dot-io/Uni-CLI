/**
 * Plugin Loader — discovers and loads third-party plugins from ~/.unicli/plugins/.
 *
 * Each plugin directory may contain the portable Agent Plugins `plugin.json`
 * and the Uni-CLI runtime extension `unicli-plugin.json`.
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
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertAgentPluginName,
  inspectAgentPlugin,
  registerAgentPluginSkills,
  UNICLI_AGENT_PLUGIN_NAMESPACE,
  type AgentPluginInspection,
} from "./agent-plugin.js";
import { registerPluginSkills } from "../protocol/skill.js";
import { primeKernelCache } from "../discovery/loader.js";
import { userDataRoot } from "../engine/user-home.js";

export interface PluginManifest {
  name: string;
  version: string;
  unicli?: string; // semver range for compatibility
  description?: string;
  adapters?: string; // relative path to adapters dir
  steps?: string; // relative path to steps dir
  main?: string; // entry point JS file
}

export function installedPluginsDir(): string {
  return join(userDataRoot(), "plugins");
}

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

  const pluginsDir = installedPluginsDir();
  if (!existsSync(pluginsDir)) return { loaded, errors };

  const dirs = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => d.name)
    .sort();

  for (const dir of dirs) {
    const pluginDir = join(pluginsDir, dir);
    let manifestPath = join(pluginDir, "unicli-plugin.json");
    const portableManifestPath = join(pluginDir, "plugin.json");

    let loadedName: string | undefined;
    if (existsSync(portableManifestPath)) {
      try {
        const inspection = inspectAgentPlugin(pluginDir);
        registerAgentPluginSkills(inspection);
        registerPluginSkills(inspection.skills);
        loadedName = inspection.manifest.name;
        const extension =
          inspection.manifest.extensions?.[UNICLI_AGENT_PLUGIN_NAMESPACE];
        if (extension) {
          const declaredManifest = extension.manifest;
          if (
            typeof declaredManifest !== "string" ||
            declaredManifest.trim().length === 0
          ) {
            errors.push(
              `${dir}: ${UNICLI_AGENT_PLUGIN_NAMESPACE}.manifest must be a relative file path`,
            );
            continue;
          }
          try {
            manifestPath = containedPluginFile(
              inspection.root,
              declaredManifest,
            );
          } catch (error) {
            errors.push(
              `${dir}: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }
        }
        for (const issue of inspection.issues) {
          errors.push(`${dir}: ${issue.component}: ${issue.message}`);
        }
      } catch (err) {
        errors.push(
          `${dir}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }

    if (!existsSync(manifestPath)) {
      if (loadedName) loaded.push(loadedName);
      continue;
    }

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

  primeKernelCache();

  return { loaded: [...new Set(loaded)], errors };
}

function containedPluginFile(root: string, declaredPath: string): string {
  const candidate = resolve(root, declaredPath);
  if (!existsSync(candidate)) {
    throw new Error(`runtime manifest does not exist: ${declaredPath}`);
  }
  const resolved = realpathSync(candidate);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("runtime manifest path escapes plugin directory");
  }
  return resolved;
}

/** List installed packages that conform to Agent Plugins 1.0. */
export function listPortablePlugins(): AgentPluginInspection[] {
  const pluginsDir = installedPluginsDir();
  if (!existsSync(pluginsDir)) return [];
  const plugins: AgentPluginInspection[] = [];
  for (const dir of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
    const root = join(pluginsDir, dir.name);
    if (!existsSync(join(root, "plugin.json"))) continue;
    try {
      plugins.push(inspectAgentPlugin(root));
    } catch {
      continue;
    }
  }
  return plugins.sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  );
}

/**
 * List plugins that have a unicli-plugin.json manifest.
 */
export function listManifestPlugins(): PluginManifest[] {
  const pluginsDir = installedPluginsDir();
  if (!existsSync(pluginsDir)) return [];

  const plugins: PluginManifest[] = [];
  const dirs = readdirSync(pluginsDir, { withFileTypes: true }).filter(
    (d) => d.isDirectory() || d.isSymbolicLink(),
  );

  for (const dir of dirs) {
    const manifestPath = join(pluginsDir, dir.name, "unicli-plugin.json");
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
  assertAgentPluginName(name);
  const dir = destDir ?? join(process.cwd(), `unicli-plugin-${name}`);
  mkdirSync(join(dir, "adapters"), { recursive: true });
  mkdirSync(join(dir, "steps"), { recursive: true });
  mkdirSync(join(dir, "skills", "example"), { recursive: true });

  const manifest: PluginManifest = {
    name,
    version: "1.0.0",
    unicli: ">=1.2.0",
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
    join(dir, "plugin.json"),
    JSON.stringify(
      {
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name,
        version: "1.0.0",
        description: `${name} Agent Plugin`,
        extensions: {
          "dev.unicli": { manifest: "./unicli-plugin.json" },
        },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  writeFileSync(
    join(dir, "skills", "example", "SKILL.md"),
    [
      "---",
      "name: example",
      `description: Example portable skill from ${name}`,
      "---",
      "",
      "Describe when an agent should use this capability.",
      "",
    ].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(dir, "README.md"),
    `# unicli-plugin-${name}\n\nA Uni-CLI plugin.\n`,
    "utf-8",
  );

  return dir;
}
