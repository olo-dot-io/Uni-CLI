/**
 * Build manifest — generates a JSON manifest of all available adapters.
 * Used for documentation and IDE integration.
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

if (existsSync(ADAPTERS_DIR)) {
  for (const site of readdirSync(ADAPTERS_DIR)) {
    const siteDir = join(ADAPTERS_DIR, site);
    if (!statSync(siteDir).isDirectory()) continue;

    const commands = [];
    for (const file of readdirSync(siteDir)) {
      if (extname(file) !== ".yaml" && extname(file) !== ".yml") continue;
      try {
        const raw = readFileSync(join(siteDir, file), "utf-8");
        const parsed = yaml.load(raw);
        commands.push({
          name: basename(file, extname(file)),
          description: parsed.description || "",
          strategy: parsed.strategy || "public",
          type: parsed.type || "web-api",
        });
      } catch {
        // Skip malformed YAML
      }
    }

    if (commands.length > 0) {
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
