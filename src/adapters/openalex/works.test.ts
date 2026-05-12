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
    expect(
      mapOpenAlexSearchRows(
        [
          {
            id: "https://openalex.org/W1234",
            doi: "https://doi.org/10.1/example",
            title: "A paper",
            publication_year: 2026,
            cited_by_count: 5,
            authorships: [{ author: { display_name: "Ada" } }],
            primary_location: { source: { display_name: "Journal" } },
            open_access: { is_oa: true },
            type: "article",
          },
        ],
        20,
      ),
    ).toEqual([
      {
        rank: 1,
        id: "W1234",
        title: "A paper",
        year: 2026,
        citations: 5,
        firstAuthor: "Ada",
        venue: "Journal",
        openAccess: true,
        type: "article",
        doi: "10.1/example",
        url: "https://openalex.org/W1234",
      },
    ]);
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
        primary_location: { source: { display_name: "Journal" } },
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
      abstract: "hello world",
    });
    expect(() => mapOpenAlexWorkRow({})).toThrow(
      "OpenAlex returned no work record",
    );
  });
});
