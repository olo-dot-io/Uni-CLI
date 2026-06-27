import { describe, expect, it } from "vitest";

import { resolveCommand } from "../../registry.js";
import {
  aclAnthologyPdfUrl,
  aclArtifactFilename,
  cleanAclHtml,
  normalizeAclAnthologyId,
  parseAclBibEntries,
  requireAclReadPageArgs,
  searchAclBibRows,
} from "./papers.js";

describe("acl-anthology scholarly commands", () => {
  it("normalizes source ids and URLs without accepting traversal", () => {
    expect(normalizeAclAnthologyId("2020.acl-main.447")).toBe(
      "2020.acl-main.447",
    );
    expect(
      normalizeAclAnthologyId("https://aclanthology.org/2020.acl-main.447.pdf"),
    ).toBe("2020.acl-main.447");
    expect(
      normalizeAclAnthologyId("https://aclanthology.org/2020.acl-main.447/"),
    ).toBe("2020.acl-main.447");
    expect(() => normalizeAclAnthologyId("../2020.acl-main.447")).toThrow(
      "ACL Anthology id",
    );
  });

  it("builds official ACL PDF URLs and stable artifact filenames", () => {
    expect(aclAnthologyPdfUrl("2020.acl-main.447")).toBe(
      "https://aclanthology.org/2020.acl-main.447.pdf",
    );
    expect(
      aclArtifactFilename({
        id: "2020.acl-main.447",
        title: "S2ORC: The Semantic Scholar Open Research Corpus",
        source_adapter: "acl-anthology",
        retrieved_at: "2026-06-27T00:00:00Z",
      }),
    ).toBe(
      "2020.acl-main.447-S2ORC__The_Semantic_Scholar_Open_Research_Corpus.pdf",
    );
  });

  it("maps scholar read hyphenated arguments to the PDF reader contract", () => {
    expect(
      requireAclReadPageArgs({
        "first-page": "2",
        "last-page": "4",
        "max-chars": "1000",
      }),
    ).toEqual({ first_page: "2", last_page: "4", max_chars: "1000" });
  });

  it("registers ACL read as source-level fulltext with pdftotext governance", () => {
    const command = resolveCommand("acl-anthology", "read")?.command;
    expect(command?.capabilities).toEqual([
      "http.fetch",
      "http.download",
      "subprocess.exec",
      "scholar.fulltext",
      "scholar.pdf",
    ]);
    expect(command?.executables).toEqual(["pdftotext"]);
    expect(command?.minimum_capability).toBe("subprocess.exec");
  });

  it("parses official ACL BibTeX export rows for source-backed search", () => {
    const rows = parseAclBibEntries(`
@inproceedings{lo-etal-2020-s2orc,
    title = "{S}2{ORC}: The Semantic Scholar Open Research Corpus",
    author = "Lo, Kyle  and
      Wang, Lucy Lu  and
      Neumann, Mark",
    booktitle = "Proceedings of the 58th Annual Meeting of the Association for Computational Linguistics",
    year = "2020",
    url = "https://aclanthology.org/2020.acl-main.447/",
    doi = "10.18653/v1/2020.acl-main.447",
    pages = "4969--4983"
}
@inproceedings{sharma-etal-2026-council,
    title = "Council of {LLM}s",
    author = "Sharma, Vivek",
    year = "2026",
    url = "https://aclanthology.org/2026.wassa-1.1/"
}
`);

    expect(rows[0]).toMatchObject({
      id: "2020.acl-main.447",
      title: "S2ORC: The Semantic Scholar Open Research Corpus",
      authors: ["Kyle Lo", "Lucy Lu Wang", "Mark Neumann"],
      year: 2020,
      doi: "10.18653/v1/2020.acl-main.447",
      pdf_url: "https://aclanthology.org/2020.acl-main.447.pdf",
      source_url: "https://aclanthology.org/2020.acl-main.447/",
    });
    expect(searchAclBibRows(rows, "Semantic Scholar Corpus", 1)).toEqual([
      rows[0],
    ]);
  });

  it("cleans ACL Anthology title HTML", () => {
    expect(
      cleanAclHtml(
        '<a href="https://aclanthology.org/demo.pdf"><span class="acl-fixed-case">S</span>2ORC</a>',
      ),
    ).toBe("S2ORC");
  });
});
