/**
 * Owned mapper and routing tests for publisher, conference-program, and
 * research-object adapters. Fixtures are reduced official response shapes;
 * no external request is mocked or executed.
 */

import { describe, expect, it } from "vitest";

import {
  isCrossrefResearchContent,
  isCrossrefVenueMatch,
  mapCrossrefItem,
  requireCrossrefPrefixDoi,
} from "../../../src/adapters/_shared/crossref.js";
import {
  buildIeeeXploreParams,
  mapIeeeXploreArticle,
  requireIeeeXploreApiKey,
} from "../../../src/adapters/ieee-xplore/articles.js";
import { resolveIeeeVenueQuery } from "../../../src/adapters/ieee/works.js";
import {
  mapSigchiContent,
  resolveSigchiConference,
  type SigchiProgram,
} from "../../../src/adapters/sigchi/programs.js";
import { mapDataCiteResource } from "../../../src/adapters/datacite/dois.js";
import {
  parseIclrAwardPost,
  selectIclrAwardPost,
} from "../../../src/adapters/iclr/awards.js";
import {
  pacmplIssuesForConferenceYear,
  parseSigmodIssuePairs,
  resolveAcmPublicationJournal,
  siggraphVolumeIssue,
} from "../../../src/adapters/acm/works.js";

describe("ACM and IEEE publisher metadata", () => {
  it("maps Crossref publisher deposits and enforces DOI ownership", () => {
    const row = mapCrossrefItem(
      {
        DOI: "10.1145/123.456",
        title: ["A CHI Paper"],
        author: [{ given: "Ada", family: "Lovelace" }],
        "container-title": ["CHI 2026"],
        issued: { "date-parts": [[2026, 4, 13]] },
        type: "proceedings-article",
        URL: "https://doi.org/10.1145/123.456",
        link: [
          {
            URL: "https://dl.acm.org/doi/pdf/10.1145/123.456",
            "content-type": "application/pdf",
          },
        ],
      },
      "acm",
    );

    expect(row).toMatchObject({
      id: "10.1145/123.456",
      title: "A CHI Paper",
      authors: ["Ada Lovelace"],
      year: 2026,
      date: "2026-04-13",
      venue: "CHI 2026",
      source_adapter: "acm",
      pdf_url: "https://dl.acm.org/doi/pdf/10.1145/123.456",
    });
    expect(requireCrossrefPrefixDoi(row.doi, "10.1145", "acm")).toBe(
      "10.1145/123.456",
    );
    expect(() =>
      requireCrossrefPrefixDoi("10.1109/5.771073", "10.1145", "acm"),
    ).toThrow("does not use prefix 10.1145");
    try {
      requireCrossrefPrefixDoi("10.1109/5.771073", "10.1145", "acm");
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid_input",
        retryable: false,
      });
    }
  });

  it("accepts exact conference identities and rejects nearby acronyms", () => {
    expect(
      isCrossrefVenueMatch(
        "Proceedings of the ACM SIGPLAN Conference on Programming Language Design and Implementation",
        "PLDI",
      ),
    ).toBe(true);
    expect(
      isCrossrefVenueMatch(
        "Proceedings of the Twentieth European Conference on Computer Systems",
        "European Conference on Computer Systems",
      ),
    ).toBe(true);
    expect(
      isCrossrefVenueMatch(
        "Proceedings of the 31st ACM SIGKDD Conference on Knowledge Discovery and Data Mining V.1",
        "ACM SIGKDD Conference on Knowledge Discovery and Data Mining",
      ),
    ).toBe(true);
    expect(
      isCrossrefVenueMatch(
        "Data Mining and Knowledge Discovery",
        "ACM SIGKDD Conference on Knowledge Discovery and Data Mining",
      ),
    ).toBe(false);
    expect(
      isCrossrefVenueMatch(
        "ACM Symposium on Principles of Programming Languages",
        "POPL",
      ),
    ).toBe(true);
    expect(
      isCrossrefVenueMatch(
        "IEEE Symposium on Foundations of Computer Science",
        "FOCS",
      ),
    ).toBe(true);
    expect(
      isCrossrefVenueMatch("IEEE Symposium on Security and Privacy", "S&P"),
    ).toBe(true);
    expect(
      isCrossrefVenueMatch(
        "Asia and South Pacific Design Automation Conference (ASP-DAC)",
        "DAC",
      ),
    ).toBe(false);
    expect(
      isCrossrefVenueMatch(
        "2024 29th Asia and South Pacific Design Automation Conference (ASP-DAC)",
        "ASP-DAC",
      ),
    ).toBe(true);
    expect(
      isCrossrefVenueMatch(
        "2024 29th Asia and South Pacific Design Automation Conference (ASP-DAC)",
        "Asia and South Pacific Design Automation Conference",
      ),
    ).toBe(true);
    expect(
      isCrossrefVenueMatch("Participatory Design Conference", "PLDI"),
    ).toBe(false);
    expect(
      isCrossrefVenueMatch(
        "IEEE Computer Security Foundations Symposium",
        "FOCS",
      ),
    ).toBe(false);
    expect(
      isCrossrefVenueMatch(
        "2025 IEEE Regional Symposium on Micro and Nanoelectronics",
        "MICRO",
      ),
    ).toBe(false);
    expect(
      isCrossrefVenueMatch(
        "Proceedings of the 2025 International Conference on Management of Data Companion",
        "International Conference on Management of Data",
      ),
    ).toBe(false);
    expect(
      isCrossrefVenueMatch(
        "Proceedings of the 2025 International Conference on Management of Data",
        "International Conference on Management of Data",
      ),
    ).toBe(true);
    expect(
      isCrossrefVenueMatch("SIGGRAPH Asia 2024 Conference Papers", "SIGGRAPH"),
    ).toBe(false);
    expect(isCrossrefVenueMatch("ACM SIGGRAPH 2024 Talks", "SIGGRAPH")).toBe(
      false,
    );
    expect(
      isCrossrefVenueMatch(
        "Proceedings of the ACM on Software Engineering",
        "PACMSE",
      ),
    ).toBe(true);
    expect(
      isCrossrefVenueMatch(
        "PACMMOD",
        "Proceedings of the ACM on Management of Data",
      ),
    ).toBe(true);
    expect(
      isCrossrefVenueMatch(
        "Proceedings of the 30th ACM International Conference on Architectural Support for Programming Languages and Operating Systems, Volume 2",
        "International Conference on Architectural Support for Programming Languages and Operating Systems",
      ),
    ).toBe(true);
    expect(
      isCrossrefVenueMatch(
        "Proceedings of the 46th International Conference on Software Engineering: Software Engineering in Society",
        "International Conference on Software Engineering",
      ),
    ).toBe(false);
  });

  it("filters proceedings containers and administrative front matter", () => {
    expect(
      isCrossrefResearchContent({
        title: "A Verified Research Paper",
        type: "proceedings-article",
      }),
    ).toBe(true);
    expect(
      isCrossrefResearchContent({
        title: "Table of Contents",
        type: "proceedings-article",
      }),
    ).toBe(false);
    expect(
      isCrossrefResearchContent({
        title: "Proceedings of CVPR 2026",
        type: "proceedings",
      }),
    ).toBe(false);
    expect(
      isCrossrefResearchContent({
        title: "Title Page iii",
        type: "proceedings-article",
      }),
    ).toBe(false);
    expect(
      isCrossrefResearchContent({
        title: "PACMMOD V3, N3 (SIGMOD), June 2025: Editorial",
        type: "journal-article",
      }),
    ).toBe(false);
  });

  it("extracts unique PACMMOD issue identities from a SIGMOD paper index", () => {
    expect(
      parseSigmodIssuePairs(`
        <a>Proceedings of the ACM on Management of Data, Volume 3, Issue 3</a>
        <a>Proceedings of the ACM on Management of Data, Volume 3, Issue 1</a>
        <a>Proceedings of the ACM on Management of Data, Volume 3, Issue 3</a>
        <a href="https://dl.acm.org/toc/PACMMOD/2026/4/1">Round 3</a>
        <a href="https://dl.acm.org/toc/pacmmod/2026/4/3">Round 4</a>
      `),
    ).toEqual([
      { volume: "3", issue: "3" },
      { volume: "3", issue: "1" },
      { volume: "4", issue: "1" },
      { volume: "4", issue: "3" },
    ]);
  });

  it("resolves ACM publication journals and conference-specific issue models", () => {
    expect(resolveAcmPublicationJournal("PACMSE")?.issn).toBe("2994-970X");
    expect(
      resolveAcmPublicationJournal(
        "Proceedings of the ACM on Management of Data",
      )?.acronym,
    ).toBe("PACMMOD");
    expect(pacmplIssuesForConferenceYear("OOPSLA", 2021)).toEqual(["OOPSLA"]);
    expect(pacmplIssuesForConferenceYear("OOPSLA", 2024)).toEqual([
      "OOPSLA1",
      "OOPSLA2",
    ]);
    expect(siggraphVolumeIssue(2024)).toEqual({ volume: "43", issue: "4" });
  });

  it("builds bounded IEEE Xplore requests and maps official article fields", () => {
    expect(resolveIeeeVenueQuery("ASP-DAC")).toEqual({
      containerTitle: "Asia and South Pacific Design Automation Conference",
      aliases: ["ASP-DAC", "ASP-DAC"],
    });
    const params = buildIeeeXploreParams("secret", {
      querytext: "human robot interaction",
      publication_year: 2025,
      limit: 200,
      start: 201,
    });
    expect(params.get("apikey")).toBe("secret");
    expect(params.get("max_records")).toBe("200");
    expect(params.get("start_record")).toBe("201");
    expect(params.get("publication_year")).toBe("2025");

    expect(requireIeeeXploreApiKey({ IEEE_API_KEY: "fallback" })).toBe(
      "fallback",
    );
    expect(() => requireIeeeXploreApiKey({})).toThrow("IEEE_XPLORE_API_KEY");

    expect(
      mapIeeeXploreArticle({
        article_number: "12345678",
        title: "Robots in the Wild",
        authors: { authors: [{ full_name: "Grace Hopper" }] },
        publication_title: "2025 IEEE HRI",
        publication_year: "2025",
        content_type: "Conferences",
        doi: "10.1109/HRI.2025.12345678",
        citing_paper_count: 7,
        pdf_url:
          "https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=12345678",
        html_url: "https://ieeexplore.ieee.org/document/12345678",
        access_type: "LOCKED",
      }),
    ).toMatchObject({
      id: "12345678",
      title: "Robots in the Wild",
      authors: ["Grace Hopper"],
      year: 2025,
      venue: "2025 IEEE HRI",
      doi: "10.1109/HRI.2025.12345678",
      cited_by_count: 7,
      source_adapter: "ieee-xplore",
    });
  });
});

describe("SIGCHI official program context", () => {
  const entries = [
    {
      conference: {
        id: 100,
        shortName: "CHI",
        year: 2025,
        name: "CHI 2025",
        fullName: "ACM CHI Conference on Human Factors in Computing Systems",
      },
    },
    {
      conference: {
        id: 101,
        shortName: "CHI",
        year: 2026,
        name: "CHI 2026",
        fullName: "ACM CHI Conference on Human Factors in Computing Systems",
      },
    },
  ];

  it("resolves acronyms, full venue names, and the latest edition", () => {
    expect(resolveSigchiConference(entries, "CHI").conference?.id).toBe(101);
    expect(
      resolveSigchiConference(
        entries,
        "Proceedings of the ACM CHI Conference on Human Factors in Computing Systems",
        2025,
      ).conference?.id,
    ).toBe(100);
  });

  it("classifies an unknown SIGCHI conference as an empty result", () => {
    expect(() => resolveSigchiConference([], "CHI", 2099)).toThrowError(
      expect.objectContaining({ code: "empty_result", retryable: false }),
    );
  });

  it("joins people, DOI, content type, and award into one context row", () => {
    const program: SigchiProgram = {
      conference: {
        id: 101,
        shortName: "CHI",
        year: 2026,
        name: "CHI 2026",
        fullName: "ACM CHI Conference on Human Factors in Computing Systems",
        url: "https://chi2026.acm.org",
      },
      people: [
        { id: 1, firstName: "Ada", lastName: "Lovelace" },
        { id: 2, firstName: "Alan", lastName: "Turing" },
      ],
      contentTypes: [{ id: 7, displayName: "Papers" }],
    };
    const row = mapSigchiContent(
      {
        id: 42,
        typeId: 7,
        title: "An Award Paper",
        abstract: "Evidence from the official program.",
        award: "BEST_PAPER",
        authors: [{ personId: 1 }, { personId: 2 }],
        addons: {
          doi: { url: "https://doi.org/10.1145/123.456" },
        },
      },
      program,
    );

    expect(row).toMatchObject({
      id: "42",
      title: "An Award Paper",
      relation: "official-award",
      authors: ["Ada Lovelace", "Alan Turing"],
      venue: "CHI 2026",
      type: "Papers",
      doi: "10.1145/123.456",
      award: "Best Paper",
      source_adapter: "sigchi",
      source_url: "https://programs.sigchi.org/chi/2026/program/content/42",
    });
  });

  it("normalizes scheme-less SIGCHI DOI add-ons", () => {
    const row = mapSigchiContent(
      {
        id: 43,
        title: "A UIST Paper",
        addons: { doi: { url: "doi.org/10.1145/123.789" } },
      },
      {
        conference: { id: 102, shortName: "UIST", year: 2025 },
      },
    );
    expect(row).toMatchObject({
      doi: "10.1145/123.789",
      landing_url: "https://doi.org/10.1145/123.789",
    });
  });
});

describe("DataCite research objects", () => {
  it("maps dataset DOI metadata into scholar resource fields", () => {
    expect(
      mapDataCiteResource({
        id: "10.5281/zenodo.1234",
        attributes: {
          doi: "10.5281/zenodo.1234",
          titles: [{ title: "Evaluation Dataset" }],
          creators: [{ givenName: "Katherine", familyName: "Johnson" }],
          publicationYear: 2026,
          publisher: "Zenodo",
          types: {
            resourceType: "Dataset",
            resourceTypeGeneral: "Dataset",
          },
          descriptions: [{ description: "Data supporting the paper." }],
          url: "https://zenodo.org/records/1234",
        },
      }),
    ).toMatchObject({
      id: "10.5281/zenodo.1234",
      title: "Evaluation Dataset",
      authors: ["Katherine Johnson"],
      year: 2026,
      venue: "Zenodo",
      dataset_url: "https://zenodo.org/records/1234",
      source_adapter: "datacite",
    });
  });
});

describe("ICLR official award announcements", () => {
  const posts = [
    {
      id: 1014,
      date: "2025-04-22T19:16:11",
      link: "https://blog.iclr.cc/2025/04/22/iclr-awards/",
      title: {
        rendered: "Announcing the Outstanding Paper Awards at ICLR 2025",
      },
      content: {
        rendered: `
          <h2>Outstanding Papers</h2>
          <ul><li>
            <a href="https://openreview.net/forum?id=6Mxhg9PtDE">Safety Alignment.</a>
            Xiangyu Qi, Ashwinee Panda.
          </li></ul>
          <h2>Honorable Mentions</h2>
          <ul><li>
            <a href="https://openreview.net/forum?id=HD6bWcj87Y">Data Shapley in One Training Run.</a>
            Jiachen T. Wang, Ruoxi Jia.
          </li></ul>
        `,
      },
    },
    {
      id: 1141,
      date: "2026-04-23T05:28:51",
      link: "https://blog.iclr.cc/2026/04/23/iclr-awards/",
      title: { rendered: "Announcing the ICLR 2026 Outstanding Papers" },
      content: { rendered: "<h3>Outstanding Papers</h3>" },
    },
  ];

  it("selects the requested official announcement or the latest edition", () => {
    expect(selectIclrAwardPost(posts).id).toBe(1141);
    expect(selectIclrAwardPost(posts, 2025).id).toBe(1014);
  });

  it("maps official award labels to OpenReview review and PDF routes", () => {
    expect(parseIclrAwardPost(posts[0]!)).toEqual([
      expect.objectContaining({
        id: "6Mxhg9PtDE",
        title: "Safety Alignment",
        authors: ["Xiangyu Qi", "Ashwinee Panda"],
        year: 2025,
        venue: "ICLR 2025",
        award: "Outstanding Paper",
        relation: "official-award",
        openreview_id: "6Mxhg9PtDE",
        pdf_url: "https://openreview.net/pdf?id=6Mxhg9PtDE",
        source_adapter: "iclr",
        source_url: "https://blog.iclr.cc/2025/04/22/iclr-awards/",
      }),
      expect.objectContaining({
        id: "HD6bWcj87Y",
        title: "Data Shapley in One Training Run",
        authors: ["Jiachen T. Wang", "Ruoxi Jia"],
        award: "Honorable Mention",
      }),
    ]);
  });
});
