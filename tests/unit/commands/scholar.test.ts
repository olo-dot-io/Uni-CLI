/**
 * Tests for `unicli scholar` — capability discovery, source routing, and
 * reciprocal-rank fusion for scholarly work records. These stay on owned code:
 * no network and no mocked registry helpers.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import {
  DEFAULT_SCHOLAR_SOURCES,
  DEFAULT_SCHOLAR_VENUE_SOURCES,
  SCHOLAR_CAPABILITIES,
  SCHOLAR_CONTEXT_CAPABILITIES,
  buildScholarAvailabilityRow,
  buildScholarCoverageRows,
  buildScholarEvidenceRow,
  buildScholarReproducibilityRow,
  buildScholarSourceAuditRows,
  buildScholarWorkflowRow,
  buildScholarTraceRows,
  classifyScholarLiveProbeError,
  coerceToScholarlyRecords,
  findScholarCommandByCapability,
  findScholarContextCommandByCapability,
  findScholarQueryableSearchCommand,
  findScholarResourceSearchCommandByCapability,
  findScholarReviewThreadCommand,
  filterScholarlyRecords,
  filterScholarSearchRecords,
  filterScholarTraceCandidates,
  filterScholarVenueRecords,
  filterTraceResourceRecords,
  hasResourceForCapability,
  inferredConferenceSearchTerms,
  isScholarlyRecordRelevantToRef,
  isScholarlyRecordRelevantToQuery,
  isScholarContextSourceApplicable,
  listScholarSourcesByCapability,
  listScholarAdapters,
  normalizeScholarCommandArgs,
  openReviewRecordFromTraceAvailability,
  parseScholarVenueInput,
  reciprocalRankFusion,
  registerScholarCommand,
  resourceRefFromTraceAvailability,
  resolveScholarArtifactSources,
  resolveScholarFulltextSources,
  resolveScholarReference,
  resolveScholarSources,
  selectOpenReviewTraceRecords,
  selectDatamuseCorrection,
} from "../../../src/commands/scholar.js";
import { findCcfConferenceInText } from "../../../src/adapters/ccf/resolve.js";
import { registerAdapter } from "../../../src/registry.js";
import { AdapterType } from "../../../src/types.js";
import type { AdapterCommand } from "../../../src/types.js";
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
          adapterArgs:
            cmdName === "search"
              ? [
                  {
                    name: "query",
                    type: "str",
                    required: true,
                    positional: true,
                  },
                ]
              : undefined,
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
      "venue",
      "proceedings",
      "availability",
      "sources",
      "workflow",
      "evidence",
      "reproduce",
      "coverage",
      "trace",
      "awards",
      "reviews",
      "get",
      "pdf",
      "code",
      "datasets",
      "download",
      "read",
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
      "scholar.fulltext",
    ]);
    expect(SCHOLAR_CONTEXT_CAPABILITIES).toEqual([
      "scholar.context",
      "scholar.awards",
    ]);
    expect(DEFAULT_SCHOLAR_VENUE_SOURCES).toContain("crossref");
    expect(DEFAULT_SCHOLAR_VENUE_SOURCES).toContain("acm");
    expect(DEFAULT_SCHOLAR_VENUE_SOURCES).toContain("openreview");
    expect(DEFAULT_SCHOLAR_VENUE_SOURCES).toContain("usenix");
  });

  it("enforces exact year, venue, work, and PDF constraints after fan-out", () => {
    const rows: ScholarlyWorkRecord[] = [
      {
        id: "right",
        title: "Right paper",
        year: 2024,
        venue: "IEEE Symposium on Foundations of Computer Science",
        pdf_url: "https://example.test/right.pdf",
        source_adapter: "fixture",
        retrieved_at: "2026-08-09T00:00:00.000Z",
      },
      {
        id: "wrong-venue",
        title: "Wrong venue",
        year: 2024,
        venue: "IEEE Computer Security Foundations Symposium",
        pdf_url: "https://example.test/wrong.pdf",
        source_adapter: "fixture",
        retrieved_at: "2026-08-09T00:00:00.000Z",
      },
      {
        id: "wrong-year",
        title: "Wrong year",
        year: 2023,
        venue: "FOCS",
        pdf_url: "https://example.test/old.pdf",
        source_adapter: "fixture",
        retrieved_at: "2026-08-09T00:00:00.000Z",
      },
      {
        id: "metadata-only",
        title: "Metadata only",
        year: 2024,
        venue: "FOCS",
        source_adapter: "fixture",
        retrieved_at: "2026-08-09T00:00:00.000Z",
      },
      {
        id: "directory",
        title: "Directory row",
        year: 2024,
        venue: "FOCS",
        type: "conference-ranking",
        pdf_url: "https://example.test/directory.pdf",
        source_adapter: "ccf",
        retrieved_at: "2026-08-09T00:00:00.000Z",
      },
    ];

    expect(
      filterScholarlyRecords(rows, {
        year: 2024,
        venue: "FOCS",
        requirePdf: true,
        requireWork: true,
      }).map((row) => row.id),
    ).toEqual(["right"]);
  });

  it("parses a venue year from the positional value unless an explicit year wins", () => {
    expect(parseScholarVenueInput("PPoPP 2025")).toEqual({
      venue: "PPoPP",
      year: 2025,
    });
    expect(parseScholarVenueInput("AAAI 2024", "2025")).toEqual({
      venue: "AAAI",
      year: 2025,
    });
  });

  it("applies a topical venue query after source-specific routing", () => {
    const rows: ScholarlyWorkRecord[] = [
      {
        id: "matching",
        title: "Reliable Agent Planning",
        year: 2025,
        venue: "AAAI",
        source_adapter: "fixture",
        retrieved_at: "2026-08-10T00:00:00.000Z",
      },
      {
        id: "unrelated",
        title: "Vision Language Models",
        year: 2025,
        venue: "AAAI",
        source_adapter: "fixture",
        retrieved_at: "2026-08-10T00:00:00.000Z",
      },
    ];

    expect(
      filterScholarVenueRecords(rows, {
        year: 2025,
        venue: "AAAI",
        query: "reliable agent planning",
      }).map((row) => row.id),
    ).toEqual(["matching"]);
    expect(
      filterScholarVenueRecords(rows, {
        year: 2025,
        venue: "AAAI",
        query: "qzxv impossible title",
      }),
    ).toEqual([]);
  });

  it("uses a DBLP conference year while preserving its publication year", () => {
    const [record] = filterScholarVenueRecords(
      [
        {
          id: "fm-2024",
          title: "Formal Methods 2024",
          year: 2025,
          publication_year: 2025,
          conference_year: 2024,
          venue: "FM,Lecture Notes in Computer Science",
          source_adapter: "dblp",
          retrieved_at: "2026-08-10T00:00:00.000Z",
        },
      ],
      { year: 2024, venue: "FM" },
    );

    expect(record).toMatchObject({ year: 2024, publication_year: 2025 });
    expect(
      filterScholarSearchRecords(
        [
          {
            id: "fm-2024",
            title: "Formal Methods 2024",
            year: 2025,
            publication_year: 2025,
            conference_year: 2024,
            venue: "FM,Lecture Notes in Computer Science",
            source_adapter: "dblp",
            retrieved_at: "2026-08-10T00:00:00.000Z",
          },
        ],
        { query: "", year: 2024, venue: "FM" },
      ),
    ).toHaveLength(1);
  });

  it("removes an inferred conference identity before title relevance checks", () => {
    const ase = findCcfConferenceInText(
      "IEEE ACM Automated Software Engineering 2024",
    );
    expect(ase?.acronym).toBe("ASE");
    expect(
      inferredConferenceSearchTerms(
        "IEEE ACM Automated Software Engineering 2024",
        ase!,
      ),
    ).toBe("");
    expect(
      inferredConferenceSearchTerms("ASE 2024 flaky test repair", ase!),
    ).toBe("flaky test repair");
    const oopsla = findCcfConferenceInText(
      "Proceedings of the ACM on Programming Languages OOPSLA 2024",
    );
    expect(oopsla?.acronym).toBe("OOPSLA");
    expect(
      inferredConferenceSearchTerms(
        "Proceedings of the ACM on Programming Languages OOPSLA 2024",
        oopsla!,
      ),
    ).toBe("");
    expect(findCcfConferenceInText("ACM SIGCOMM 2025")?.acronym).toBe(
      "SIGCOMM",
    );
  });

  it("scopes official conference context sources to supported venues", () => {
    expect(isScholarContextSourceApplicable("iclr", "ICLR", "人工智能")).toBe(
      true,
    );
    expect(isScholarContextSourceApplicable("iclr", "CAV", "理论")).toBe(false);
    expect(
      isScholarContextSourceApplicable(
        "sigchi",
        "UbiComp",
        "人机交互与普适计算",
      ),
    ).toBe(true);
    expect(
      isScholarContextSourceApplicable("sigchi", "SIGCOMM", "计算机网络"),
    ).toBe(false);
    expect(
      isScholarContextSourceApplicable("usenix", "USENIX Security", "安全"),
    ).toBe(true);
    expect(
      isScholarContextSourceApplicable("usenix", "SIGCOMM", "计算机网络"),
    ).toBe(false);
    expect(isScholarContextSourceApplicable("aaai", "AAAI", "人工智能")).toBe(
      true,
    );
    expect(isScholarContextSourceApplicable("aaai", "ICML", "人工智能")).toBe(
      false,
    );
    expect(
      isScholarContextSourceApplicable("pacmpl", "OOPSLA", "软件工程"),
    ).toBe(true);
    expect(
      isScholarContextSourceApplicable("acm", "SIGCOMM", "计算机网络", "ACM"),
    ).toBe(true);
    expect(
      isScholarContextSourceApplicable("ieee", "SIGCOMM", "计算机网络", "ACM"),
    ).toBe(true);
    expect(
      isScholarContextSourceApplicable(
        "ieee",
        "DAC",
        "计算机体系结构/并行与分布计算/存储系统",
        "ACM",
      ),
    ).toBe(true);
  });

  it("classifies live doctor no-match errors as empty rather than failed", () => {
    expect(
      classifyScholarLiveProbeError({
        code: "internal_error",
        message: 'No CVF CVPR2024 papers matched "llama 2".',
      }),
    ).toEqual({
      live_health: "empty",
      live_error_code: "empty_source_result",
      live_error_message: 'No CVF CVPR2024 papers matched "llama 2".',
    });
    expect(
      classifyScholarLiveProbeError({
        code: "upstream_error",
        message: "CVF CVPR2024 failed: HTTP 406.",
      }).live_health,
    ).toBe("failed");
  });
});

describe("scholarly typo recovery", () => {
  it("selects a frequent near spelling while preserving a valid exact word", () => {
    expect(
      selectDatamuseCorrection("recyling", [
        { word: "recyling", tags: ["f:0.01"] },
        { word: "recycling", tags: ["f:3.039"] },
        { word: "relying", tags: ["f:10.0"] },
      ]),
    ).toBe("recycling");
    expect(
      selectDatamuseCorrection("privacy", [
        { word: "privacy", tags: ["f:10.20"] },
        { word: "piracy", tags: ["f:4.0"] },
      ]),
    ).toBeUndefined();
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

  it("builds source coverage rows from registered capability tags without network I/O", () => {
    registerFakeScholarAdapter("fixture-scholar-complete-loop", {
      search: ["http.fetch", "scholar.search"],
      paper: ["http.fetch", "scholar.get", "scholar.pdf", "scholar.fulltext"],
      repo: ["http.fetch", "scholar.code"],
      datasets: ["http.fetch", "scholar.datasets"],
      graph: ["http.fetch", "scholar.citations", "scholar.references"],
      review: ["http.fetch", "scholar.review"],
    });
    const rows = buildScholarCoverageRows(
      listScholarAdapters().filter(
        (adapter) => adapter.name === "fixture-scholar-complete-loop",
      ),
    );
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row).toMatchObject({
      source: "fixture-scholar-complete-loop",
      role: "review-fulltext-source",
      read_strategy: "source-fulltext-then-pdf",
      handoff_strategy: "source-scoped-evidence",
      coverage_score: 9,
      coverage_total: SCHOLAR_CAPABILITIES.length,
      has_search: true,
      has_get: true,
      has_pdf: true,
      has_fulltext: true,
      has_code: true,
      has_datasets: true,
      has_citations: true,
      has_references: true,
      has_review: true,
      missing_closed_loop: [],
      next_availability:
        "unicli scholar availability <ref> --source fixture-scholar-complete-loop",
      next_read:
        "unicli scholar read <ref> --source fixture-scholar-complete-loop",
      next_search: "unicli fixture-scholar-complete-loop search <query>",
      next_get: "unicli fixture-scholar-complete-loop paper <id-or-ref>",
      next_review: "unicli fixture-scholar-complete-loop review <id-or-ref>",
    });
    expect(row.recommended_for).toEqual(
      expect.arrayContaining([
        "discovery",
        "metadata",
        "pdf-download/read",
        "source-fulltext",
        "code/project",
        "datasets/models/spaces",
        "citation-graph",
        "peer-review-audit",
      ]),
    );
  });

  it("prefers review-thread commands over search rows for scholar.review", () => {
    registerAdapter({
      name: "fixture-scholar-review-thread",
      type: AdapterType.WEB_API,
      commands: {
        search: {
          name: "search",
          capabilities: ["http.fetch", "scholar.search", "scholar.review"],
          adapterArgs: [
            { name: "query", type: "str", required: true, positional: true },
          ],
        },
        paper: {
          name: "paper",
          capabilities: ["http.fetch", "scholar.get", "scholar.review"],
          adapterArgs: [
            { name: "id", type: "str", required: true, positional: true },
          ],
        },
        reviews: {
          name: "reviews",
          capabilities: ["http.fetch", "scholar.review"],
          adapterArgs: [
            { name: "forum", type: "str", required: true, positional: true },
          ],
        },
      },
    });
    const adapter = listScholarAdapters().find(
      (candidate) => candidate.name === "fixture-scholar-review-thread",
    )!;

    expect(findScholarReviewThreadCommand(adapter)?.name).toBe("reviews");
    expect(buildScholarCoverageRows([adapter])[0]).toMatchObject({
      source: "fixture-scholar-review-thread",
      next_review: "unicli fixture-scholar-review-thread reviews <id-or-ref>",
    });
  });

  it("selects paper context separately from official award commands", () => {
    registerAdapter({
      name: "fixture-scholar-context",
      type: AdapterType.WEB_API,
      commands: {
        conferences: {
          name: "conferences",
          capabilities: ["http.fetch", "scholar.context"],
          adapterArgs: [{ name: "query", type: "str" }],
        },
        papers: {
          name: "papers",
          capabilities: ["http.fetch", "scholar.venue", "scholar.context"],
          adapterArgs: [
            { name: "conference", type: "str", required: true },
            { name: "query", type: "str" },
          ],
        },
        awards: {
          name: "awards",
          capabilities: ["http.fetch", "scholar.awards", "scholar.context"],
          adapterArgs: [
            { name: "conference", type: "str", required: true },
            { name: "query", type: "str" },
          ],
        },
      },
    });
    const adapter = listScholarAdapters().find(
      (candidate) => candidate.name === "fixture-scholar-context",
    )!;

    expect(
      findScholarContextCommandByCapability(adapter, "scholar.context")?.name,
    ).toBe("papers");
    expect(
      findScholarContextCommandByCapability(adapter, "scholar.awards")?.name,
    ).toBe("awards");
  });

  it("surfaces missing closed-loop capabilities for discovery-only sources", () => {
    const adapter = listScholarAdapters().find(
      (candidate) => candidate.name === "fixture-scholar-a",
    )!;
    const rows = buildScholarCoverageRows([adapter]);
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row).toMatchObject({
      source: "fixture-scholar-a",
      role: "discovery-source",
      read_strategy: "discovery-only",
      handoff_strategy: "discovery-result-to-canonical-workflow",
      has_search: true,
      has_get: false,
      has_pdf: false,
      has_fulltext: false,
      next_availability: undefined,
      next_read: undefined,
      next_search: "unicli fixture-scholar-a search <query>",
      next_workflow_from_result: "unicli scholar workflow <title-or-id>",
      next_sources_from_result: "unicli scholar sources <title-or-id>",
      next_read_from_result: "unicli scholar read <title-or-id>",
    });
    expect(row.missing_closed_loop).toEqual(
      expect.arrayContaining([
        "metadata-get",
        "readable-text",
        "pdf-download",
        "source-fulltext",
        "code/project",
        "datasets/models/spaces",
        "citation/reference-graph",
        "peer-review-audit",
      ]),
    );
  });

  it("classifies Chinese scholarly search-only sources as discovery handoffs", () => {
    registerFakeScholarAdapter("fixture-cnki-like");
    registerFakeScholarAdapter("fixture-wanfang-like");
    const rows = buildScholarCoverageRows(
      listScholarAdapters().filter((adapter) =>
        ["fixture-cnki-like", "fixture-wanfang-like"].includes(adapter.name),
      ),
    );

    expect(rows).toHaveLength(2);
    for (const source of ["fixture-cnki-like", "fixture-wanfang-like"]) {
      expect(rows.find((row) => row.source === source)).toMatchObject({
        source,
        role: "discovery-source",
        read_strategy: "discovery-only",
        handoff_strategy: "discovery-result-to-canonical-workflow",
        has_search: true,
        has_get: false,
        has_pdf: false,
        has_fulltext: false,
        next_availability: undefined,
        next_read: undefined,
        next_search: `unicli ${source} search <query>`,
        next_workflow_from_result: "unicli scholar workflow <title-or-id>",
      });
    }
  });

  it("prefers get-backed commands for source-local PDF references", () => {
    registerFakeScholarAdapter("fixture-scholar-search-and-paper", {
      search: ["http.fetch", "scholar.search", "scholar.pdf"],
      paper: ["http.fetch", "scholar.get", "scholar.pdf"],
    });
    const adapter = listScholarAdapters().find(
      (candidate) => candidate.name === "fixture-scholar-search-and-paper",
    )!;

    expect(findScholarCommandByCapability(adapter, "scholar.pdf")?.name).toBe(
      "paper",
    );
  });

  it("prefers single-paper resource commands over scholarly resource lists", () => {
    registerFakeScholarAdapter("fixture-scholar-resource-list-and-paper", {
      top: ["http.fetch", "scholar.search", "scholar.code", "scholar.datasets"],
      paper: [
        "http.fetch",
        "scholar.get",
        "scholar.pdf",
        "scholar.code",
        "scholar.datasets",
      ],
    });
    const adapter = listScholarAdapters().find(
      (candidate) =>
        candidate.name === "fixture-scholar-resource-list-and-paper",
    )!;

    expect(findScholarCommandByCapability(adapter, "scholar.code")?.name).toBe(
      "paper",
    );
    expect(
      findScholarCommandByCapability(adapter, "scholar.datasets")?.name,
    ).toBe("paper");
  });

  it("uses queryable resource search commands for title fallbacks", () => {
    registerAdapter({
      name: "fixture-scholar-resource-search",
      type: AdapterType.WEB_API,
      commands: {
        top: {
          name: "top",
          capabilities: [
            "http.fetch",
            "scholar.search",
            "scholar.code",
            "scholar.datasets",
          ],
          adapterArgs: [{ name: "limit", type: "int", default: 10 }],
        },
        search: {
          name: "search",
          capabilities: [
            "http.fetch",
            "scholar.search",
            "scholar.code",
            "scholar.datasets",
          ],
          adapterArgs: [
            {
              name: "query",
              type: "str",
              required: true,
              positional: true,
            },
          ],
        },
      },
    });
    const adapter = listScholarAdapters().find(
      (candidate) => candidate.name === "fixture-scholar-resource-search",
    )!;

    expect(
      findScholarResourceSearchCommandByCapability(adapter, "scholar.code")
        ?.name,
    ).toBe("search");
    expect(
      findScholarResourceSearchCommandByCapability(adapter, "scholar.datasets")
        ?.name,
    ).toBe("search");

    expect(buildScholarCoverageRows([adapter])[0]).toMatchObject({
      source: "fixture-scholar-resource-search",
      handoff_strategy: "source-scoped-evidence",
      next_availability:
        "unicli scholar availability <ref> --source fixture-scholar-resource-search",
      next_code: "unicli fixture-scholar-resource-search search <id-or-ref>",
      next_datasets:
        "unicli fixture-scholar-resource-search search <id-or-ref>",
    });
  });

  it("keeps identifier-matched resource search rows for known refs", () => {
    const llama = {
      id: "2307.09288",
      title: "Llama 2: Open Foundation and Fine-Tuned Chat Models",
      code_url: "https://github.com/facebookresearch/llama",
      source_url: "https://huggingface.co/papers/2307.09288",
    } as ScholarlyWorkRecord;
    const unrelated = {
      id: "2606.04038",
      title: "ABACUS: A Comprehensive Benchmark of Applied Computer Science",
      project_url: "https://mondalanindya.github.io/ABACUS/",
      source_url: "https://huggingface.co/papers/2606.04038",
    } as ScholarlyWorkRecord;

    expect(isScholarlyRecordRelevantToQuery(llama, "2307.09288")).toBe(false);
    expect(isScholarlyRecordRelevantToRef(llama, "2307.09288")).toBe(true);
    expect(hasResourceForCapability(llama, "scholar.code")).toBe(true);
    expect(isScholarlyRecordRelevantToRef(unrelated, "2307.09288")).toBe(false);
  });

  it("does not expose list-only resource commands as source-scoped paper lookups", () => {
    registerAdapter({
      name: "fixture-scholar-resource-list-only",
      type: AdapterType.WEB_API,
      commands: {
        top: {
          name: "top",
          capabilities: [
            "http.fetch",
            "scholar.search",
            "scholar.code",
            "scholar.datasets",
          ],
          adapterArgs: [{ name: "limit", type: "int", default: 10 }],
        },
      },
    });
    const adapter = listScholarAdapters().find(
      (candidate) => candidate.name === "fixture-scholar-resource-list-only",
    )!;

    expect(buildScholarCoverageRows([adapter])[0]).toMatchObject({
      source: "fixture-scholar-resource-list-only",
      handoff_strategy: "discovery-result-to-canonical-workflow",
      next_availability: undefined,
      next_code: undefined,
      next_datasets: undefined,
      next_search: "unicli fixture-scholar-resource-list-only top",
      next_workflow_from_result: "unicli scholar workflow <title-or-id>",
    });
  });

  it("uses queryable scholarly search commands for title-to-PDF fallbacks", () => {
    registerAdapter({
      name: "fixture-scholar-latest-and-search",
      type: AdapterType.WEB_API,
      commands: {
        latest: {
          name: "latest",
          capabilities: ["http.fetch", "scholar.search", "scholar.pdf"],
          adapterArgs: [{ name: "limit", type: "int", default: 10 }],
        },
        search: {
          name: "search",
          capabilities: ["http.fetch", "scholar.search", "scholar.pdf"],
          adapterArgs: [
            {
              name: "query",
              type: "str",
              required: true,
              positional: true,
            },
          ],
        },
      },
    });
    const adapter = listScholarAdapters().find(
      (candidate) => candidate.name === "fixture-scholar-latest-and-search",
    )!;

    expect(
      findScholarCommandByCapability(adapter, "scholar.search")?.name,
    ).toBe("latest");
    expect(findScholarQueryableSearchCommand(adapter)?.name).toBe("search");
  });

  it("lists sources by scholarly capability", () => {
    registerFakeScholarAdapter("fixture-scholar-pdf", {
      paper: ["http.fetch", "scholar.pdf"],
      search: ["http.fetch", "scholar.search"],
    });

    expect(listScholarSourcesByCapability("scholar.pdf")).toContain(
      "fixture-scholar-pdf",
    );
    expect(listScholarSourcesByCapability("scholar.pdf")).not.toContain(
      "fixture-scholar-a",
    );
  });

  it("finds resource-capable sources by code and dataset capability", () => {
    registerFakeScholarAdapter("fixture-scholar-resources", {
      paper: [
        "http.fetch",
        "scholar.get",
        "scholar.pdf",
        "scholar.code",
        "scholar.datasets",
      ],
    });

    expect(listScholarSourcesByCapability("scholar.code")).toContain(
      "fixture-scholar-resources",
    );
    expect(listScholarSourcesByCapability("scholar.datasets")).toContain(
      "fixture-scholar-resources",
    );
  });

  it("routes unknown artifact refs across all PDF-capable scholarly sources", () => {
    registerFakeScholarAdapter("fixture-scholar-pdf", {
      paper: ["http.fetch", "scholar.pdf"],
      search: ["http.fetch", "scholar.search"],
    });

    expect(
      resolveScholarArtifactSources(
        undefined,
        undefined,
        resolveScholarReference("latent agent benchmarks"),
      ),
    ).toContain("fixture-scholar-pdf");
    expect(
      resolveScholarArtifactSources(
        "openreview",
        undefined,
        resolveScholarReference("latent agent benchmarks"),
      ),
    ).toEqual(["openreview"]);
  });

  it("routes PMID reads to source-direct fulltext before PDF fallback", () => {
    registerFakeScholarAdapter("pubmed", {
      read: ["http.fetch", "scholar.fulltext"],
      search: ["http.fetch", "scholar.search"],
    });
    registerFakeScholarAdapter("fixture-scholar-fulltext", {
      read: ["http.fetch", "scholar.fulltext"],
      search: ["http.fetch", "scholar.search"],
    });

    expect(
      resolveScholarFulltextSources(
        undefined,
        undefined,
        resolveScholarReference("pmid:12345678"),
      ),
    ).toEqual(["pubmed"]);
    expect(
      resolveScholarFulltextSources(
        undefined,
        undefined,
        resolveScholarReference("latent agent benchmarks"),
      ),
    ).toContain("fixture-scholar-fulltext");
    expect(
      resolveScholarFulltextSources(
        "fixture-scholar-a",
        undefined,
        resolveScholarReference("pmid:12345678"),
      ),
    ).toEqual(["fixture-scholar-a"]);
  });

  it("routes DOI reads to xRxiv source-direct fulltext candidates", () => {
    registerFakeScholarAdapter("biorxiv", {
      read: ["http.fetch", "scholar.fulltext"],
      paper: ["http.fetch", "scholar.get", "scholar.pdf"],
    });
    registerFakeScholarAdapter("medrxiv", {
      read: ["http.fetch", "scholar.fulltext"],
      paper: ["http.fetch", "scholar.get", "scholar.pdf"],
    });

    expect(
      resolveScholarFulltextSources(
        undefined,
        undefined,
        resolveScholarReference("10.64898/2026.06.16.26355814"),
      ),
    ).toEqual(["biorxiv", "medrxiv"]);
  });

  it("filters internal meta-command args to the target command schema", () => {
    const adapter = listScholarAdapters().find(
      (candidate) => candidate.name === "fixture-scholar-b",
    )!;
    const registeredCommand = findScholarCommandByCapability(
      adapter,
      "scholar.get",
    )!.command;
    const command: AdapterCommand = {
      ...registeredCommand,
      adapterArgs: [
        { name: "id", type: "str", required: true },
        { name: "limit", type: "int", default: 20 },
        { name: "volume", type: "str", default: "235" },
        { name: "email", type: "str" },
      ],
    };

    expect(
      normalizeScholarCommandArgs(command, {
        id: "abcDEF123",
        doi: undefined,
        pmid: undefined,
        limit: 5,
        email: "reader@example.test",
        forum: "abcDEF123",
      }),
    ).toEqual({
      id: "abcDEF123",
      limit: 5,
      volume: "235",
      email: "reader@example.test",
    });
  });

  it("coerces internal named args without losing positional command values", () => {
    const command: AdapterCommand = {
      name: "search",
      adapterArgs: [
        { name: "query", type: "str", required: true, positional: true },
        { name: "limit", type: "int", default: 10 },
        { name: "exact", type: "bool", default: false },
      ],
    };

    expect(
      normalizeScholarCommandArgs(command, {
        query: "Llama 2",
        limit: "5",
        exact: "true",
        unused: "drop-me",
      }),
    ).toEqual({
      query: "Llama 2",
      limit: 5,
      exact: true,
    });
  });
});

describe("unicli scholar — reference routing", () => {
  it("routes DOI references to DOI-aware sources", () => {
    expect(resolveScholarReference("10.48550/arXiv.1706.03762")).toEqual({
      kind: "doi",
      value: "10.48550/arXiv.1706.03762",
      preferredSources: [
        "openalex",
        "crossref",
        "datacite",
        "semantic-scholar",
        "unpaywall",
      ],
    });
    expect(
      resolveScholarReference("10.1101/2026.01.02.123456").preferredSources,
    ).toEqual(expect.arrayContaining(["biorxiv", "medrxiv"]));
  });

  it("routes ACM and IEEE DOI prefixes through publisher-aware sources", () => {
    expect(resolveScholarReference("10.1145/123.456").preferredSources[0]).toBe(
      "acm",
    );
    expect(
      resolveScholarReference("https://doi.org/10.1109/5.771073")
        .preferredSources[0],
    ).toBe("ieee");
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
    expect(
      resolveScholarReference("https://openreview.net/forum?id=abcDEF123"),
    ).toEqual({
      kind: "openreview",
      value: "abcDEF123",
      preferredSources: ["openreview", "semantic-scholar", "openalex"],
    });
    expect(resolveScholarReference("6Mxhg9PtDE")).toEqual({
      kind: "openreview",
      value: "6Mxhg9PtDE",
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

describe("unicli scholar — cross-site trace", () => {
  it("excludes similarly named resources from another paper", () => {
    const records: ScholarlyWorkRecord[] = [
      {
        id: "related",
        title:
          "Safety Alignment Should Be Made More Than Just A Few Attention Heads",
        code_url: "https://github.com/example/attention-heads",
        source_adapter: "hf",
        retrieved_at: "2026-08-10T00:00:00Z",
      },
      {
        id: "exact",
        title:
          "Safety Alignment Should be Made More Than Just a Few Tokens Deep",
        code_url: "https://github.com/example/tokens-deep",
        source_adapter: "hf",
        retrieved_at: "2026-08-10T00:00:00Z",
      },
    ];

    expect(
      filterTraceResourceRecords(
        records,
        "Safety Alignment Should be Made More Than Just a Few Tokens Deep",
      ).map((record) => record.id),
    ).toEqual(["exact"]);
  });

  it("uses a title for resource discovery when only an OpenReview id is known", () => {
    expect(
      resourceRefFromTraceAvailability(
        { openreview_id: "forum123" },
        "A Connected Paper",
      ),
    ).toBe("A Connected Paper");
    expect(
      resourceRefFromTraceAvailability(
        { doi: "10.1145/123.456", openreview_id: "forum123" },
        "A Connected Paper",
      ),
    ).toBe("10.1145/123.456");
  });

  it("reuses a resolved OpenReview forum without a second title search", () => {
    expect(
      openReviewRecordFromTraceAvailability({
        id: "source-local-id",
        title: "A Connected Paper",
        openreview_id: "forum123",
        year: 2025,
        venue: "ICLR 2025",
        source_adapter: "semantic-scholar",
        source_url: "https://example.org/record",
        retrieved_at: "2026-08-10T00:00:00Z",
      }),
    ).toMatchObject({
      id: "forum123",
      openreview_id: "forum123",
      source_adapter: "openreview",
      source_url: "https://openreview.net/forum?id=forum123",
    });
  });

  it("applies an explicit venue and year before ranking title matches", () => {
    const records: ScholarlyWorkRecord[] = [
      {
        id: "wrong-year",
        title:
          "Safety Alignment Should be Made More Than Just a Few Tokens Deep",
        year: 2026,
        venue: "International Conference on Learning Representations",
        source_adapter: "crossref",
        retrieved_at: "2026-08-10T00:00:00Z",
      },
      {
        id: "correct-year",
        title:
          "Safety Alignment Should be Made More Than Just a Few Tokens Deep",
        year: 2025,
        venue: "ICLR",
        source_adapter: "openreview",
        retrieved_at: "2026-08-10T00:00:00Z",
      },
    ];

    expect(
      filterScholarTraceCandidates(records, {
        ref: "Safety Alignment Should be Made More Than Just a Few Tokens Deep",
        routeKind: "unknown",
        year: 2025,
        venue: "ICLR",
        venueAlternatives: [
          "International Conference on Learning Representations",
        ],
      }).map((record) => record.id),
    ).toEqual(["correct-year"]);
  });

  it("keeps the canonical OpenReview forum when another forum reused the title", () => {
    const records: ScholarlyWorkRecord[] = [
      {
        id: "preprintForum",
        title: "A Connected Paper",
        openreview_id: "preprintForum",
        source_adapter: "openreview",
        retrieved_at: "2026-08-09T00:00:00Z",
      },
      {
        id: "conferenceForum",
        title: "A Connected Paper",
        openreview_id: "conferenceForum",
        source_adapter: "openreview",
        retrieved_at: "2026-08-09T00:00:00Z",
      },
    ];

    expect(
      selectOpenReviewTraceRecords(
        records,
        "A Connected Paper",
        "conferenceForum",
      ).map((record) => record.id),
    ).toEqual(["conferenceForum"]);
  });

  it("joins publisher, OpenReview, official award, and PDF relationships", () => {
    const rows = buildScholarTraceRows({
      availability: {
        ref: "10.1145/123.456",
        record_found: true,
        id: "10.1145/123.456",
        title: "A Connected Paper",
        year: 2026,
        venue: "CHI 2026",
        doi: "10.1145/123.456",
        pdf_url: "https://example.org/paper.pdf",
        source_adapter: "acm",
        source_url: "https://doi.org/10.1145/123.456",
      },
      openReviewRecords: [
        {
          id: "abcDEF123",
          title: "A Connected Paper",
          openreview_id: "abcDEF123",
          source_adapter: "openreview",
          source_url: "https://openreview.net/forum?id=abcDEF123",
          retrieved_at: "2026-08-09T00:00:00Z",
        },
      ],
      contextRows: [
        {
          id: "42",
          title: "A Connected Paper",
          relation: "official-award",
          award: "Best Paper",
          doi: "10.1145/123.456",
          source_adapter: "sigchi",
          source_url: "https://programs.sigchi.org/chi/2026/program/content/42",
          retrieved_at: "2026-08-09T00:00:00Z",
        },
      ],
    }) as Array<Record<string, unknown>>;

    expect(rows.map((row) => row.relation)).toEqual([
      "publisher-record",
      "peer-review-thread",
      "official-award",
      "pdf",
    ]);
    expect(rows[1]).toMatchObject({
      openreview_id: "abcDEF123",
      next_command: "unicli scholar reviews 'abcDEF123' -D",
    });
    expect(rows[2]).toMatchObject({
      award: "Best Paper",
      source_adapter: "sigchi",
      next_command: "unicli scholar trace '10.1145/123.456'",
    });
  });

  it("keeps code and dataset evidence as source-attributed trace rows", () => {
    const rows = buildScholarTraceRows({
      availability: {
        ref: "2306.14289",
        canonical_ref: "2306.14289",
        record_found: true,
        id: "2306.14289",
        title: "MobileSAM",
        source_adapter: "arxiv",
      },
      openReviewRecords: [],
      contextRows: [],
      resourceRecords: [
        {
          relation: "code",
          record: {
            id: "github:ChaoningZhang/MobileSAM",
            title: "MobileSAM",
            code_url: "https://github.com/ChaoningZhang/MobileSAM",
            source_url: "https://github.com/ChaoningZhang/MobileSAM",
            source_adapter: "github-scholar",
            retrieved_at: "2026-08-10T00:00:00.000Z",
            is_official_code: false,
            relationship_evidence: ["paper DOI appears in README"],
          },
        },
        {
          relation: "dataset",
          record: {
            id: "hf:mobile-sam-data",
            title: "MobileSAM",
            dataset_url: "https://huggingface.co/datasets/mobile-sam-data",
            source_adapter: "hf",
            retrieved_at: "2026-08-10T00:00:00.000Z",
          },
        },
      ],
    }) as Array<Record<string, unknown>>;

    expect(rows.find((row) => row.relation === "code")).toMatchObject({
      source_adapter: "github-scholar",
      is_official_code: false,
      relationship_evidence: ["paper DOI appears in README"],
      next_command: "unicli scholar code '2306.14289' -D",
    });
    expect(rows.find((row) => row.relation === "dataset")).toMatchObject({
      source_adapter: "hf",
      next_command: "unicli scholar datasets '2306.14289' -D",
    });
  });

  it("routes official OpenReview awards directly to reviews and rebuttals", () => {
    const rows = buildScholarTraceRows({
      availability: {
        ref: "openreview:abcDEF123",
        record_found: true,
        id: "abcDEF123",
        title: "An ICLR Award Paper",
        year: 2025,
        venue: "ICLR 2025",
        openreview_id: "abcDEF123",
        source_adapter: "openreview",
        source_url: "https://openreview.net/forum?id=abcDEF123",
      },
      openReviewRecords: [],
      contextRows: [
        {
          id: "abcDEF123",
          title: "An ICLR Award Paper",
          relation: "official-award",
          award: "Outstanding Paper",
          openreview_id: "abcDEF123",
          source_adapter: "iclr",
          source_url: "https://blog.iclr.cc/2025/04/22/iclr-awards/",
          retrieved_at: "2026-08-09T00:00:00Z",
        },
      ],
    }) as Array<Record<string, unknown>>;

    expect(rows[1]).toMatchObject({
      relation: "official-award",
      award: "Outstanding Paper",
      next_command: "unicli scholar reviews 'abcDEF123' -D",
    });
  });
});

describe("unicli scholar — record normalization", () => {
  it("preserves paper resource fields from source adapters", () => {
    const [record] = coerceToScholarlyRecords(
      [
        {
          id: "2606.23489",
          title: "Resourceful Paper",
          authors: "Ada Lovelace; Grace Hopper",
          publishedAt: "2026-06-24",
          pdf_url: "https://arxiv.org/pdf/2606.23489",
          code_url: "https://github.com/example/resourceful-paper",
          project_url: "https://example.test/project",
          dataset_url: "https://huggingface.co/datasets/example/data",
          model_urls: "https://huggingface.co/example/model",
          dataset_urls: "https://huggingface.co/datasets/example/data",
          space_urls: "https://huggingface.co/spaces/example/demo",
          github_stars: "42",
          num_models: "1",
          num_datasets: "2",
          num_spaces: "3",
        },
      ],
      "hf",
    );

    expect(record).toMatchObject({
      id: "2606.23489",
      title: "Resourceful Paper",
      authors: ["Ada Lovelace", "Grace Hopper"],
      date: "2026-06-24",
      year: 2026,
      code_url: "https://github.com/example/resourceful-paper",
      project_url: "https://example.test/project",
      dataset_url: "https://huggingface.co/datasets/example/data",
      model_urls: "https://huggingface.co/example/model",
      dataset_urls: "https://huggingface.co/datasets/example/data",
      space_urls: "https://huggingface.co/spaces/example/demo",
      github_stars: 42,
      num_models: 1,
      num_datasets: 2,
      num_spaces: 3,
    });
  });

  it("preserves search provenance fields from source adapters", () => {
    const [record] = coerceToScholarlyRecords(
      [
        {
          id: "10.64898/2026.06.17.732943",
          title: "The recount3 Python package",
          matched_fields: ["title", "abstract"],
          search_scope: "official_api_date_window",
          search_window: "2026-06-20:2026-06-27",
          search_scanned_records: "30",
          search_total_records: "80",
          search_exhaustive: false,
        },
      ],
      "biorxiv",
    );

    expect(record).toMatchObject({
      matched_fields: ["title", "abstract"],
      search_scope: "official_api_date_window",
      search_window: "2026-06-20:2026-06-27",
      search_scanned_records: 30,
      search_total_records: 80,
      search_exhaustive: false,
    });
  });

  it("does not treat zero linked-resource counts as dataset resources", () => {
    const record: ScholarlyWorkRecord = {
      id: "2606.16613",
      title: "No linked resources yet",
      source_adapter: "hf",
      retrieved_at: "2026-06-27T00:00:00Z",
      num_models: 0,
      num_datasets: 0,
      num_spaces: 0,
    };

    expect(hasResourceForCapability(record, "scholar.datasets")).toBe(false);
    expect(
      hasResourceForCapability(
        { ...record, num_models: 1 },
        "scholar.datasets",
      ),
    ).toBe(true);
  });

  it("filters short title aliases to title-prefix evidence", () => {
    expect(
      isScholarlyRecordRelevantToQuery(
        {
          id: "2307.09288",
          title: "Llama 2: Open Foundation and Fine-Tuned Chat Models",
          source_adapter: "hf",
          retrieved_at: "2026-06-27T00:00:00Z",
        },
        "Llama 2",
      ),
    ).toBe(true);
    expect(
      isScholarlyRecordRelevantToQuery(
        {
          id: "wrong-paper",
          title:
            "Systematic analysis of ChatGPT, Google search and Llama 2 for clinical decision support tasks",
          source_adapter: "semantic-scholar",
          retrieved_at: "2026-06-27T00:00:00Z",
        },
        "Llama 2",
      ),
    ).toBe(false);
  });
});

describe("unicli scholar — availability rows", () => {
  function rec(
    id: string,
    extras: Partial<ScholarlyWorkRecord> = {},
  ): ScholarlyWorkRecord {
    return {
      id,
      title: extras.title ?? id,
      source_adapter: extras.source_adapter ?? "fixture",
      retrieved_at: "2026-06-27T00:00:00Z",
      ...extras,
    };
  }

  it("summarizes source-backed next actions without requiring downloads", () => {
    const row = buildScholarAvailabilityRow({
      ref: "Llama 2",
      route: resolveScholarReference("Llama 2"),
      metadataRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          arxiv_id: "2307.09288",
          source_adapter: "hf",
          source_url: "https://huggingface.co/papers/2307.09288",
        }),
      ],
      pdfRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          pdf_url: "https://arxiv.org/pdf/2307.09288",
          source_adapter: "hf",
        }),
      ],
      codeRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          code_url: "https://github.com/example/llama",
          project_url: "https://ai.meta.com/llama/",
          source_adapter: "hf",
        }),
      ],
      datasetRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          dataset_urls: "https://huggingface.co/datasets/example/data",
          model_urls: "https://huggingface.co/meta-llama/Llama-2-7b",
          num_spaces: 4,
          source_adapter: "hf",
        }),
      ],
      fulltextCandidateSources: ["arxiv"],
      citationCandidateSources: ["semantic-scholar"],
      referenceCandidateSources: ["semantic-scholar"],
      reviewCandidateSources: ["openreview"],
      sourceErrors: ["openalex: empty_result"],
      opts: {},
    });

    expect(row).toMatchObject({
      ref: "Llama 2",
      route_kind: "unknown",
      canonical_ref: "2307.09288",
      canonical_ref_kind: "arxiv",
      record_found: true,
      has_pdf: true,
      has_fulltext_candidate: true,
      has_code: true,
      has_project: true,
      has_datasets: true,
      has_models: true,
      has_spaces: true,
      pdf_sources: ["hf"],
      code_sources: ["hf"],
      dataset_sources: ["hf"],
      citation_candidate_sources: ["semantic-scholar"],
      review_candidate_sources: ["openreview"],
      next_read: "unicli scholar read '2307.09288'",
      next_download: "unicli scholar download '2307.09288'",
      next_workflow: "unicli scholar workflow '2307.09288'",
      next_reproduce: "unicli scholar reproduce '2307.09288'",
      next_code: "unicli scholar code '2307.09288'",
      next_datasets: "unicli scholar datasets '2307.09288'",
    });
  });

  it("compares per-source scholarly evidence without treating candidates as completed audits", () => {
    registerFakeScholarAdapter("arxiv", {
      paper: ["http.fetch", "scholar.get", "scholar.pdf"],
    });
    const openalexRecord = rec("W123", {
      title: "Llama 2",
      year: 2023,
      source_adapter: "openalex",
      source_url: "https://openalex.org/W123",
    });
    const arxivRecord = rec("2307.09288", {
      title: "Llama 2",
      arxiv_id: "2307.09288",
      pdf_url: "https://arxiv.org/pdf/2307.09288",
      source_adapter: "arxiv",
    });
    const hfCodeRecord = rec("2307.09288", {
      title: "Llama 2",
      code_url: "https://github.com/meta-llama/llama",
      project_url: "https://ai.meta.com/llama/",
      source_adapter: "hf",
    });
    const hfDatasetRecord = rec("2307.09288", {
      title: "Llama 2",
      dataset_urls: "https://huggingface.co/datasets/example/data",
      model_urls: "https://huggingface.co/meta-llama/Llama-2-7b",
      source_adapter: "hf",
    });
    const availability = buildScholarAvailabilityRow({
      ref: "Llama 2",
      route: resolveScholarReference("Llama 2"),
      metadataRecords: [openalexRecord],
      pdfRecords: [arxivRecord],
      codeRecords: [hfCodeRecord],
      datasetRecords: [hfDatasetRecord],
      fulltextCandidateSources: ["arxiv"],
      citationCandidateSources: ["semantic-scholar"],
      referenceCandidateSources: ["semantic-scholar"],
      reviewCandidateSources: ["openreview"],
      sourceErrors: ["semantic-scholar: rate_limited"],
      opts: {},
    });
    const rows = buildScholarSourceAuditRows(availability, [
      {
        source: "openalex",
        capability: "scholar.get",
        records: [openalexRecord],
      },
      {
        source: "arxiv",
        capability: "scholar.get",
        records: [],
        error: {
          code: "internal_error",
          message: "HTTP 400 Bad Request from arXiv title lookup",
        },
      },
      { source: "arxiv", capability: "scholar.pdf", records: [arxivRecord] },
      { source: "hf", capability: "scholar.code", records: [hfCodeRecord] },
      {
        source: "hf",
        capability: "scholar.datasets",
        records: [hfDatasetRecord],
      },
      {
        source: "semantic-scholar",
        capability: "scholar.get",
        records: [],
        error: {
          code: "rate_limited",
          message: "semantic scholar returned HTTP 429",
          retryable: true,
        },
      },
      {
        source: "crossref",
        capability: "scholar.pdf",
        records: [],
        error: {
          code: "capability_unsupported",
          message: "crossref does not expose scholar.pdf",
        },
      },
      {
        source: "fixture-scholar-a",
        capability: "scholar.get",
        records: [],
        error: {
          code: "capability_unsupported",
          message: "fixture-scholar-a does not expose scholar.get",
        },
      },
    ] as Parameters<typeof buildScholarSourceAuditRows>[1]);

    expect(rows.find((row) => row.source === "arxiv")).toMatchObject({
      canonical_ref: "2307.09288",
      canonical_ref_kind: "arxiv",
      source_status: "evidence_found",
      evidence_types: ["pdf", "fulltext-candidate"],
      has_pdf: true,
      has_fulltext_candidate: true,
      blocking_errors: [],
      recovered_errors: [
        "arxiv: internal_error (HTTP 400 Bad Request from arXiv title lookup)",
      ],
      next_source_availability:
        "unicli scholar availability '2307.09288' --source 'arxiv'",
      next_read: "unicli scholar read '2307.09288' --source 'arxiv'",
      next_download: "unicli scholar download '2307.09288' --source 'arxiv'",
    });
    expect(rows.find((row) => row.source === "hf")).toMatchObject({
      source_status: "evidence_found",
      evidence_types: ["code", "project", "datasets", "models"],
      has_code: true,
      has_datasets: true,
      next_code: "unicli scholar code '2307.09288' --source 'hf'",
      next_datasets: "unicli scholar datasets '2307.09288' --source 'hf'",
    });
    expect(rows.find((row) => row.source === "semantic-scholar")).toMatchObject(
      {
        source_status: "candidate_with_errors",
        evidence_types: ["citation-candidate", "reference-candidate"],
        candidate_capabilities: ["scholar.citations", "scholar.references"],
        blocking_errors: [
          "semantic-scholar: rate_limited (semantic scholar returned HTTP 429)",
        ],
        next_citations:
          "unicli scholar citations '2307.09288' --source 'semantic-scholar'",
        next_references:
          "unicli scholar references '2307.09288' --source 'semantic-scholar'",
      },
    );
    expect(
      rows.find((row) => row.source === "fixture-scholar-a"),
    ).toMatchObject({
      source_status: "unsupported",
      evidence_types: [],
      handoff_strategy: "discovery-result-to-canonical-workflow",
      next_source_availability: undefined,
      next_search: "unicli fixture-scholar-a search <query>",
      next_workflow_from_result: "unicli scholar workflow <title-or-id>",
      next_sources_from_result: "unicli scholar sources <title-or-id>",
      next_read_from_result: "unicli scholar read <title-or-id>",
    });
    expect(rows.find((row) => row.source === "openreview")).toMatchObject({
      source_status: "candidate_only",
      evidence_types: ["review-candidate"],
      next_reviews: "unicli scholar reviews 'Llama 2' --source 'openreview'",
    });
    expect(rows.find((row) => row.source === "crossref")).toMatchObject({
      source_status: "unsupported",
      evidence_types: [],
      source_errors: [
        "crossref: capability_unsupported (crossref does not expose scholar.pdf)",
      ],
    });
  });

  it("builds an agent runbook for the full scholarly closed loop", () => {
    const availability = buildScholarAvailabilityRow({
      ref: "Llama 2",
      route: resolveScholarReference("Llama 2"),
      metadataRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          arxiv_id: "2307.09288",
          source_adapter: "hf",
          source_url: "https://huggingface.co/papers/2307.09288",
        }),
      ],
      pdfRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          pdf_url: "https://arxiv.org/pdf/2307.09288",
          source_adapter: "arxiv",
        }),
      ],
      codeRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          code_url: "https://github.com/meta-llama/llama",
          project_url: "https://ai.meta.com/llama/",
          source_adapter: "hf",
        }),
      ],
      datasetRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          dataset_urls: "https://huggingface.co/datasets/example/data",
          model_urls: "https://huggingface.co/meta-llama/Llama-2-7b",
          source_adapter: "hf",
        }),
      ],
      fulltextCandidateSources: ["arxiv"],
      citationCandidateSources: ["semantic-scholar"],
      referenceCandidateSources: ["semantic-scholar"],
      reviewCandidateSources: ["openreview"],
      sourceErrors: [],
      opts: {},
    });

    const workflow = buildScholarWorkflowRow(availability);

    expect(workflow).toMatchObject({
      ref: "Llama 2",
      route_kind: "unknown",
      canonical_ref: "2307.09288",
      canonical_ref_kind: "arxiv",
      workflow_status: "ready_for_agent_reading",
      next_step: "run_next_read_before_quoting_claims",
      claim_boundary: "quote_claims_only_after_next_read_output",
      execution_boundary: "no_download_clone_install_or_remote_code_execution",
      completed_steps: [
        "source_record_found",
        "primary_anchor_found",
        "readable_source_found",
        "downloadable_pdf_found",
        "citation_reference_candidate_found",
        "peer_review_candidate_found",
        "reproducibility_resource_found",
      ],
      pending_steps: ["source_text_reading", "resource_inspection"],
      blocked_steps: [],
      next_read: "unicli scholar read '2307.09288'",
      next_evidence: "unicli scholar evidence '2307.09288'",
      next_reproduce: "unicli scholar reproduce '2307.09288'",
    });
    expect(workflow.agent_runbook).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: "read_source_text",
          status: "ready",
          command: "unicli scholar read '2307.09288'",
          guard: "quote claims only from the returned source text",
        }),
        expect.objectContaining({
          step: "reproducibility_plan",
          status: "ready",
          command: "unicli scholar reproduce '2307.09288'",
          guard: "never clone, install, or run remote code during planning",
        }),
      ]),
    );
  });

  it("does not mark resource inspection ready when the selected scope has no resource-capable source", () => {
    registerFakeScholarAdapter("fixture-scholar-readable-only", {
      paper: ["http.fetch", "scholar.get", "scholar.pdf"],
    });
    const availability = buildScholarAvailabilityRow({
      ref: "Llama 2",
      route: resolveScholarReference("2307.09288"),
      metadataRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          arxiv_id: "2307.09288",
          source_adapter: "fixture-scholar-readable-only",
          source_url: "https://example.test/2307.09288",
        }),
      ],
      pdfRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          arxiv_id: "2307.09288",
          pdf_url: "https://example.test/2307.09288.pdf",
          source_adapter: "fixture-scholar-readable-only",
        }),
      ],
      codeRecords: [],
      datasetRecords: [],
      fulltextCandidateSources: [],
      citationCandidateSources: [],
      referenceCandidateSources: [],
      reviewCandidateSources: [],
      sourceErrors: [],
      opts: { source: "fixture-scholar-readable-only" },
    });
    const workflow = buildScholarWorkflowRow(availability);

    expect(availability).toMatchObject({
      next_read:
        "unicli scholar read '2307.09288' --source 'fixture-scholar-readable-only'",
      next_code: undefined,
      next_datasets: undefined,
    });
    expect(workflow).toMatchObject({
      workflow_status: "ready_for_agent_reading",
      next_read:
        "unicli scholar read '2307.09288' --source 'fixture-scholar-readable-only'",
      next_code: undefined,
      next_datasets: undefined,
    });
    expect(workflow.pending_steps).toContain("code_data_model_resources");
    expect(workflow.blocked_steps).toContain("reproducibility_installation");
    expect(workflow.agent_runbook).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: "inspect_code_and_resources",
          status: "blocked",
        }),
      ]),
    );
  });

  it("keeps metadata-only scholarly workflows unsafe for claim quotation", () => {
    const availability = buildScholarAvailabilityRow({
      ref: "10.1000/example",
      route: resolveScholarReference("10.1000/example"),
      metadataRecords: [
        rec("10.1000/example", {
          doi: "10.1000/example",
          source_adapter: "crossref",
          source_url: "https://doi.org/10.1000/example",
        }),
      ],
      pdfRecords: [],
      codeRecords: [],
      datasetRecords: [],
      fulltextCandidateSources: [],
      citationCandidateSources: [],
      referenceCandidateSources: [],
      reviewCandidateSources: [],
      sourceErrors: [],
      opts: { source: "crossref" },
    });

    expect(buildScholarWorkflowRow(availability)).toMatchObject({
      workflow_status: "metadata_only_needs_source_text",
      next_step: "find_readable_source",
      claim_boundary: "metadata_only_no_claim_extraction",
      completed_steps: ["source_record_found", "primary_anchor_found"],
      pending_steps: [
        "readable_source",
        "citation_reference_graph",
        "peer_review_audit",
        "code_data_model_resources",
      ],
      blocked_steps: [
        "source_reading",
        "claim_quotation",
        "artifact_download",
        "citation_reference_audit",
        "peer_review_audit",
        "reproducibility_installation",
      ],
      next_read: undefined,
      next_download: undefined,
      next_reproduce:
        "unicli scholar reproduce '10.1000/example' --source 'crossref'",
    });
  });

  it("classifies availability evidence into citation safety and missing evidence", () => {
    const availability = buildScholarAvailabilityRow({
      ref: "Llama 2",
      route: resolveScholarReference("Llama 2"),
      metadataRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          arxiv_id: "2307.09288",
          source_adapter: "hf",
          source_url: "https://huggingface.co/papers/2307.09288",
        }),
      ],
      pdfRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          pdf_url: "https://arxiv.org/pdf/2307.09288",
          source_adapter: "arxiv",
        }),
      ],
      codeRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          project_url: "https://ai.meta.com/llama/",
          source_adapter: "hf",
        }),
      ],
      datasetRecords: [],
      fulltextCandidateSources: ["arxiv"],
      citationCandidateSources: ["semantic-scholar"],
      referenceCandidateSources: [],
      reviewCandidateSources: [],
      sourceErrors: [],
      opts: {},
    });

    expect(buildScholarEvidenceRow(availability)).toMatchObject({
      ref: "Llama 2",
      route_kind: "unknown",
      evidence_status: "readable_source_verified",
      citation_safety: "cite_after_reading_source",
      readiness: "read_now",
      claim_boundary: "quote_claims_only_after_next_read_output",
      primary_source: "hf",
      primary_evidence_url: "https://huggingface.co/papers/2307.09288",
      persistent_identifiers: ["arxiv:2307.09288"],
      readable_sources: ["arxiv"],
      resource_sources: ["hf"],
      graph_sources: ["semantic-scholar"],
      review_sources: [],
      missing_evidence: ["datasets/models/spaces", "peer-review-audit"],
      next_read: "unicli scholar read '2307.09288'",
      next_code: "unicli scholar code '2307.09288'",
      next_datasets: "unicli scholar datasets '2307.09288'",
      next_citations: "unicli scholar citations '2307.09288'",
    });
  });

  it("marks metadata-only evidence as unsafe for claim quoting", () => {
    const availability = buildScholarAvailabilityRow({
      ref: "10.1000/example",
      route: resolveScholarReference("10.1000/example"),
      metadataRecords: [
        rec("10.1000/example", {
          doi: "10.1000/example",
          source_adapter: "crossref",
          source_url: "https://doi.org/10.1000/example",
        }),
      ],
      pdfRecords: [],
      codeRecords: [],
      datasetRecords: [],
      fulltextCandidateSources: [],
      citationCandidateSources: [],
      referenceCandidateSources: [],
      reviewCandidateSources: [],
      sourceErrors: [],
      opts: { source: "crossref" },
    });

    expect(buildScholarEvidenceRow(availability)).toMatchObject({
      evidence_status: "metadata_verified",
      citation_safety: "metadata_only_do_not_quote_claims",
      readiness: "metadata_or_resource_only",
      claim_boundary: "metadata_only_no_claim_extraction",
      missing_evidence: [
        "readable-text",
        "code/project",
        "datasets/models/spaces",
        "citation/reference-graph",
        "peer-review-audit",
      ],
      next_read: undefined,
      next_download: undefined,
    });
  });

  it("plans reproducibility without executing remote code", () => {
    const availability = buildScholarAvailabilityRow({
      ref: "Llama 2",
      route: resolveScholarReference("Llama 2"),
      metadataRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          arxiv_id: "2307.09288",
          source_adapter: "hf",
          source_url: "https://huggingface.co/papers/2307.09288",
        }),
      ],
      pdfRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          pdf_url: "https://arxiv.org/pdf/2307.09288",
          source_adapter: "arxiv",
        }),
      ],
      codeRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          code_url: "https://github.com/meta-llama/llama",
          project_url: "https://ai.meta.com/llama/",
          source_adapter: "hf",
        }),
      ],
      datasetRecords: [
        rec("2307.09288", {
          title: "Llama 2",
          dataset_urls: "https://huggingface.co/datasets/example/data",
          model_urls: "https://huggingface.co/meta-llama/Llama-2-7b",
          source_adapter: "hf",
        }),
      ],
      fulltextCandidateSources: ["arxiv"],
      citationCandidateSources: ["semantic-scholar"],
      referenceCandidateSources: [],
      reviewCandidateSources: [],
      sourceErrors: [],
      opts: {},
    });

    expect(buildScholarReproducibilityRow(availability)).toMatchObject({
      ref: "Llama 2",
      reproducibility_status: "code_and_resources_found",
      install_readiness: "clone_candidate_requires_inspection",
      execution_boundary: "no_remote_code_executed",
      install_boundary:
        "inspect_repository_before_running_install_or_training_commands",
      code_url: "https://github.com/meta-llama/llama",
      project_url: "https://ai.meta.com/llama/",
      clone_candidate_url: "https://github.com/meta-llama/llama",
      dataset_urls: "https://huggingface.co/datasets/example/data",
      model_urls: "https://huggingface.co/meta-llama/Llama-2-7b",
      resource_sources: ["hf"],
      missing_reproducibility: [],
      next_evidence: "unicli scholar evidence '2307.09288'",
      next_read: "unicli scholar read '2307.09288'",
      next_code: "unicli scholar code '2307.09288'",
      next_datasets: "unicli scholar datasets '2307.09288'",
    });
  });

  it("does not treat project-only links as clone-ready repositories", () => {
    const availability = buildScholarAvailabilityRow({
      ref: "project only",
      route: resolveScholarReference("project only"),
      metadataRecords: [
        rec("project-only", {
          title: "Project Only",
          source_adapter: "hf",
          source_url: "https://huggingface.co/papers/project-only",
        }),
      ],
      pdfRecords: [],
      codeRecords: [
        rec("project-only", {
          title: "Project Only",
          project_url: "https://example.com/project",
          source_adapter: "hf",
        }),
      ],
      datasetRecords: [],
      fulltextCandidateSources: [],
      citationCandidateSources: [],
      referenceCandidateSources: [],
      reviewCandidateSources: [],
      sourceErrors: [],
      opts: {},
    });

    expect(buildScholarReproducibilityRow(availability)).toMatchObject({
      reproducibility_status: "project_page_found",
      install_readiness: "project_page_requires_manual_inspection",
      clone_candidate_url: undefined,
      missing_reproducibility: [
        "code-repository",
        "datasets/models/spaces",
        "readable-paper",
        "citation-graph",
      ],
    });
  });
});
