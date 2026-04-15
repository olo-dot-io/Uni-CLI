/**
 * Plugin export surface test — verifies every subpath in package.json
 * `exports` resolves to a dist artifact that can be dynamically imported.
 *
 * Why dist (not src): downstream consumers receive the built artifacts
 * from the npm tarball. If dist layout drifts from the exports map, the
 * package looks installed but `@zenalexa/unicli/<subpath>` throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED at runtime.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const pkgPath = resolve(repoRoot, "package.json");

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

  beforeAll(() => {
    // Dist must exist. If not, tell the developer to build instead of
    // failing with a cryptic resolution error.
    const mainDist = resolve(repoRoot, "dist", "main.js");
    if (!existsSync(mainDist)) {
      throw new Error(
        `dist/ missing (expected ${mainDist}). Run "npm run build" before "npm test".`,
      );
    }
  });

  it("exports at least 20 subpaths (CI gate floor)", () => {
    expect(subpaths.length).toBeGreaterThanOrEqual(20);
  });

  it.each(subpaths)(
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

  it.each(subpaths)(
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

  it.each(importable)("%s is dynamically importable", async (subpath) => {
    const entry = exportsMap[subpath];
    const importRel = importTargetFor(entry);
    const abs = resolve(repoRoot, importRel);
    const url = pathToFileURL(abs).href;
    const mod = await import(url);
    expect(mod).toBeDefined();
  });

  it("engine barrel exposes registerStep, getStep, listSteps", async () => {
    const entry = exportsMap["./engine/registry"];
    const importRel = importTargetFor(entry);
    const url = pathToFileURL(resolve(repoRoot, importRel)).href;
    const mod = (await import(url)) as Record<string, unknown>;
    expect(typeof mod.registerStep).toBe("function");
    expect(typeof mod.getStep).toBe("function");
    expect(typeof mod.listSteps).toBe("function");
  });

  it("errors barrel exposes PipelineError + NoTransportForStepError", async () => {
    const entry = exportsMap["./errors"];
    const importRel = importTargetFor(entry);
    const url = pathToFileURL(resolve(repoRoot, importRel)).href;
    const mod = (await import(url)) as Record<string, unknown>;
    expect(typeof mod.PipelineError).toBe("function");
    expect(typeof mod.NoTransportForStepError).toBe("function");
  });

  it("transport bus is importable with TransportBus symbol", async () => {
    const entry = exportsMap["./transport"];
    const importRel = importTargetFor(entry);
    const url = pathToFileURL(resolve(repoRoot, importRel)).href;
    const mod = (await import(url)) as Record<string, unknown>;
    expect(mod.createTransportBus ?? mod.TransportBus).toBeDefined();
  });
});
