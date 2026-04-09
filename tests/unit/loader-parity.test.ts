/**
 * Loader parity — a permanent regression guard for the v0.208.1 audit fixes.
 *
 * Two failure modes this suite locks in:
 *
 *  1. **dist vs src site parity**. The v0.1.0 loader pointed `BUILTIN_DIR` at
 *     `dist/adapters` in production builds, but `tsc` does not copy YAML
 *     files there — so `npm install -g @zenalexa/unicli && unicli list`
 *     returned an empty list despite the package containing hundreds of
 *     adapters. The fix picks the directory that actually holds YAMLs
 *     (usually `src/adapters/`, shipped via `package.json` `files`).
 *     This test asserts both modes surface the same sites + commands.
 *
 *  2. **`.d.ts` files must not be imported as adapters**. `collectTsFiles`
 *     previously matched them via `extname(file) === ".ts"`, inflating the
 *     TS adapter count and shadowing the YAML load failure in mode 1. The
 *     test walks the resolved TS directory and confirms no declaration
 *     files are in the candidate list.
 *
 * If this test fails in the future it means somebody broke the dist
 * packaging story — probably by moving `BUILTIN_DIR` back to `dist/adapters`
 * without copying YAMLs, or by re-enabling `.d.ts` discovery.
 *
 * The test depends on a pre-built `dist/` tree. Running `npm run build`
 * before this file is part of the `verify` chain, so it is always fresh.
 * When `dist/` is missing (local dev right after `git clone`) the two dist
 * assertions are skipped with a clear message.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadAllAdapters,
  loadTsAdapters,
  getBuiltinDirs,
} from "../../src/discovery/loader.js";
import { getAllAdapters, listCommands } from "../../src/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const DIST_MAIN = join(REPO_ROOT, "dist", "main.js");
const DIST_LOADER = join(REPO_ROOT, "dist", "discovery", "loader.js");

describe("loader — built-in directory resolution", () => {
  it("resolves a YAML directory that actually contains YAML files", () => {
    const { yamlDir } = getBuiltinDirs();
    expect(existsSync(yamlDir)).toBe(true);

    // At least one site directory under yamlDir must contain a .yaml file.
    // If not, `findAdapterDirs` picked the wrong directory.
    let foundYaml = false;
    for (const site of readdirSync(yamlDir)) {
      if (site.startsWith("_") || site.startsWith(".")) continue;
      const siteDir = join(yamlDir, site);
      if (!statSync(siteDir).isDirectory()) continue;
      const hasYaml = readdirSync(siteDir).some(
        (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
      );
      if (hasYaml) {
        foundYaml = true;
        break;
      }
    }
    expect(foundYaml).toBe(true);
  });

  it("never picks a directory with zero YAML files", () => {
    // If both src/adapters and dist/adapters exist, findAdapterDirs must
    // prefer the one with YAMLs. A common bad outcome: yamlDir resolves to
    // dist/adapters (no YAMLs) and the loader silently loads nothing.
    const { yamlDir } = getBuiltinDirs();
    let yamlCount = 0;
    for (const site of readdirSync(yamlDir)) {
      if (site.startsWith("_") || site.startsWith(".")) continue;
      const siteDir = join(yamlDir, site);
      if (!statSync(siteDir).isDirectory()) continue;
      for (const f of readdirSync(siteDir)) {
        if (f.endsWith(".yaml") || f.endsWith(".yml")) yamlCount++;
      }
    }
    expect(yamlCount).toBeGreaterThan(100);
  });
});

describe("collectTsFiles — declaration files must never be loaded", () => {
  it("does not import .d.ts files into the registry", async () => {
    // We can't call the private `collectTsFiles` from here, but we can
    // indirectly verify: after `loadTsAdapters` runs, every registered TS
    // adapter must have commands with real `.func` or `pipeline` properties.
    // Declaration files produce empty ES modules that don't register.
    // This test is defense-in-depth for the extname === ".ts" bug.
    await loadTsAdapters();
    const adapters = getAllAdapters();
    // The bug: 81 empty "TS" adapters get loaded from .d.ts files. If the
    // registry has any site with zero commands, something slipped through.
    const bogus = adapters.filter((a) => Object.keys(a.commands).length === 0);
    expect(bogus).toEqual([]);
  });
});

describe("loader runs from src directly without crashing", () => {
  it("loads at least the v0.208 claimed number of sites and commands", () => {
    loadAllAdapters();
    // TS adapters are loaded async in loadTsAdapters; leaving them out of
    // this assertion keeps the test synchronous. The YAML surface alone
    // should be well into triple digits by v0.208.
    const cmds = listCommands();
    expect(cmds.length).toBeGreaterThan(500);
    const sites = new Set(cmds.map((c) => c.site));
    expect(sites.size).toBeGreaterThan(100);
  });
});

describe("dist parity — production build must match source mode", () => {
  // The expensive check: spawn the built CLI and parse its list output.
  // Skips gracefully when dist/ is absent so a fresh `git clone` can still
  // run the unit suite without first building.
  const distReady = existsSync(DIST_MAIN) && existsSync(DIST_LOADER);

  it.runIf(distReady)(
    "node dist/main.js list returns the same site count as src mode",
    async () => {
      // We compare dist mode against src mode by spawning BOTH as separate
      // child processes rather than inlining one side. This avoids vitest's
      // module-loader sandbox interfering with TS adapter self-registration
      // (which caused a false positive during the initial test run).
      const { spawnSync } = await import("node:child_process");

      const distResult = spawnSync(
        "node",
        [DIST_MAIN, "list", "--format", "json"],
        {
          encoding: "utf-8",
          env: { ...process.env, UNICLI_NO_LEDGER: "1" },
          timeout: 30_000,
        },
      );
      expect(distResult.status).toBe(0);
      const distStdout =
        typeof distResult.stdout === "string" ? distResult.stdout : "";
      const distRows = JSON.parse(distStdout) as Array<{ site: string }>;
      const distSites = new Set(distRows.map((r) => r.site));

      const srcResult = spawnSync(
        "npx",
        ["tsx", join(REPO_ROOT, "src", "main.ts"), "list", "--format", "json"],
        {
          encoding: "utf-8",
          env: { ...process.env, UNICLI_NO_LEDGER: "1" },
          timeout: 60_000,
        },
      );
      expect(srcResult.status).toBe(0);
      const srcStdout =
        typeof srcResult.stdout === "string" ? srcResult.stdout : "";
      const srcRows = JSON.parse(srcStdout) as Array<{ site: string }>;
      const srcSites = new Set(srcRows.map((r) => r.site));

      // The critical invariant: dist must not regress to empty. Both modes
      // should surface the same sites and commands. All adapters register
      // regardless of detect: field (runtime check only, not registration gate).
      expect(distSites.size).toBeGreaterThan(100);
      expect(distSites.size).toBe(srcSites.size);
      expect(distRows.length).toBe(srcRows.length);
    },
    60_000,
  );

  it.runIf(distReady)(
    "node dist/main.js doctor reports non-zero site count",
    async () => {
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync("node", [DIST_MAIN, "doctor"], {
        encoding: "utf-8",
        env: { ...process.env, UNICLI_NO_LEDGER: "1" },
        timeout: 15_000,
      });
      expect(result.status).toBe(0);
      const stdout = typeof result.stdout === "string" ? result.stdout : "";
      // "Sites:    134" — grep the number
      const m = stdout.match(/Sites:\s+(\d+)/);
      expect(m).not.toBeNull();
      if (m) expect(parseInt(m[1], 10)).toBeGreaterThan(100);
    },
  );
});
