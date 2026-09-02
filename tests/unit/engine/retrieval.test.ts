import { beforeAll, describe, expect, it } from "vitest";

import { listAiSourceCommands } from "../../../src/commands/ai.js";
import { buildCommandContract } from "../../../src/core/command-contract.js";
import { validateAdapterV2 } from "../../../src/core/schema-v2.js";
import {
  executeRetrievalRequests,
  listRetrievalSources,
  normalizeEvidenceCandidates,
  projectRetrievalArguments,
  selectRetrievalSources,
} from "../../../src/engine/retrieval.js";
import {
  loadAllAdapters,
  loadTsAdapters,
} from "../../../src/discovery/loader.js";
import { getAllAdapters } from "../../../src/registry.js";

beforeAll(async () => {
  loadAllAdapters();
  await loadTsAdapters();
});

describe("domain-neutral retrieval registry", () => {
  it("discovers cross-industry sources without leaking them into the AI domain pack", () => {
    const genericRefs = new Set(
      listRetrievalSources().map((source) => source.ref),
    );
    const aiRefs = new Set(listAiSourceCommands().map((source) => source.ref));

    expect(genericRefs.size).toBeGreaterThanOrEqual(41);
    expect([...genericRefs]).toEqual(
      expect.arrayContaining([
        "nvd.cve",
        "pubmed.search",
        "wikipedia.search",
        "gov-law.search",
        "google-patents-web.search",
        "freepatentsonline-web.search",
      ]),
    );
    expect(aiRefs.has("nvd.cve")).toBe(false);
    expect(aiRefs.has("pubmed.search")).toBe(false);
    expect(aiRefs.has("gh.search-issues")).toBe(true);
  });

  it("allows domain extensions while rejecting mappings to undeclared arguments", () => {
    const valid = validateAdapterV2({
      name: "trials",
      schema_version: "v2",
      capabilities: ["http.fetch"],
      minimum_capability: "http.fetch",
      trust: "public",
      confidentiality: "public",
      quarantine: false,
      args: { term: { type: "str" } },
      retrieval: {
        operation: "discover",
        result_kind: "clinical-trial",
        source_class: "official",
        arguments: { condition: "term" },
      },
    });
    expect(valid.ok).toBe(true);

    const invalid = validateAdapterV2({
      name: "trials",
      schema_version: "v2",
      capabilities: ["http.fetch"],
      minimum_capability: "http.fetch",
      trust: "public",
      confidentiality: "public",
      quarantine: false,
      args: { term: { type: "str" } },
      retrieval: {
        operation: "discover",
        result_kind: "clinical-trial",
        source_class: "official",
        arguments: { condition: "missing" },
      },
    });
    expect(invalid).toMatchObject({
      ok: false,
      error: expect.stringContaining("undeclared adapter argument"),
    });
  });

  it("projects semantic roles and blocks capabilities not declared by the orchestrator", async () => {
    const source = listRetrievalSources().find(
      (candidate) => candidate.ref === "nvd.cve",
    );
    expect(source).toBeDefined();
    expect(
      projectRetrievalArguments(source!, { query: "CVE-2025-0001" }),
    ).toEqual({ id: "CVE-2025-0001" });

    const [outcome] = await executeRetrievalRequests(
      [{ source: source!, values: { query: "CVE-2025-0001" } }],
      { allowedCapabilities: [] },
    );
    expect(outcome.results).toEqual([]);
    expect(outcome.error).toMatchObject({
      code: "retrieval_capability_not_contained",
      retryable: false,
    });
  });

  it("keeps the default search-index selection public while allowing explicit authenticated sources", () => {
    const publicSearchIndexes = selectRetrievalSources(["search-index"]);
    const explicitZhihu = selectRetrievalSources([
      "zhihu.native-global-search",
    ]);

    expect(publicSearchIndexes.map((source) => source.ref)).toEqual(
      expect.arrayContaining([
        "brave.search",
        "duckduckgo.search",
        "yahoo.search",
      ]),
    );
    expect(publicSearchIndexes.map((source) => source.ref)).not.toContain(
      "zhihu.native-global-search",
    );
    expect(explicitZhihu.map((source) => source.ref)).toEqual([
      "zhihu.native-global-search",
    ]);
  });

  it("never spends configured provider credits through automatic or all selection", () => {
    const previous = process.env.SERPBASE_API_KEY;
    try {
      process.env.SERPBASE_API_KEY = "configured";
      expect(
        selectRetrievalSources([]).map((source) => source.ref),
      ).not.toContain("serpbase.search");
      expect(
        selectRetrievalSources(["all"]).map((source) => source.ref),
      ).not.toContain("serpbase.search");
      expect(
        selectRetrievalSources(["serpbase"]).map((source) => source.ref),
      ).toEqual(["serpbase.search"]);
      expect(
        selectRetrievalSources(["serpbase.search"]).map((source) => source.ref),
      ).toEqual(["serpbase.search"]);
    } finally {
      if (previous === undefined) delete process.env.SERPBASE_API_KEY;
      else process.env.SERPBASE_API_KEY = previous;
    }
  });

  it("projects a shared result limit within each provider contract", () => {
    const source = listRetrievalSources().find(
      (candidate) => candidate.ref === "zhihu.native-global-search",
    );

    expect(source).toBeDefined();
    expect(
      projectRetrievalArguments(source!, {
        query: "agent interfaces",
        limit: 30,
      }),
    ).toMatchObject({ query: "agent interfaces", count: 20 });
  });

  it("propagates the caller's exact cancellation reason", async () => {
    const source = listRetrievalSources().find(
      (candidate) => candidate.ref === "brave.search",
    )!;
    const controller = new AbortController();
    const reason = new Error("retrieval-cancelled");
    controller.abort(reason);

    await expect(
      executeRetrievalRequests([{ source, values: { query: "cancel" } }], {
        allowedCapabilities: source.command.capabilities ?? [],
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("advertises composite authentication as optional instead of mandatory", () => {
    for (const site of ["retrieval", "ai"]) {
      const adapter = getAllAdapters().find(
        (candidate) => candidate.name === site,
      )!;
      const command = adapter.commands.search;
      const contract = buildCommandContract({
        adapter,
        commandName: "search",
        command,
      });

      expect(contract.effect.safety_class).toBe("read");
      expect(contract.auth).toEqual({
        strategy: "public",
        required: false,
        optional: true,
        setup_command: "gh auth login",
      });
    }
  });

  it("fuses canonical duplicate URLs while retaining the highest-ranked raw record", () => {
    const sources = listRetrievalSources();
    const yahoo = sources.find((source) => source.ref === "yahoo.search")!;
    const brave = sources.find((source) => source.ref === "brave.search")!;
    const candidates = normalizeEvidenceCandidates(
      [
        {
          source: brave,
          arguments: {},
          retrieved_at: "2026-07-17T00:00:00.000Z",
          results: [
            ...Array.from({ length: 9 }, (_value, index) => ({
              title: `Filler ${index}`,
              url: `https://example.com/filler-${index}`,
            })),
            {
              title: "Stale CXL title",
              url: "https://computeexpresslink.org/spec?utm_source=index",
              snippet: "stale rank-ten record",
            },
          ],
        },
        {
          source: yahoo,
          arguments: {},
          retrieved_at: "2026-07-17T00:00:00.000Z",
          results: [
            {
              title: "Current CXL specification",
              url: "https://computeexpresslink.org/spec#section",
              snippet: "best rank-one record",
            },
          ],
        },
      ],
      10,
    );

    const fused = candidates.find(
      (candidate) => candidate.url === "https://computeexpresslink.org/spec",
    );
    expect(fused).toMatchObject({
      url: "https://computeexpresslink.org/spec",
      title: "Current CXL specification",
      summary: "best rank-one record",
      source_adapter: "yahoo",
      source_rank: 1,
      source_refs: ["brave.search", "yahoo.search"],
      raw: expect.objectContaining({ snippet: "best rank-one record" }),
    });
    expect(fused?.rrf_score).toBeGreaterThan(1 / 61);
  });
});
