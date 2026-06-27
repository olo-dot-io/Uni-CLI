import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchSearchRows,
  mapRxivJatsFullTextRow,
  mapRxivPreprint,
  requireRxivCursor,
  requireRxivDate,
  requireRxivDoi,
  requireRxivLimit,
  requireRxivMaxChars,
  requireRxivQuery,
  requireRxivSearchPages,
  rxivArtifactFilename,
  rxivSearchMatchedFields,
  type RxivConfig,
} from "./preprints.js";

const BIORXIV: RxivConfig = {
  site: "biorxiv",
  label: "bioRxiv",
  apiServer: "biorxiv",
  webOrigin: "https://www.biorxiv.org",
};

describe("xRxiv preprint adapters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates DOI, query, date, cursor, limit, search pages, and max text bounds", () => {
    expect(requireRxivDoi("doi:10.64898/2026.06.18.733205")).toBe(
      "10.64898/2026.06.18.733205",
    );
    expect(requireRxivDoi("https://doi.org/10.1101/2020.01.01.1")).toBe(
      "10.1101/2020.01.01.1",
    );
    expect(() => requireRxivDoi("not-a-doi", "biorxiv")).toThrow("biorxiv DOI");
    expect(requireRxivDate("2026-06-26", "from")).toBe("2026-06-26");
    expect(() => requireRxivDate("2026/06/26", "from")).toThrow("YYYY-MM-DD");
    expect(requireRxivCursor(undefined)).toBe(0);
    expect(() => requireRxivCursor("-1")).toThrow("non-negative");
    expect(requireRxivLimit(undefined)).toBe(30);
    expect(() => requireRxivLimit("31")).toThrow("rxiv limit");
    expect(requireRxivQuery("  artificial   intelligence ")).toBe(
      "artificial intelligence",
    );
    expect(() => requireRxivQuery(" ")).toThrow("query cannot be empty");
    expect(requireRxivSearchPages(undefined)).toBe(10);
    expect(() => requireRxivSearchPages("21")).toThrow("rxiv max-pages");
    expect(requireRxivMaxChars(undefined)).toBe(40000);
    expect(() => requireRxivMaxChars("999")).toThrow("rxiv max-chars");
  });

  it("maps official API records into scholarly rows", () => {
    const row = mapRxivPreprint(
      {
        title: " A   Preprint ",
        authors: "Ada Lovelace; Grace Hopper",
        author_corresponding: "Ada Lovelace",
        author_corresponding_institution: "Example University",
        doi: "10.64898/2026.06.18.733205",
        date: "2026-06-20",
        version: "2",
        type: "new results",
        license: "cc_by",
        category: "systems biology",
        jatsxml:
          "https://www.biorxiv.org/content/early/2026/06/20/example.source.xml",
        abstract: " An   abstract ",
        published: "NA",
        server: "bioRxiv",
      },
      BIORXIV,
      3,
    );

    expect(row).toMatchObject({
      rank: 3,
      id: "10.64898/2026.06.18.733205",
      title: "A Preprint",
      authors: ["Ada Lovelace", "Grace Hopper"],
      year: 2026,
      version: "2",
      venue: "bioRxiv",
      doi: "10.64898/2026.06.18.733205",
      pdf_url:
        "https://www.biorxiv.org/content/10.64898/2026.06.18.733205v2.full.pdf",
      source_adapter: "biorxiv",
      source_url:
        "https://www.biorxiv.org/content/10.64898/2026.06.18.733205v2",
    });
    expect(row.retrieved_at).toEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it("extracts JATS XML text before PDF fallback is needed", () => {
    const row = mapRxivJatsFullTextRow(
      `
      <article>
        <front>
          <article-meta>
            <title-group><article-title>JATS Demo</article-title></title-group>
            <abstract><p>Abstract text.</p></abstract>
          </article-meta>
        </front>
        <body>
          <sec>
            <title>Methods</title>
            <p>First paragraph.</p>
            <sec><title>Nested</title><p>Nested paragraph.</p></sec>
          </sec>
        </body>
      </article>
      `,
      {
        id: "10.64898/2026.06.18.733205",
        title: "Fallback title",
        doi: "10.64898/2026.06.18.733205",
        version: "1",
        pdf_url:
          "https://www.biorxiv.org/content/10.64898/2026.06.18.733205v1.full.pdf",
        source_url:
          "https://www.biorxiv.org/content/10.64898/2026.06.18.733205v1",
      },
      BIORXIV,
      1000,
    );

    expect(row).toMatchObject({
      id: "10.64898/2026.06.18.733205",
      title: "JATS Demo",
      text_source: "jats_xml",
      source_adapter: "biorxiv",
    });
    expect(String(row.text)).toContain("## Abstract");
    expect(String(row.text)).toContain("## Methods");
    expect(String(row.text)).toContain("Nested paragraph.");
  });

  it("matches search queries against official metadata fields", () => {
    const fields = rxivSearchMatchedFields(
      {
        title: "Clinical artificial intelligence in imaging",
        authors: "Ada Lovelace; Grace Hopper",
        doi: "10.64898/2026.06.23.26356399",
        category: "radiology and imaging",
        abstract: "<p>Deep learning triage model.</p>",
      },
      "artificial intelligence",
    );

    expect(fields).toEqual(["title"]);
    expect(
      rxivSearchMatchedFields(
        {
          title: "Triage system",
          authors: "Ada Lovelace; Grace Hopper",
          doi: "10.64898/2026.06.23.26356399",
          category: "radiology and imaging",
          abstract: "<p>Deep learning triage model.</p>",
        },
        "deep triage",
      ),
    ).toEqual(["abstract"]);
  });

  it("searches bounded official API windows and annotates scope", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        messages: [{ status: "ok", cursor: 0, count: 2, total: 2 }],
        collection: [
          {
            title: "Unrelated preprint",
            authors: "Example Author",
            doi: "10.64898/2026.06.01.111111",
            date: "2026-06-01",
            version: "1",
            category: "epidemiology",
            abstract: "No matching text.",
            server: "bioRxiv",
          },
          {
            title: "Clinical artificial intelligence in imaging",
            authors: "Ada Lovelace; Grace Hopper",
            doi: "10.64898/2026.06.02.222222",
            date: "2026-06-02",
            version: "1",
            category: "radiology and imaging",
            abstract: "A source-first preprint.",
            server: "bioRxiv",
          },
        ],
      }),
    } as Response);

    const rows = await fetchSearchRows(BIORXIV, {
      query: "artificial intelligence",
      from: "2026-06-01",
      to: "2026-06-07",
      limit: 1,
      "max-pages": 1,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.biorxiv.org/details/biorxiv/2026-06-01/2026-06-07/0/json",
      expect.any(Object),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rank: 1,
      id: "10.64898/2026.06.02.222222",
      matched_fields: ["title"],
      search_scope: "official_api_date_window",
      search_window: "2026-06-01:2026-06-07",
      search_scanned_records: 2,
      search_total_records: 2,
      search_exhaustive: true,
    });
  });

  it("generates safe PDF artifact filenames", () => {
    expect(
      rxivArtifactFilename({
        doi: "10.64898/2026.06.18.733205",
        version: "1",
        title: "A / Demo: Preprint",
      }),
    ).toBe("10.64898_2026.06.18.733205v1-A-Demo-Preprint.pdf");
  });
});
