/**
 * Tests for `unicli scholar` — capability discovery, source routing, and
 * reciprocal-rank fusion for scholarly work records. These stay on owned code:
 * no network and no mocked registry helpers.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import {
  DEFAULT_SCHOLAR_SOURCES,
  SCHOLAR_CAPABILITIES,
  findScholarCommandByCapability,
  listScholarAdapters,
  reciprocalRankFusion,
  registerScholarCommand,
  resolveScholarReference,
  resolveScholarSources,
} from "../../../src/commands/scholar.js";
import { registerAdapter } from "../../../src/registry.js";
import { AdapterType } from "../../../src/types.js";
import type { ScholarlyWorkRecord } from "../../../src/types/scholarly.js";

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("-f, --format <fmt>", "output format");
  registerScholarCommand(program);
  return program;
}

function registerFakeScholarAdapter(
  name: string,
  capabilities: Record<string, string[]> = {
    search: ["http.fetch", "scholar.search"],
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

describe("unicli scholar — argv surface", () => {
  it("lists the agent-facing subcommands in --help", () => {
    const program = makeProgram();
    const help = program.commands
      .find((command) => command.name() === "scholar")!
      .helpInformation();

    for (const sub of [
      "search",
      "get",
      "pdf",
      "citations",
      "references",
      "doctor",
    ]) {
      expect(help).toContain(sub);
    }
  });

  it("exports the full scholarly capability taxonomy", () => {
    expect(SCHOLAR_CAPABILITIES).toEqual([
      "scholar.search",
      "scholar.get",
      "scholar.pdf",
      "scholar.citations",
      "scholar.references",
      "scholar.venue",
      "scholar.author",
      "scholar.datasets",
      "scholar.code",
      "scholar.review",
    ]);
  });
});

describe("unicli scholar — source discovery", () => {
  beforeEach(() => {
    registerFakeScholarAdapter("fixture-scholar-a");
    registerFakeScholarAdapter("fixture-scholar-b", {
      paper: ["http.fetch", "scholar.get"],
      refs: ["http.fetch", "scholar.references"],
    });
  });

  it("defaults to first-source discovery adapters", () => {
    expect(resolveScholarSources(undefined)).toEqual([
      ...DEFAULT_SCHOLAR_SOURCES,
    ]);
  });

  it("parses explicit csv source lists", () => {
    expect(
      resolveScholarSources("openalex, semantic-scholar, crossref"),
    ).toEqual(["openalex", "semantic-scholar", "crossref"]);
  });

  it("expands all from scholar.* capability tags", () => {
    const sources = resolveScholarSources("all");
    expect(sources).toContain("fixture-scholar-a");
    expect(sources).toContain("fixture-scholar-b");
  });

  it("listScholarAdapters ignores non-scholarly adapters", () => {
    registerAdapter({
      name: "fixture-not-scholar",
      type: AdapterType.WEB_API,
      commands: {
        search: { name: "search", capabilities: ["http.fetch"] },
      },
    });

    expect(listScholarAdapters().map((adapter) => adapter.name)).toContain(
      "fixture-scholar-a",
    );
    expect(listScholarAdapters().map((adapter) => adapter.name)).not.toContain(
      "fixture-not-scholar",
    );
  });

  it("finds commands by scholar.* capability regardless of command name", () => {
    const adapter = listScholarAdapters().find(
      (candidate) => candidate.name === "fixture-scholar-b",
    )!;

    expect(
      findScholarCommandByCapability(adapter, "scholar.references")?.name,
    ).toBe("refs");
    expect(
      findScholarCommandByCapability(adapter, "scholar.pdf"),
    ).toBeUndefined();
  });
});

describe("unicli scholar — reference routing", () => {
  it("routes DOI references to DOI-aware sources", () => {
    expect(resolveScholarReference("10.48550/arXiv.1706.03762")).toEqual({
      kind: "doi",
      value: "10.48550/arXiv.1706.03762",
      preferredSources: ["openalex", "crossref", "semantic-scholar"],
    });
  });

  it("routes arXiv ids to arxiv first", () => {
    expect(resolveScholarReference("arXiv:1706.03762v7")).toEqual({
      kind: "arxiv",
      value: "1706.03762",
      preferredSources: ["arxiv", "semantic-scholar", "openalex"],
    });
  });

  it("routes PMIDs to PubMed first", () => {
    expect(resolveScholarReference("PMID:12345678")).toEqual({
      kind: "pmid",
      value: "12345678",
      preferredSources: ["pubmed", "semantic-scholar", "openalex"],
    });
  });

  it("routes OpenReview forum ids to OpenReview first", () => {
    expect(resolveScholarReference("openreview:abcDEF123")).toEqual({
      kind: "openreview",
      value: "abcDEF123",
      preferredSources: ["openreview", "semantic-scholar", "openalex"],
    });
  });
});

describe("unicli scholar — reciprocal-rank fusion", () => {
  function rec(
    id: string,
    extras: Partial<ScholarlyWorkRecord> = {},
  ): ScholarlyWorkRecord {
    return {
      id,
      title: extras.title ?? id,
      source_adapter: extras.source_adapter ?? "fixture",
      retrieved_at: "2026-05-19T00:00:00Z",
      ...extras,
    };
  }

  it("dedupes by DOI before source-specific ids", () => {
    const fused = reciprocalRankFusion([
      [rec("s2:1", { doi: "10.1/demo" }), rec("s2:2")],
      [rec("oa:1", { doi: "10.1/demo" }), rec("oa:2")],
    ]);

    expect(fused).toHaveLength(3);
    expect(fused[0].doi).toBe("10.1/demo");
    expect(fused[0].id).toBe("s2:1");
  });

  it("respects topN", () => {
    expect(
      reciprocalRankFusion([[rec("a"), rec("b"), rec("c")]], { topN: 2 }),
    ).toHaveLength(2);
  });
});
