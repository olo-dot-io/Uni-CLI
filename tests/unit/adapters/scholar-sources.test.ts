/**
 * Parser and mapper tests for first-source scholarly adapters. Fixtures are
 * small slices from public provider shapes so tests exercise owned mapping
 * code without live network calls.
 */

import { describe, expect, it } from "vitest";

import { resolveCommand } from "../../../src/registry.js";
import "../../../src/adapters/openalex/works.js";
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
import { cleanAclHtml } from "../../../src/adapters/acl-anthology/papers.js";
import { buildBaiduScholarSearchUrl } from "../../../src/adapters/baidu-scholar/search.js";
import {
  buildCnkiSearchPayload,
  createCnkiVvToken,
  mapCnkiSearchRow,
} from "../../../src/adapters/cnki/search.js";
import {
  CVF_HTTP_HEADERS,
  parseCvfPaperPage,
  parseCvfRows,
} from "../../../src/adapters/cvf/papers.js";
import {
  buildGoogleScholarSearchUrl,
  googleScholarRecordId,
  parseGoogleScholarInfoLine,
  parseGoogleScholarYear,
} from "../../../src/adapters/google-scholar/search.js";
import {
  parseNeuripsPaperPage,
  parseNeuripsRows,
} from "../../../src/adapters/neurips/proceedings.js";

describe("Browser scholarly discovery adapters", () => {
  it("uses the current Baidu Scholar search route", () => {
    expect(buildBaiduScholarSearchUrl("人工智能")).toBe(
      "https://xueshu.baidu.com/ndscholar/browse/search?wd=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD",
    );
  });

  it("uses the current Google Scholar search route", () => {
    expect(buildGoogleScholarSearchUrl("Llama 2")).toBe(
      "https://scholar.google.com/scholar?q=Llama%202&hl=en",
    );
  });

  it("parses Google Scholar metadata without treating arXiv ids as years", () => {
    const infoLine =
      "S Lermen, C Rogers-Smith, J Ladish - arXiv preprint arXiv:2310.20624, 2024 - arxiv.org";

    expect(parseGoogleScholarYear(infoLine)).toBe(2024);
    expect(parseGoogleScholarInfoLine(infoLine)).toMatchObject({
      authors: "S Lermen, C Rogers-Smith, J Ladish",
      venue: "arXiv preprint arXiv:2310.20624",
      year: 2024,
    });
    expect(
      parseGoogleScholarYear(
        "S Lermen - arXiv preprint arXiv:2310.20624 - arxiv.org",
      ),
    ).toBeUndefined();
  });

  it("derives stable Google Scholar record ids from first-source URLs", () => {
    expect(
      googleScholarRecordId("Llama 2", "https://arxiv.org/abs/2307.09288v2"),
    ).toBe("2307.09288");
    expect(
      googleScholarRecordId("A DOI Paper", "https://doi.org/10.1145/1234567"),
    ).toBe("10.1145/1234567");
  });
});

describe("CNKI adapter mapping", () => {
  it("builds the current KNS title-search payload", () => {
    const payload = buildCnkiSearchPayload("人工智能", 3);

    expect(payload).toMatchObject({
      Classid: "WD0FTY92",
      SearchType: 2,
      SearchFrom: 1,
      Rlang: "",
      sort: "PT",
      pageSize: 3,
    });
    expect(payload.QNode.QGroup[0]?.ChildItems[0]?.Items[0]).toMatchObject({
      Field: "TI",
      Operator: "FUZZY",
      Value: "人工智能",
    });
  });

  it("keeps CNKI vv token generation compatible with the public app", () => {
    expect(createCnkiVvToken(1710000000000)).toBe(
      "6e438005f85e0d10067b4c0496bc3af14f2d15a08cdcde353e63e8bc5bde7d03",
    );
  });

  it("normalizes CNKI KNS rows into scholarly work records", () => {
    const row = mapCnkiSearchRow(
      {
        metadata: [
          { name: "ID", value: "cnki-id-1" },
          { name: "FN", value: "FHKH20260625004" },
          { name: "DOI", value: "10.16867/j.issn.1673-9264.2026352" },
          {
            name: "TI",
            value:
              "复杂地形山区山洪灾害预警的<font color='red'>人工智能</font>技术应用进展",
          },
          { name: "AB", value: "人工智能技术正推动山洪灾害预警。" },
          { name: "AU", value: "闫志崟;张紫琦;" },
          { name: "LY", value: "中国防汛抗旱" },
          { name: "PT", value: "2026-06-27 17:03" },
          { name: "DB", value: "期刊" },
          { name: "CF", value: "12" },
        ],
        source: { title: "中国防汛抗旱", type: "JOURNALS" },
        authors: [{ title: "闫志崟" }, { title: "张紫琦" }],
        relations: [
          {
            scope: "ABSTRACT",
            url: "https://kns.cnki.net/kcms2/article/abstract?v=demo",
          },
          {
            scope: "PDF",
            url: "https://bar.cnki.net/bar/download/order?id=demo",
          },
        ],
      },
      1,
    );

    expect(row).toMatchObject({
      id: "cnki-id-1",
      rank: 1,
      title: "复杂地形山区山洪灾害预警的人工智能技术应用进展",
      authors: ["闫志崟", "张紫琦"],
      year: 2026,
      venue: "中国防汛抗旱",
      type: "期刊",
      doi: "10.16867/j.issn.1673-9264.2026352",
      cited_by_count: 12,
      pdf_url: "https://bar.cnki.net/bar/download/order?id=demo",
      source_url: "https://kns.cnki.net/kcms2/article/abstract?v=demo",
      source_adapter: "cnki",
    });
  });
});

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

  it("marks invalid DOI input as invalid_input", () => {
    try {
      requireUnpaywallDoi("not-a-doi");
      throw new Error("expected requireUnpaywallDoi to throw");
    } catch (error) {
      expect(error).toMatchObject({
        message: expect.stringContaining("unpaywall DOI"),
        code: "invalid_input",
        retryable: false,
      });
    }
  });
});

describe("Proceedings parser mapping", () => {
  it("cleans ACL Anthology title HTML", () => {
    expect(
      cleanAclHtml(
        '<a href="https://aclanthology.org/demo.pdf"><span class="acl-fixed-case">S</span>2ORC</a>',
      ),
    ).toBe("S2ORC");
  });

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
<div class="bibref pre-white-space">@InProceedings{Demo_2024_CVPR,
    author = {Wrong, Bibtex}
}</div>
`);
    expect(rows[0]).toMatchObject({
      title: "Demo CVPR Paper",
      authors: ["Jane Doe", "John Smith"],
      pdf_url:
        "https://openaccess.thecvf.com/content/CVPR2024/papers/Demo_CVPR_2024_paper.pdf",
    });
  });

  it("parses CVF paper pages from citation metadata", () => {
    const row = parseCvfPaperPage(
      `
<meta name="citation_title" content="Guided Slot Attention">
<meta name="citation_author" content="Lee, Minhyeok">
<meta name="citation_author" content="Cho, Suhwan">
<meta name="citation_publication_date" content="2024">
<meta name="citation_conference_title" content="Proceedings of CVPR">
<meta name="citation_pdf_url" content="https://openaccess.thecvf.com/content/CVPR2024/papers/Demo.pdf">
<div id="abstract">A demo abstract.</div>
`,
      "https://openaccess.thecvf.com/content/CVPR2024/html/Demo.html",
    );
    expect(row).toMatchObject({
      id: "Demo",
      title: "Guided Slot Attention",
      authors: ["Lee, Minhyeok", "Cho, Suhwan"],
      year: 2024,
      venue: "Proceedings of CVPR",
      abstract: "A demo abstract.",
      pdf_url: "https://openaccess.thecvf.com/content/CVPR2024/papers/Demo.pdf",
    });
  });

  it("requests CVF proceedings with broad HTML accept negotiation", () => {
    expect(CVF_HTTP_HEADERS.Accept).toContain("text/html");
    expect(CVF_HTTP_HEADERS.Accept).toContain("*/*");
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
      pdf_url:
        "https://proceedings.neurips.cc/paper_files/paper/2024/file/demo-Paper-Conference.pdf",
      source_url:
        "https://proceedings.neurips.cc/paper_files/paper/2024/hash/demo-Abstract-Conference.html",
    });
  });

  it("parses NeurIPS paper pages from citation metadata", () => {
    const row = parseNeuripsPaperPage(
      `
<meta name="citation_title" content="TimeXer">
<meta name="citation_author" content="Wang, Yuxuan">
<meta name="citation_doi" content="10.52202/079017-0015">
<meta name="citation_journal_title" content="Advances in Neural Information Processing Systems">
<meta name="citation_pdf_url" content="https://proceedings.neurips.cc/paper_files/paper/2024/file/demo-Paper-Conference.pdf">
<meta name="citation_publication_date" content="2024-12-16">
<p class="paper-abstract"><p>Deep models have demonstrated remarkable performance.</p></p>
`,
      "https://proceedings.neurips.cc/paper_files/paper/2024/hash/demo-Abstract-Conference.html",
    );
    expect(row).toMatchObject({
      id: "demo-Abstract-Conference",
      title: "TimeXer",
      authors: ["Wang, Yuxuan"],
      doi: "10.52202/079017-0015",
      year: 2024,
      type: "Advances in Neural Information Processing Systems",
      pdf_url:
        "https://proceedings.neurips.cc/paper_files/paper/2024/file/demo-Paper-Conference.pdf",
      abstract: "Deep models have demonstrated remarkable performance.",
    });
  });

  it("registers source PDF read commands as full text surfaces", () => {
    for (const site of [
      "cvf",
      "neurips",
      "openalex",
      "pmlr",
      "semantic-scholar",
      "unpaywall",
    ]) {
      const command = resolveCommand(site, "read")?.command;
      expect(command?.capabilities).toEqual(
        expect.arrayContaining([
          "http.download",
          "subprocess.exec",
          "scholar.fulltext",
          "scholar.pdf",
        ]),
      );
      expect(command?.executables).toEqual(["pdftotext"]);
      expect(command?.minimum_capability).toBe("subprocess.exec");
    }
  });
});
