import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CapabilityRequirements } from "../../src/discovery/feasibility.js";
import type { SearchResult } from "../../src/discovery/search.js";

const isolatedHome = mkdtempSync(join(tmpdir(), "unicli-search-parity-"));
const originalHome = process.env.HOME;
let search: typeof import("../../src/discovery/search.js").search;
let searchDocuments: typeof import("../../src/discovery/search.js").searchDocuments;
let manifestSearchDocuments: typeof import("../../src/fast-path/handlers/discovery.js").manifestSearchDocuments;
let readManifest: typeof import("../../src/fast-path/manifest.js").readManifest;
let resolveCommand: typeof import("../../src/registry.js").resolveCommand;
let buildCommandContract: typeof import("../../src/core/command-contract.js").buildCommandContract;
let buildManifestCommandContract: typeof import("../../src/core/command-contract.js").buildManifestCommandContract;

describe("fast/live search parity", () => {
  beforeAll(async () => {
    process.env.HOME = isolatedHome;
    process.env.UNICLI_DYNAMIC_MACOS = "0";
    const loader = await import("../../src/discovery/loader.js");
    const discovery = await import("../../src/discovery/search.js");
    ({ search, searchDocuments } = discovery);
    ({ manifestSearchDocuments } =
      await import("../../src/fast-path/handlers/discovery.js"));
    ({ readManifest } = await import("../../src/fast-path/manifest.js"));
    ({ resolveCommand } = await import("../../src/registry.js"));
    ({ buildCommandContract, buildManifestCommandContract } =
      await import("../../src/core/command-contract.js"));
    loader.loadAllAdapters({ strict: true });
    await loader.loadTsAdapters({ strict: true });
    discovery.invalidateCache();
  });

  afterAll(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete process.env.UNICLI_DYNAMIC_MACOS;
    rmSync(isolatedHome, { recursive: true, force: true });
  });

  it.each([
    {
      query: "get Hacker News top stories",
      requirements: {
        operator: "structured-api",
        operation_family: "list",
        allow_browser: false,
      } satisfies CapabilityRequirements,
    },
    {
      query: "search Reddit",
      requirements: {
        operator: "structured-api",
        operation_family: "search",
        required_sites: ["reddit"],
        allow_browser: false,
      } satisfies CapabilityRequirements,
    },
    {
      query: "screenshot desktop visually",
      requirements: {
        operator: "visual-observation",
        operation_family: "capture",
      } satisfies CapabilityRequirements,
    },
    {
      query: "github issues",
      requirements: {} satisfies CapabilityRequirements,
    },
  ])(
    "returns identical ranking and scores for $query",
    ({ query, requirements }) => {
      const live = search(query, 8, { requirements });
      const fast = searchDocuments(
        manifestSearchDocuments(readManifest()),
        query,
        8,
        { requirements },
      );
      const project = (rows: SearchResult[]): Array<Record<string, unknown>> =>
        rows.map((row) => ({
          id: `${row.site}/${row.command}`,
          score: row.score,
          operator: row.feasibility?.operator,
          operation_family: row.feasibility?.operation_family,
        }));

      expect(project(fast)).toEqual(project(live));
    },
  );

  it("keeps every generated command contract aligned with the live registry", () => {
    const manifest = readManifest();
    const mismatches: Array<Record<string, unknown>> = [];
    for (const [site, info] of Object.entries(manifest.sites)) {
      for (const command of info.commands) {
        const live = resolveCommand(site, command.name);
        if (!live) {
          mismatches.push({ id: `${site}/${command.name}`, missing: "live" });
          continue;
        }
        const liveContract = buildCommandContract({
          adapter: live.adapter,
          commandName: command.name,
          command: live.command,
        });
        const manifestContract = buildManifestCommandContract({
          site,
          commandName: command.name,
          category: info.category,
          adapterType: command.type ?? "web-api",
          command,
        });
        const project = (
          contract: typeof liveContract,
        ): Record<string, unknown> => ({
          operation: contract.operation,
          schemas: contract.schemas,
          execution: contract.execution,
          effect: contract.effect,
          auth: contract.auth,
          retrieval: contract.retrieval,
          minimum_capability: contract.repair.minimum_capability,
          quarantined: contract.repair.quarantined,
        });
        if (
          JSON.stringify(project(liveContract)) !==
          JSON.stringify(project(manifestContract))
        ) {
          mismatches.push({
            id: `${site}/${command.name}`,
            live: project(liveContract),
            manifest: project(manifestContract),
          });
          if (mismatches.length === 10) break;
        }
      }
      if (mismatches.length === 10) break;
    }
    expect(mismatches).toEqual([]);
  });
});
