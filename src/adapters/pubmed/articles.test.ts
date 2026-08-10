import { describe, expect, it } from "vitest";
import {
  mapPmcFullTextRow,
  mapPubMedArticleRecord,
  mapPubMedArticleRows,
  mapPubMedSummaryRows,
  normalizePmcId,
  requirePmid,
  requirePubMedLimit,
  requirePubMedMaxChars,
  requirePubMedResults,
  requirePubMedText,
} from "./articles.js";

describe("pubmed agent-facing commands", () => {
  it("validates PubMed inputs", () => {
    expect(requirePubMedText(" cancer ", "query")).toBe("cancer");
    expect(() => requirePubMedText("", "query")).toThrow("cannot be empty");
    expect(requirePmid("37780221")).toBe("37780221");
    expect(() => requirePmid("PMID:1")).toThrow("numeric PMID");
    expect(normalizePmcId("8938715")).toBe("PMC8938715");
    expect(normalizePmcId("PMC8938715")).toBe("PMC8938715");
    expect(() => normalizePmcId("pmc:8938715")).toThrow("not valid");
    expect(requirePubMedLimit(undefined)).toBe(20);
    expect(requirePubMedLimit("100")).toBe(100);
    expect(() => requirePubMedLimit("0")).toThrow("pubmed limit must");
    expect(requirePubMedMaxChars(undefined)).toBe(40000);
    expect(requirePubMedMaxChars("1000")).toBe(1000);
    expect(() => requirePubMedMaxChars("999")).toThrow("max-chars");
    try {
      requirePmid("PMID:1");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }
    expect(() => requirePubMedResults([], "No PubMed results.")).toThrow(
      "No PubMed results",
    );
    try {
      requirePubMedResults([], "No PubMed results.");
    } catch (error) {
      expect(error).toMatchObject({ code: "empty_result" });
    }
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
            articleids: [
              { idtype: "doi", value: "10.1/example" },
              { idtype: "pmc", value: "PMC123456" },
            ],
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
        id: "1",
        pmid: "1",
        title: "First",
        authors: "Hopper G",
        year: "2025",
        article_type: "Review",
      },
      {
        rank: 2,
        id: "2",
        pmid: "2",
        authors: "Ada, Grace, Linus, et al.",
        doi: "10.1/example",
        pmc_id: "PMC123456",
        source_adapter: "pubmed",
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
        <ArticleId IdType="pmc">PMC123456</ArticleId>
        <ArticleId IdType="doi">10.1/example</ArticleId>
      </PubmedArticle>
      `,
      "123",
    );
    expect(rows).toContainEqual({ field: "PMID", value: "123" });
    expect(rows).toContainEqual({ field: "PMCID", value: "PMC123456" });
    expect(rows).toContainEqual({ field: "Title", value: "Test & Treat" });
    expect(rows).toContainEqual({ field: "DOI", value: "10.1/example" });
    expect(rows).toContainEqual({
      field: "URL",
      value: "https://pubmed.ncbi.nlm.nih.gov/123/",
    });
    expect(() => mapPubMedArticleRows("<root />", "123")).toThrow(
      "did not include a title",
    );
    try {
      mapPubMedArticleRows("<root />", "123");
    } catch (error) {
      expect(error).toMatchObject({ code: "empty_result" });
    }
  });

  it("maps normalized PubMed article metadata rows", () => {
    const row = mapPubMedArticleRecord(
      `
      <PubmedArticle>
        <ArticleTitle>Normalized Article</ArticleTitle>
        <Abstract><AbstractText>Abstract text</AbstractText></Abstract>
        <Author><LastName>Ada</LastName><Initials>L</Initials></Author>
        <Journal><Title>Journal</Title></Journal>
        <PubDate><Year>2026</Year></PubDate>
        <PublicationType>Journal Article</PublicationType>
        <Language>eng</Language>
        <ArticleId IdType="pmc">PMC123456</ArticleId>
        <ArticleId IdType="doi">10.1/example</ArticleId>
      </PubmedArticle>
      `,
      "123",
    );

    expect(row).toMatchObject({
      id: "123",
      pmid: "123",
      title: "Normalized Article",
      authors: ["Ada L"],
      doi: "10.1/example",
      pmc_id: "PMC123456",
      source_adapter: "pubmed",
      source_url: "https://pubmed.ncbi.nlm.nih.gov/123/",
    });
  });

  it("maps PMC JATS XML into source-direct full text", () => {
    const row = mapPmcFullTextRow(
      `
      <article>
        <front>
          <article-meta>
            <article-id pub-id-type="pmcid">PMC123456</article-id>
            <article-id pub-id-type="pmid">123</article-id>
            <article-id pub-id-type="doi">10.1/example</article-id>
            <title-group><article-title>Full Text Article</article-title></title-group>
          </article-meta>
        </front>
        <abstract><p>Abstract paragraph.</p></abstract>
        <body>
          <sec><title>Introduction</title><p>First body paragraph.</p></sec>
          <sec><title>Methods</title><p>Second body paragraph.</p></sec>
        </body>
      </article>
      `,
      "PMC123456",
      1000,
    );

    expect(row).toMatchObject({
      id: "123",
      title: "Full Text Article",
      pmid: "123",
      pmc_id: "PMC123456",
      doi: "10.1/example",
      source_adapter: "pubmed",
      source_url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC123456/",
      text_truncated: false,
    });
    expect(row.text).toContain("## Abstract");
    expect(row.text).toContain("## Introduction");
    expect(row.text).toContain("First body paragraph.");
  });
});
