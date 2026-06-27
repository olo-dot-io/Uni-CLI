import { describe, expect, it } from "vitest";
import {
  mapOpenAlexSearchRows,
  mapOpenAlexWorkRow,
  reconstructOpenAlexAbstract,
  requireOpenAlexLimit,
  requireOpenAlexString,
  requireOpenAlexWorkRef,
} from "./works.js";

describe("openalex agent-facing commands", () => {
  it("validates search and work refs", () => {
    expect(requireOpenAlexString(" transformers ", "query")).toBe(
      "transformers",
    );
    expect(() => requireOpenAlexString("", "query")).toThrow("cannot be empty");
    expect(requireOpenAlexLimit(undefined)).toBe(20);
    expect(requireOpenAlexLimit("200")).toBe(200);
    expect(() => requireOpenAlexLimit("0")).toThrow("openalex limit must");
    expect(requireOpenAlexWorkRef("w2741809807")).toBe("W2741809807");
    expect(requireOpenAlexWorkRef("https://doi.org/10.7717/peerj.4375")).toBe(
      "doi:10.7717/peerj.4375",
    );
    expect(() => requireOpenAlexWorkRef("A12345")).toThrow("not recognised");
  });

  it("reconstructs OpenAlex abstracts from inverted indexes", () => {
    expect(reconstructOpenAlexAbstract({ world: [1], hello: [0] })).toBe(
      "hello world",
    );
  });

  it("maps search rows", () => {
    const rows = mapOpenAlexSearchRows(
      [
        {
          id: "https://openalex.org/W1234",
          doi: "https://doi.org/10.1/example",
          title: "A paper",
          publication_year: 2026,
          cited_by_count: 5,
          authorships: [{ author: { display_name: "Ada" } }],
          primary_location: {
            landing_page_url: "https://publisher.test/paper",
            pdf_url: "https://publisher.test/paper.pdf",
            source: { display_name: "Journal" },
          },
          open_access: { is_oa: true, oa_url: "https://publisher.test/paper" },
          type: "article",
        },
      ],
      20,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rank: 1,
      id: "W1234",
      title: "A paper",
      year: 2026,
      citations: 5,
      firstAuthor: "Ada",
      authors: ["Ada"],
      venue: "Journal",
      openAccess: true,
      is_open_access: true,
      type: "article",
      doi: "10.1/example",
      pdf_url: "https://publisher.test/paper.pdf",
      landing_url: "https://publisher.test/paper",
      openalex_id: "W1234",
      source_adapter: "openalex",
      source_url: "https://openalex.org/W1234",
      url: "https://openalex.org/W1234",
    });
    expect(rows[0]?.retrieved_at).toEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it("maps work detail rows", () => {
    expect(
      mapOpenAlexWorkRow({
        id: "https://openalex.org/W1234",
        title: "A paper",
        type: "article",
        publication_year: 2026,
        publication_date: "2026-05-01",
        language: "en",
        authorships: [
          { author: { display_name: "Ada" } },
          { author: { display_name: "Grace" } },
        ],
        primary_location: {
          landing_page_url: "https://publisher.test/paper",
          source: { display_name: "Journal" },
        },
        best_oa_location: { pdf_url: "https://repository.test/paper.pdf" },
        cited_by_count: 5,
        open_access: { is_oa: true, oa_url: "https://example.test/pdf" },
        referenced_works: ["W1", "W2"],
        doi: "https://doi.org/10.1/example",
        abstract_inverted_index: { hello: [0], world: [1] },
      }),
    ).toMatchObject({
      id: "W1234",
      authors: "Ada, Grace",
      referencedCount: 2,
      doi: "10.1/example",
      pdf_url: "https://repository.test/paper.pdf",
      landing_url: "https://publisher.test/paper",
      abstract: "hello world",
    });
    expect(() => mapOpenAlexWorkRow({})).toThrow(
      "OpenAlex returned no work record",
    );
  });
});
