/**
 * Parser and mapper tests for first-source scholarly adapters. Fixtures are
 * small slices from public provider shapes so tests exercise owned mapping
 * code without live network calls.
 */

import { describe, expect, it } from "vitest";

import {
  mapCrossrefItem,
  requireCrossrefDoi,
} from "../../../src/adapters/crossref/works.js";
import {
  mapSemanticScholarPaper,
  requireSemanticScholarPaperRef,
} from "../../../src/adapters/semantic-scholar/papers.js";
import {
  mapUnpaywallWork,
  requireUnpaywallDoi,
} from "../../../src/adapters/unpaywall/works.js";
import {
  mapPmlrEntry,
  parsePmlrCiteproc,
} from "../../../src/adapters/pmlr/proceedings.js";
import { parseCvfRows } from "../../../src/adapters/cvf/papers.js";
import { parseNeuripsRows } from "../../../src/adapters/neurips/proceedings.js";

describe("Semantic Scholar adapter mapping", () => {
  it("normalizes DOI, arXiv, authors, citations, references, and OA PDF", () => {
    const row = mapSemanticScholarPaper(
      {
        paperId: "649def34f8be52c8b66281af98ae884c09aef38b",
        title: "Attention Is All You Need",
        year: 2017,
        citationCount: 99999,
        referenceCount: 42,
        venue: "NeurIPS",
        url: "https://www.semanticscholar.org/paper/demo",
        authors: [{ name: "Ashish Vaswani" }, { name: "Noam Shazeer" }],
        externalIds: { DOI: "10.48550/arXiv.1706.03762", ArXiv: "1706.03762" },
        openAccessPdf: { url: "https://arxiv.org/pdf/1706.03762" },
      },
      "semantic-scholar",
    );

    expect(row).toMatchObject({
      id: "649def34f8be52c8b66281af98ae884c09aef38b",
      title: "Attention Is All You Need",
      year: 2017,
      venue: "NeurIPS",
      doi: "10.48550/arXiv.1706.03762",
      arxiv_id: "1706.03762",
      pdf_url: "https://arxiv.org/pdf/1706.03762",
      source_adapter: "semantic-scholar",
    });
    expect(row.authors).toEqual(["Ashish Vaswani", "Noam Shazeer"]);
    expect(row.cited_by_count).toBe(99999);
    expect(row.references_count).toBe(42);
  });

  it("accepts DOI, S2 paper ids, and arXiv ids as paper references", () => {
    expect(requireSemanticScholarPaperRef("doi:10.1145/123")).toBe(
      "DOI:10.1145/123",
    );
    expect(requireSemanticScholarPaperRef("arXiv:1706.03762v7")).toBe(
      "ARXIV:1706.03762",
    );
    expect(
      requireSemanticScholarPaperRef(
        "649def34f8be52c8b66281af98ae884c09aef38b",
      ),
    ).toBe("649def34f8be52c8b66281af98ae884c09aef38b");
  });
});

describe("Crossref adapter mapping", () => {
  it("normalizes work metadata and DOI URLs", () => {
    const row = mapCrossrefItem(
      {
        DOI: "10.5555/12345678",
        title: ["A Crossref Work"],
        author: [{ given: "Ada", family: "Lovelace" }],
        "container-title": ["Journal of Examples"],
        issued: { "date-parts": [[2024, 5, 1]] },
        "is-referenced-by-count": 12,
        reference: [{ DOI: "10.1/ref" }],
        URL: "https://doi.org/10.5555/12345678",
        type: "journal-article",
      },
      "crossref",
    );

    expect(row).toMatchObject({
      id: "10.5555/12345678",
      doi: "10.5555/12345678",
      title: "A Crossref Work",
      venue: "Journal of Examples",
      year: 2024,
      cited_by_count: 12,
      references_count: 1,
      type: "journal-article",
      source_adapter: "crossref",
    });
    expect(row.authors).toEqual(["Ada Lovelace"]);
  });

  it("rejects non-DOI references for DOI-only lookup", () => {
    expect(requireCrossrefDoi("https://doi.org/10.5555/123")).toBe(
      "10.5555/123",
    );
    expect(() => requireCrossrefDoi("not-a-doi")).toThrow("crossref DOI");
  });
});

describe("Unpaywall adapter mapping", () => {
  it("selects the best OA PDF location", () => {
    const row = mapUnpaywallWork(
      {
        doi: "10.1038/nature12373",
        title: "Nanometre-scale thermometry in a living cell",
        is_oa: true,
        oa_status: "bronze",
        best_oa_location: {
          url_for_pdf: "https://www.nature.com/articles/nature12373.pdf",
          url_for_landing_page: "https://doi.org/10.1038/nature12373",
          host_type: "publisher",
          version: "publishedVersion",
          license: null,
        },
      },
      "unpaywall",
    );

    expect(row).toMatchObject({
      id: "10.1038/nature12373",
      doi: "10.1038/nature12373",
      is_open_access: true,
      oa_status: "bronze",
      pdf_url: "https://www.nature.com/articles/nature12373.pdf",
      source_url: "https://doi.org/10.1038/nature12373",
      source_adapter: "unpaywall",
    });
  });

  it("normalizes DOI URLs", () => {
    expect(requireUnpaywallDoi("https://doi.org/10.1038/nature12373")).toBe(
      "10.1038/nature12373",
    );
  });
});

describe("Proceedings parser mapping", () => {
  it("parses PMLR citeproc entries", () => {
    const rows = parsePmlrCiteproc(`
- title: 'Example PMLR Paper'
  URL: https://proceedings.mlr.press/v235/example.html
  PDF: https://raw.githubusercontent.com/mlresearch/v235/main/assets/example/example.pdf
  container-title: 'Proceedings of the 41st International Conference on Machine Learning'
  author:
  - given: Ada
    family: Lovelace
  id: example24a
  issued:
    date-parts:
      - 2024
      - 7
      - 8
`);
    expect(mapPmlrEntry(rows[0], "pmlr")).toMatchObject({
      id: "example24a",
      title: "Example PMLR Paper",
      venue:
        "Proceedings of the 41st International Conference on Machine Learning",
      year: 2024,
      pdf_url:
        "https://raw.githubusercontent.com/mlresearch/v235/main/assets/example/example.pdf",
    });
  });

  it("parses CVF paper listings with PDFs", () => {
    const rows = parseCvfRows(`
<dt class="ptitle"><br><a href="/content/CVPR2024/html/Demo_CVPR_2024_paper.html">Demo CVPR Paper</a></dt>
<dd>Jane Doe, John Smith</dd>
[<a href="/content/CVPR2024/papers/Demo_CVPR_2024_paper.pdf">pdf</a>]
`);
    expect(rows[0]).toMatchObject({
      title: "Demo CVPR Paper",
      authors: ["Jane Doe", "John Smith"],
      pdf_url:
        "https://openaccess.thecvf.com/content/CVPR2024/papers/Demo_CVPR_2024_paper.pdf",
    });
  });

  it("parses NeurIPS proceedings listings", () => {
    const rows = parseNeuripsRows(`
<div class="paper-content">
  <a title="paper title" href="/paper_files/paper/2024/hash/demo-Abstract-Conference.html">Demo NeurIPS Paper</a>
  <span class="paper-authors">Jane Doe, John Smith</span>
</div>
`);
    expect(rows[0]).toMatchObject({
      title: "Demo NeurIPS Paper",
      authors: ["Jane Doe", "John Smith"],
      source_url:
        "https://proceedings.neurips.cc/paper_files/paper/2024/hash/demo-Abstract-Conference.html",
    });
  });
});
