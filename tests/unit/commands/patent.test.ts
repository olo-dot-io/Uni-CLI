/**
 * Tests for `unicli patent` — argv parsing, routing-by-prefix, capability
 * discovery, and reciprocal-rank-fusion ordering on a small fixture.
 *
 * Real-adapter pipelines depend on the engine's executor + step bodies, which
 * are still under wave-1 implementation. We test the meta-command surface
 * (argv parsing, prefix routing, rrf fusion, capability discovery) directly
 * against the exported helpers — no mocking of owned modules. End-to-end
 * adapter integration tests are deferred to it.skipIf gates on env keys.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import {
  DEFAULT_SOURCES,
  JURISDICTION_ADAPTERS,
  PATENT_CAPABILITIES,
  findCommandByCapability,
  listPatentAdapters,
  reciprocalRankFusion,
  registerPatentCommand,
  resolveSources,
  routeByPublicationPrefix,
} from "../../../src/commands/patent.js";
import { registerAdapter } from "../../../src/registry.js";
import { AdapterType } from "../../../src/types.js";
import type { PatentRecord } from "../../../src/types/patent.js";

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("-f, --format <fmt>", "output format");
  registerPatentCommand(program);
  return program;
}

function registerFakePatentAdapter(
  name: string,
  capabilities: Record<string, string[]> = {
    search: ["http.fetch", "patent.search"],
  },
): void {
  registerAdapter({
    name,
    type: AdapterType.WEB_API,
    commands: Object.fromEntries(
      Object.entries(capabilities).map(([cmdName, caps]) => [
        cmdName,
        {
          name: cmdName,
          description: `${cmdName} for ${name}`,
          capabilities: caps,
        },
      ]),
    ),
  });
}

describe("unicli patent — argv parsing", () => {
  it("lists every documented sub-command in --help", () => {
    const program = makeProgram();
    const help = program.commands
      .find((c) => c.name() === "patent")!
      .helpInformation();
    for (const sub of [
      "search",
      "get",
      "family",
      "citations",
      "legal-status",
      "prior-art",
      "doctor",
    ]) {
      expect(help).toContain(sub);
    }
  });

  it("rejects `patent get` without a positional argument", async () => {
    const program = makeProgram();
    await expect(
      program.parseAsync(["patent", "get"], { from: "user" }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/missingArgument|commander/i),
    });
  });

  it("requires --abstract for prior-art", async () => {
    const program = makeProgram();
    await expect(
      program.parseAsync(["patent", "prior-art"], { from: "user" }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/missingMandatory|commander/i),
    });
  });
});

describe("unicli patent — routeByPublicationPrefix", () => {
  it("maps US prefix → uspto", () => {
    expect(routeByPublicationPrefix("US20240123456A1")).toBe("uspto");
  });
  it("maps EP prefix → epo", () => {
    expect(routeByPublicationPrefix("EP4123456A1")).toBe("epo");
  });
  it("maps JP prefix → jpo", () => {
    expect(routeByPublicationPrefix("JP2024-123456")).toBe("jpo");
  });
  it("maps WO (PCT) prefix → epo as broker", () => {
    expect(routeByPublicationPrefix("WO2024123456")).toBe("epo");
  });
  it("returns undefined for unknown prefix", () => {
    expect(routeByPublicationPrefix("XX123456")).toBeUndefined();
  });
  it("returns undefined for non-CC-prefixed input", () => {
    expect(routeByPublicationPrefix("12345abc")).toBeUndefined();
  });
  it("normalises lowercase prefixes", () => {
    expect(routeByPublicationPrefix("us20240123456a1")).toBe("uspto");
  });
  it("has stable jurisdiction table", () => {
    // Lock the conventional set so a typo in JURISDICTION_ADAPTERS shows up
    // as a test failure rather than silent routing rot.
    expect(JURISDICTION_ADAPTERS.US).toBe("uspto");
    expect(JURISDICTION_ADAPTERS.EP).toBe("epo");
    expect(JURISDICTION_ADAPTERS.JP).toBe("jpo");
    expect(JURISDICTION_ADAPTERS.CN).toBe("cnipa");
  });
});

describe("unicli patent — resolveSources", () => {
  beforeEach(() => {
    registerFakePatentAdapter("fixture-pat-a");
    registerFakePatentAdapter("fixture-pat-b", {
      "prior-art": ["http.fetch", "patent.prior-art"],
    });
  });

  it("defaults to uspto,epo,jpo", () => {
    expect(resolveSources(undefined)).toEqual([...DEFAULT_SOURCES]);
  });
  it("parses csv input", () => {
    expect(resolveSources("uspto, epo, jpo")).toEqual(["uspto", "epo", "jpo"]);
  });
  it("expands `all` via capability discovery", () => {
    const sources = resolveSources("all");
    expect(sources).toContain("fixture-pat-a");
    expect(sources).toContain("fixture-pat-b");
  });
  it("listPatentAdapters returns only patent-capable adapters", () => {
    registerAdapter({
      name: "fixture-not-patent",
      type: AdapterType.WEB_API,
      commands: {
        search: { name: "search", capabilities: ["http.fetch"] },
      },
    });
    const list = listPatentAdapters();
    expect(list.find((a) => a.name === "fixture-pat-a")).toBeDefined();
    expect(list.find((a) => a.name === "fixture-not-patent")).toBeUndefined();
  });
});

describe("unicli patent — findCommandByCapability", () => {
  beforeEach(() => {
    registerFakePatentAdapter("fixture-pat-cap", {
      lookup: ["http.fetch", "patent.get"],
      retrieve: ["http.fetch", "patent.family"],
    });
  });

  it("finds the command whose capability tag matches, regardless of command name", () => {
    const adapter = listPatentAdapters().find(
      (a) => a.name === "fixture-pat-cap",
    )!;
    const found = findCommandByCapability(adapter, "patent.get");
    expect(found?.name).toBe("lookup");
  });
  it("returns undefined when no command exposes the capability", () => {
    const adapter = listPatentAdapters().find(
      (a) => a.name === "fixture-pat-cap",
    )!;
    expect(findCommandByCapability(adapter, "patent.search")).toBeUndefined();
  });

  it("exports the full capability taxonomy", () => {
    expect(PATENT_CAPABILITIES).toContain("patent.search");
    expect(PATENT_CAPABILITIES).toContain("patent.prior-art");
    expect(PATENT_CAPABILITIES).toHaveLength(7);
  });
});

describe("unicli patent — reciprocal-rank fusion", () => {
  function rec(
    publication_number: string,
    extras: Partial<PatentRecord> = {},
  ): PatentRecord {
    return {
      publication_number,
      source_adapter: extras.source_adapter ?? "fixture",
      retrieved_at: "2026-05-18T00:00:00Z",
      ...extras,
    };
  }

  it("rewards records that appear high in multiple lists", () => {
    const listA = [rec("US-A-A1"), rec("EP-B-A1"), rec("JP-C-A1")];
    const listB = [rec("EP-B-A1"), rec("US-A-A1"), rec("DE-D-A1")];
    const fused = reciprocalRankFusion([listA, listB]);
    // US-A and EP-B both appear at rank 1 once and rank 2 once;
    // the tie-break is firstSeen order from listA → US-A first.
    expect(fused[0].publication_number).toBe("US-A-A1");
    expect(fused[1].publication_number).toBe("EP-B-A1");
    expect(fused.map((r) => r.publication_number)).toContain("JP-C-A1");
    expect(fused.map((r) => r.publication_number)).toContain("DE-D-A1");
  });

  it("dedupes by family_id when present", () => {
    const listA = [
      rec("US-A-A1", { family_id: "FAM1" }),
      rec("JP-X", { family_id: "FAM2" }),
    ];
    const listB = [rec("EP-A-A1", { family_id: "FAM1" })];
    const fused = reciprocalRankFusion([listA, listB]);
    expect(fused).toHaveLength(2);
    // First entry should be from listA (firstSeen wins ties on score).
    const familyOne = fused.find((r) => r.family_id === "FAM1");
    expect(familyOne?.publication_number).toBe("US-A-A1");
  });

  it("respects topN cap", () => {
    const list = [
      rec("US-1"),
      rec("US-2"),
      rec("US-3"),
      rec("US-4"),
      rec("US-5"),
    ];
    expect(reciprocalRankFusion([list], { topN: 2 })).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[]])).toEqual([]);
  });
});

describe("unicli patent — wave-1 integration (deferred)", () => {
  it.skip("waits for wave-1-A normalizer impl + wave-1-B uspto/epo/jpo adapters", () => {
    // The end-to-end search → normaliser → fan-out path executes real
    // pipelines through engine kernel + step handlers. The kernel `fetch`
    // step body lands in wave-1-A, and uspto/epo/jpo YAML adapters land
    // in wave-1-B. This placeholder marks the integration seam for the
    // post-merge audit (rule 03 — no mocking of owned modules).
  });
});

afterEach(() => {
  // The registry is process-global; explicit teardown isn't supported, but
  // we avoid relying on cross-test state by registering unique fixture names.
});
