import { describe, expect, it } from "vitest";
import {
  decodeXmlEntities,
  mapPublicationHit,
  mapRecordXml,
  mapVenueHit,
  normalizeDblpAuthors,
  requireDblpLimit,
  requireDblpQuery,
  requirePid,
  requireRecordKey,
  splitAuthorRecords,
} from "./publications.js";

describe("dblp agent-facing publication commands", () => {
  it("validates query, limit, record key, and PID inputs", () => {
    expect(requireDblpQuery(" attention ")).toBe("attention");
    expect(() => requireDblpQuery("")).toThrow("cannot be empty");
    expect(requireDblpLimit(undefined, 20, 100)).toBe(20);
    expect(requireDblpLimit("100", 20, 100)).toBe(100);
    expect(() => requireDblpLimit("101", 20, 100)).toThrow(
      "limit must be an integer",
    );
    expect(requireRecordKey("conf/nips/VaswaniSPUJGKP17")).toBe(
      "conf/nips/VaswaniSPUJGKP17",
    );
    expect(() => requireRecordKey("https://dblp.org")).toThrow("not valid");
    expect(requirePid("56/953")).toBe("56/953");
    expect(() => requirePid("../56/953")).toThrow("not valid");
  });

  it("normalizes XML entities, authors, and publication search hits", () => {
    expect(decodeXmlEntities("A &amp; B &#x1F600;")).toBe("A & B 😀");
    expect(
      normalizeDblpAuthors({
        author: [{ text: "Jane Doe 0001" }, { "#text": "Max &amp; Co" }],
      }),
    ).toEqual(["Jane Doe", "Max & Co"]);
    expect(
      mapPublicationHit(
        {
          info: {
            key: "conf/nips/Paper24",
            title: "A Paper.",
            authors: { author: { text: "Jane Doe 0001" } },
            venue: "NeurIPS",
            year: "2024",
            type: "Conference and Workshop Papers",
            doi: "10.0000/test",
            ee: "https://doi.org/10.0000/test",
          },
        },
        1,
      ),
    ).toEqual({
      rank: 1,
      key: "conf/nips/Paper24",
      title: "A Paper",
      authors: "Jane Doe",
      venue: "NeurIPS",
      year: "2024",
      type: "conf",
      doi: "10.0000/test",
      url: "https://doi.org/10.0000/test",
    });
  });

  it("maps record XML and author publication records", () => {
    const xml = `
      <dblp>
        <inproceedings key="conf/nips/Paper24">
          <author>Jane Doe 0001</author>
          <author>Max &amp; Co</author>
          <title>A Paper.</title>
          <booktitle>NeurIPS</booktitle>
          <year>2024</year>
          <pages>1-10</pages>
          <ee type="oa">https://openaccess.example/paper</ee>
          <ee>https://doi.org/10.0000/test</ee>
        </inproceedings>
      </dblp>
    `;
    expect(mapRecordXml(xml)).toEqual({
      key: "conf/nips/Paper24",
      type: "conf",
      title: "A Paper",
      authors: "Jane Doe, Max & Co",
      venue: "NeurIPS",
      year: "2024",
      pages: "1-10",
      doi: "10.0000/test",
      open_access_url: "https://openaccess.example/paper",
      dblp_url: "https://dblp.org/rec/conf/nips/Paper24.html",
    });
    expect(
      splitAuthorRecords(
        `<dblpperson><r>${xml}</r><r><crossref /></r></dblpperson>`,
      ),
    ).toHaveLength(1);
  });

  it("maps venue hits with relative URLs", () => {
    expect(
      mapVenueHit(
        {
          info: {
            acronym: "ICLR",
            venue: "International Conference on Learning Representations",
            type: "Conference or Workshop",
            url: "/db/conf/iclr/",
          },
        },
        2,
      ),
    ).toEqual({
      rank: 2,
      acronym: "ICLR",
      venue: "International Conference on Learning Representations",
      type: "conf",
      url: "https://dblp.org/db/conf/iclr/",
    });
  });
});
