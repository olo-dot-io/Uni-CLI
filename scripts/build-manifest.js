/**
 * @owner   scripts/build-manifest.js
 * @does    Build adapter discovery manifests and compact catalog artifacts.
 * @needs   src/adapters YAML files, TypeScript adapter registrations
 * @feeds   dist/manifest.json, dist/manifest-compact.txt
 * @breaks  Stale manifest metadata hides commands from CLI and docs discovery.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SITE_CATEGORIES } from "../src/discovery/aliases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "..", "dist");

mkdirSync(DIST_DIR, { recursive: true });
const PKG = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);

function getCategory(site) {
  return SITE_CATEGORIES.get(site) ?? "other";
}

// ── Capture the authoritative live registry ────────────────────────────────

// Manifest generation executes the same registration code as the runtime.
// A disposable HOME prevents local user overlays from contaminating the
// packaged artifact, and dynamic host discovery is disabled for reproducible
// builds.
const originalHome = process.env.HOME;
const originalDynamicMacos = process.env.UNICLI_DYNAMIC_MACOS;
const buildHome = mkdtempSync(join(tmpdir(), "unicli-manifest-home-"));
process.env.HOME = buildHome;
process.env.UNICLI_DYNAMIC_MACOS = "0";

let liveAdapters;
let commandUsesBrowser;
let buildCommandContract;
try {
  const loader = await import("../src/discovery/loader.ts");
  const registry = await import("../src/registry.ts");
  const contracts = await import("../src/core/command-contract.ts");
  loader.loadAllAdapters({ strict: true });
  await loader.loadTsAdapters({ strict: true });
  liveAdapters = registry.getAllAdapters();
  commandUsesBrowser = registry.commandUsesBrowser;
  buildCommandContract = contracts.buildCommandContract;
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDynamicMacos === undefined) {
    delete process.env.UNICLI_DYNAMIC_MACOS;
  } else {
    process.env.UNICLI_DYNAMIC_MACOS = originalDynamicMacos;
  }
  rmSync(buildHome, { recursive: true, force: true });
}

const manifest = { version: PKG.version, sites: Object.create(null) };
for (const adapter of liveAdapters) {
  const commands = Object.entries(adapter.commands)
    .map(([name, command]) => {
      const contract = buildCommandContract({
        adapter,
        commandName: name,
        command,
      });
      return {
        name,
        description: command.description ?? "",
        strategy: command.strategy ?? adapter.strategy ?? "public",
        type: adapter.type,
        domain: command.domain ?? adapter.domain,
        base: command.base ?? adapter.base,
        browser: commandUsesBrowser(adapter, command),
        browserSession: command.browserSession,
        quarantined: command.quarantine === true,
        args: command.adapterArgs ?? [],
        columns: command.columns ?? [],
        defaultFormat: command.defaultFormat,
        capabilities: command.capabilities,
        auth_requirement: command.auth_requirement,
        executables: command.executables,
        minimum_capability: command.minimum_capability,
        pipeline_steps: command.pipeline?.length ?? 0,
        paginated: command.paginated,
        retrieval: command.retrieval,
        output: command.output,
        stream: command.stream,
        adapter_path: command.adapter_path,
        target_surface: command.target_surface,
        operation_effect: command.operation_effect,
        execution_operator: command.execution_operator,
        operation_family: command.operation_family,
        idempotency: command.idempotency,
        effect_projection: {
          operation_effect: contract.effect.operation_effect,
          effect_source: contract.effect.effect_source,
          effect_confidence: contract.effect.effect_confidence,
        },
        source_tier: "packaged",
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  if (commands.length === 0) continue;
  manifest.sites[adapter.name] = {
    commands,
    category: adapter.category ?? getCategory(adapter.name),
  };
}

// ── Output 1: Full manifest ─────────────────────────────────────────────────

writeFileSync(
  join(DIST_DIR, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);

// ── Output 2: Compact catalog ───────────────────────────────────────────────
// Format: "category: site(cmd1, cmd2, ...), site2(cmd1, cmd2, ...)"
// Target: ~2-3K tokens for AGENTS.md embedding

const byCategory = {};
for (const [site, info] of Object.entries(manifest.sites)) {
  const cat = info.category || "other";
  if (!byCategory[cat]) byCategory[cat] = [];
  const cmds = info.commands.map((c) => c.name).join(", ");
  byCategory[cat].push(`${site}(${cmds})`);
}

const compactLines = [];
for (const [cat, entries] of Object.entries(byCategory)) {
  compactLines.push(`${cat}: ${entries.join(", ")}`);
}

writeFileSync(join(DIST_DIR, "manifest-compact.txt"), compactLines.join("\n"));

// ── Summary ─────────────────────────────────────────────────────────────────

const siteCount = Object.keys(manifest.sites).length;
const cmdCount = Object.values(manifest.sites).reduce(
  (sum, s) => sum + s.commands.length,
  0,
);
console.log(
  `Manifest: ${siteCount} sites, ${cmdCount} commands → dist/manifest.json`,
);
console.log(
  `Compact catalog: ${compactLines.length} categories → dist/manifest-compact.txt`,
);
