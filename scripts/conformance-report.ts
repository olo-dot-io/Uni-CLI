#!/usr/bin/env node
/**
 * conformance-report — emits a JSON conformance summary of every YAML
 * adapter, intended for the nightly CI job to upload as an artifact.
 *
 * Output: `conformance-report.json` in the current working directory.
 *   {
 *     "generatedAt": "...",
 *     "totals": { adapters, sites, passed, failed, quarantined },
 *     "results": [
 *       { site, command, file, status: "success"|"fail"|"quarantined", ... }
 *     ]
 *   }
 *
 * This is a lightweight static report — it validates parse + schema
 * shape, not live network calls. Live probes belong in a separate
 * runner (`adapter-health-strict`).
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ADAPTERS_DIR = join(ROOT, "src", "adapters");

const VALID_TYPES = new Set([
  "web-api",
  "desktop",
  "browser",
  "bridge",
  "service",
]);
const VALID_STRATEGIES = new Set([
  "public",
  "cookie",
  "header",
  "intercept",
  "ui",
]);

interface YamlAdapter {
  site?: string;
  name?: string;
  type?: string;
  strategy?: string;
  pipeline?: unknown[];
  quarantine?: boolean;
  quarantineReason?: string;
}

interface ProbeResult {
  site: string;
  command: string;
  file: string;
  status: "success" | "fail" | "quarantined" | "timeout";
  errors: string[];
}

function walk(): ProbeResult[] {
  const results: ProbeResult[] = [];

  for (const site of readdirSync(ADAPTERS_DIR)) {
    if (site.startsWith("_") || site.startsWith(".")) continue;
    const siteDir = join(ADAPTERS_DIR, site);
    if (!statSync(siteDir).isDirectory()) continue;

    for (const file of readdirSync(siteDir)) {
      const ext = extname(file);
      if (ext !== ".yaml" && ext !== ".yml") continue;

      const rel = `src/adapters/${site}/${file}`;
      const command = file.replace(/\.(yaml|yml)$/, "");
      const errors: string[] = [];
      let quarantined = false;

      try {
        const raw = readFileSync(join(siteDir, file), "utf-8");
        const parsed = yaml.load(raw) as YamlAdapter;

        if (!parsed || typeof parsed !== "object") {
          errors.push("yaml load returned non-object");
        } else {
          if (parsed.type && !VALID_TYPES.has(parsed.type)) {
            errors.push(`invalid type: ${parsed.type}`);
          }
          if (parsed.strategy && !VALID_STRATEGIES.has(parsed.strategy)) {
            errors.push(`invalid strategy: ${parsed.strategy}`);
          }
          if (
            parsed.pipeline &&
            (!Array.isArray(parsed.pipeline) || parsed.pipeline.length === 0)
          ) {
            errors.push("pipeline must be a non-empty array");
          }
          if (parsed.quarantine === true) {
            quarantined = true;
            if (
              !parsed.quarantineReason ||
              parsed.quarantineReason.length === 0
            ) {
              errors.push("quarantine: true requires quarantineReason");
            }
          }
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }

      let status: ProbeResult["status"];
      if (quarantined) status = "quarantined";
      else if (errors.length > 0) status = "fail";
      else status = "success";

      results.push({ site, command, file: rel, status, errors });
    }
  }

  return results;
}

function main(): void {
  const started = Date.now();
  const results = walk();

  const totals = {
    adapters: results.length,
    sites: new Set(results.map((r) => r.site)).size,
    passed: results.filter((r) => r.status === "success").length,
    failed: results.filter((r) => r.status === "fail").length,
    quarantined: results.filter((r) => r.status === "quarantined").length,
    timeout: results.filter((r) => r.status === "timeout").length,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    totals,
    results,
  };

  const out = join(ROOT, "conformance-report.json");
  writeFileSync(out, JSON.stringify(report, null, 2), "utf-8");

  // Human summary for logs
  console.log(
    `conformance: ${totals.adapters} adapters across ${totals.sites} sites`,
  );
  console.log(
    `  passed:      ${totals.passed}\n  failed:      ${totals.failed}\n  quarantined: ${totals.quarantined}`,
  );
  console.log(`  report:      ${out}`);

  // Exit non-zero if any failure. Quarantined ≠ failure.
  if (totals.failed > 0) {
    process.exit(1);
  }
}

main();
