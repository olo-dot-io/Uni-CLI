/**
 * Build manifest — generates a JSON manifest of all available adapters.
 * Used for documentation and IDE integration.
 *
 * Scans both YAML files (parsed directly) and TS files (regex extraction
 * of cli() metadata) to produce a complete manifest.
 */

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "src", "adapters");
const OUTPUT = join(__dirname, "..", "dist", "manifest.json");
const PKG = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);

const manifest = { version: PKG.version, sites: {} };

// Helper: extract a string property from a cli() call source
function extractProp(source, prop) {
  // Match: prop: "value" or prop: 'value'
  const re = new RegExp(`${prop}:\\s*["'\`]([^"'\`]+)["'\`]`);
  const m = source.match(re);
  return m ? m[1] : "";
}

// Helper: extract Strategy.XXX from source
function extractStrategy(source) {
  const m = source.match(/strategy:\s*Strategy\.(\w+)/);
  if (m) return m[1].toLowerCase();
  const m2 = source.match(/strategy:\s*["'](\w+)["']/);
  return m2 ? m2[1] : "public";
}

// TS files that are utilities, not commands (no cli() call)
const SKIP_FILES = new Set(["client", "wbi", "innertube", "index"]);

if (existsSync(ADAPTERS_DIR)) {
  for (const site of readdirSync(ADAPTERS_DIR)) {
    if (site.startsWith("_") || site.startsWith(".")) continue;
    const siteDir = join(ADAPTERS_DIR, site);
    if (!statSync(siteDir).isDirectory()) continue;

    const commands = [];

    for (const file of readdirSync(siteDir)) {
      const ext = extname(file);
      const cmdName = basename(file, ext);

      if (ext === ".yaml" || ext === ".yml") {
        // Parse YAML adapter
        try {
          const raw = readFileSync(join(siteDir, file), "utf-8");
          const parsed = yaml.load(raw);
          commands.push({
            name: cmdName,
            description: parsed.description || "",
            strategy: parsed.strategy || "public",
            type: parsed.type || "web-api",
          });
        } catch {
          // Skip malformed YAML
        }
      } else if (ext === ".ts" && !SKIP_FILES.has(cmdName)) {
        // Parse TS adapter — extract cli() metadata via regex
        try {
          const source = readFileSync(join(siteDir, file), "utf-8");
          // Only include files that call cli()
          if (!source.includes("cli(")) continue;

          const name = extractProp(source, "name") || cmdName;
          const description = extractProp(source, "description");
          const strategy = extractStrategy(source);

          commands.push({
            name,
            description,
            strategy,
            type: "web-api",
          });
        } catch {
          // Skip unreadable TS files
        }
      }
    }

    if (commands.length > 0) {
      // Sort commands by name for stable output
      commands.sort((a, b) => a.name.localeCompare(b.name));
      manifest.sites[site] = { commands };
    }
  }
}

writeFileSync(OUTPUT, JSON.stringify(manifest, null, 2));
const siteCount = Object.keys(manifest.sites).length;
const cmdCount = Object.values(manifest.sites).reduce(
  (sum, s) => sum + s.commands.length,
  0,
);
console.log(
  `Manifest: ${siteCount} sites, ${cmdCount} commands → dist/manifest.json`,
);
