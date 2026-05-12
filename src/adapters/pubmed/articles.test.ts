import { describe, expect, it } from "vitest";
import {
  mapPubMedArticleRows,
  mapPubMedSummaryRows,
  requirePmid,
  requirePubMedLimit,
  requirePubMedText,
} from "./articles.js";

describe("pubmed agent-facing commands", () => {
  it("validates PubMed inputs", () => {
    expect(requirePubMedText(" cancer ", "query")).toBe("cancer");
    expect(() => requirePubMedText("", "query")).toThrow("cannot be empty");
    expect(requirePmid("37780221")).toBe("37780221");
    expect(() => requirePmid("PMID:1")).toThrow("numeric PMID");
    expect(requirePubMedLimit(undefined)).toBe(20);
    expect(requirePubMedLimit("100")).toBe(100);
    expect(() => requirePubMedLimit("0")).toThrow("pubmed limit must");
  });

  it("maps PubMed summary rows in PMID order", () => {
    expect(
      mapPubMedSummaryRows(
        [
          {
            uid: "2",
            title: "Second",
            authors: [
              { name: "Ada" },
              { name: "Grace" },
              { name: "Linus" },
              { name: "Ken" },
            ],
            source: "Journal",
            pubdate: "2026 May",
            pubtype: ["Journal Article"],
            articleids: [{ idtype: "doi", value: "10.1/example" }],
          },
          {
            uid: "1",
            title: "First",
            authors: [{ lastname: "Hopper", initials: "G" }],
            source: "Other",
            pubdate: "2025",
            pubtype: ["Review"],
            articleids: [],
          },
        ],
        ["1", "2"],
      ),
    ).toMatchObject([
      {
        rank: 1,
        pmid: "1",
        title: "First",
        authors: "Hopper G",
        year: "2025",
        article_type: "Review",
      },
      {
        rank: 2,
        pmid: "2",
        authors: "Ada, Grace, Linus, et al.",
        doi: "10.1/example",
      },
    ]);
  });

  it("maps PubMed article XML rows", () => {
    const rows = mapPubMedArticleRows(
      `
      <PubmedArticle>
        <ArticleTitle>Test &amp; Treat</ArticleTitle>
        <Abstract><AbstractText>Long abstract</AbstractText></Abstract>
        <Author><LastName>Ada</LastName></Author>
        <Journal><Title>Journal</Title></Journal>
        <PubDate><Year>2026</Year></PubDate>
        <PublicationType>Journal Article</PublicationType>
        <Language>eng</Language>
        <ArticleId IdType="doi">10.1/example</ArticleId>
      </PubmedArticle>
      `,
      "123",
    );
    expect(rows).toContainEqual({ field: "PMID", value: "123" });
    expect(rows).toContainEqual({ field: "Title", value: "Test & Treat" });
    expect(rows).toContainEqual({ field: "DOI", value: "10.1/example" });
    expect(rows).toContainEqual({
      field: "URL",
      value: "https://pubmed.ncbi.nlm.nih.gov/123/",
    });
    expect(() => mapPubMedArticleRows("<root />", "123")).toThrow(
      "did not include a title",
    );
  });
});
