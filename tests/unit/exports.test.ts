/**
 * Plugin export surface test — verifies every subpath in package.json
 * `exports` resolves to a dist artifact that can be dynamically imported.
 *
 * Why dist (not src): downstream consumers receive the built artifacts
 * from the npm tarball. If dist layout drifts from the exports map, the
 * package looks installed but `@zenalexa/unicli/<subpath>` throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED at runtime.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const pkgPath = resolve(repoRoot, "package.json");

// Windows Node 20 cold-start dynamic-import flakes at the 5s default. Give
// Windows headroom; keep Linux/macOS tight so real regressions still trip.
const COLD_IMPORT_TIMEOUT_MS = process.platform === "win32" ? 15_000 : 5_000;

interface PkgExports {
  [subpath: string]: { types?: string; import?: string } | string;
}

function readExports(): PkgExports {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    exports?: PkgExports;
  };
  return pkg.exports ?? {};
}

function importTargetFor(
  entry: { types?: string; import?: string } | string,
): string {
  return typeof entry === "string" ? entry : (entry.import ?? "");
}

function typesTargetFor(
  entry: { types?: string; import?: string } | string,
): string {
  return typeof entry === "string" ? "" : (entry.types ?? "");
}

describe("plugin exports surface", () => {
  const exportsMap = readExports();
  const subpaths = Object.keys(exportsMap);

  // Skip dist-resolving cases on a clean checkout (no `npm run build` yet)
  // so `npm test` standalone passes. The verify chain runs `build` before
  // `test`, so CI still exercises every assertion.
  const distReady = existsSync(resolve(repoRoot, "dist", "main.js"));
  const distIt = distReady ? it : it.skip;

  it("exports at least 20 subpaths (CI gate floor)", () => {
    expect(subpaths.length).toBeGreaterThanOrEqual(20);
  });

  distIt.each(subpaths)(
    "%s resolves to an existing dist .js artifact",
    (subpath) => {
      const entry = exportsMap[subpath];
      const importRel = importTargetFor(entry);
      expect(importRel, `no import target for ${subpath}`).toBeTruthy();
      const abs = resolve(repoRoot, importRel);
      expect(
        existsSync(abs),
        `missing dist artifact for ${subpath}: ${abs}`,
      ).toBe(true);
    },
  );

  distIt.each(subpaths)(
    "%s resolves to an existing dist .d.ts artifact",
    (subpath) => {
      const entry = exportsMap[subpath];
      const typesRel = typesTargetFor(entry);
      expect(typesRel, `no types target for ${subpath}`).toBeTruthy();
      const abs = resolve(repoRoot, typesRel);
      expect(
        existsSync(abs),
        `missing .d.ts artifact for ${subpath}: ${abs}`,
      ).toBe(true);
    },
  );

  // Skip ".": main entry is a CLI executable — importing it parses argv
  // and can call process.exit. The library-surface subpaths are what
  // plugin authors consume; those are covered below.
  const importable = subpaths.filter((s) => s !== ".");

  distIt.each(importable)(
    "%s is dynamically importable",
    async (subpath) => {
      const entry = exportsMap[subpath];
      const importRel = importTargetFor(entry);
      const abs = resolve(repoRoot, importRel);
      const url = pathToFileURL(abs).href;
      const mod = await import(url);
      expect(mod).toBeDefined();
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  distIt(
    "engine barrel exposes registerStep, getStep, listSteps",
    async () => {
      const entry = exportsMap["./engine/registry"];
      const importRel = importTargetFor(entry);
      const url = pathToFileURL(resolve(repoRoot, importRel)).href;
      const mod = (await import(url)) as Record<string, unknown>;
      expect(typeof mod.registerStep).toBe("function");
      expect(typeof mod.getStep).toBe("function");
      expect(typeof mod.listSteps).toBe("function");
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  distIt(
    "errors barrel exposes PipelineError + NoTransportForStepError",
    async () => {
      const entry = exportsMap["./errors"];
      const importRel = importTargetFor(entry);
      const url = pathToFileURL(resolve(repoRoot, importRel)).href;
      const mod = (await import(url)) as Record<string, unknown>;
      expect(typeof mod.PipelineError).toBe("function");
      expect(typeof mod.NoTransportForStepError).toBe("function");
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  distIt(
    "errors barrel exposes envelope construction helpers",
    async () => {
      const entry = exportsMap["./errors"];
      const importRel = importTargetFor(entry);
      const url = pathToFileURL(resolve(repoRoot, importRel)).href;
      const mod = (await import(url)) as Record<string, unknown>;
      expect(typeof mod.err).toBe("function");
      expect(typeof mod.ok).toBe("function");
      expect(typeof mod.exitCodeFor).toBe("function");
      expect(typeof mod.EnvelopeExit).toBe("object");
      expect((mod.EnvelopeExit as Record<string, number>).SUCCESS).toBe(0);
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  distIt(
    "transport bus is importable with TransportBus symbol",
    async () => {
      const entry = exportsMap["./transport"];
      const importRel = importTargetFor(entry);
      const url = pathToFileURL(resolve(repoRoot, importRel)).href;
      const mod = (await import(url)) as Record<string, unknown>;
      expect(mod.createTransportBus ?? mod.TransportBus).toBeDefined();
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  distIt(
    "transport barrel exposes getBus for plugin TransportAdapter registration",
    async () => {
      const entry = exportsMap["./transport"];
      const importRel = importTargetFor(entry);
      const url = pathToFileURL(resolve(repoRoot, importRel)).href;
      const mod = (await import(url)) as Record<string, unknown>;
      expect(typeof mod.getBus).toBe("function");
      expect(typeof mod.buildTransportCtx).toBe("function");
      expect(typeof mod.createTransportBus).toBe("function");
    },
    COLD_IMPORT_TIMEOUT_MS,
  );
});
