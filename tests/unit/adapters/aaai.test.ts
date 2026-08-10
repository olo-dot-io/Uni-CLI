import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchAaaiHtml,
  parseAaaiArchivePage,
  parseAaaiIssuePage,
  parseAaaiPaperPage,
} from "../../../src/adapters/aaai/proceedings.js";

describe("AAAI official OJS proceedings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes only numbered AAAI main Technical Tracks issues", () => {
    const issues = parseAaaiArchivePage(`
      <div class="obj_issue_summary">
        <a class="title" href="/index.php/AAAI/issue/view/683">AAAI-26 Technical Tracks 1</a>
        <div class="series">Vol. 40 No. 1 (2026)</div>
        <div class="description"><p>AAAI Technical Track on Application Domains I</p></div>
      </div>
      <div class="obj_issue_summary">
        <a class="title" href="/index.php/AAAI/issue/view/726">AAAI-26 Student Abstracts</a>
      </div>
      <div class="obj_issue_summary">
        <a class="title" href="/index.php/AAAI/issue/view/727">AAAI-26 Doctoral Consortium</a>
      </div>
      <div class="obj_issue_summary">
        <a class="title" href="/index.php/AAAI/issue/view/728">AAAI-26 Special Track on AI Alignment</a>
      </div>
      <div class="obj_issue_summary">
        <a class="title" href="/index.php/AAAI/issue/view/729">AAAI-26 / IAAI-26 Technical Tracks</a>
      </div>
    `);

    expect(issues).toHaveLength(5);
    expect(issues.filter((issue) => issue.is_technical_track)).toEqual([
      expect.objectContaining({
        id: "683",
        title: "AAAI-26 Technical Tracks 1",
        year: 2026,
        track_number: 1,
        volume: 40,
        issue: 1,
        track: "AAAI Technical Track on Application Domains I",
        source_url: "https://ojs.aaai.org/index.php/AAAI/issue/view/683",
      }),
    ]);
    expect(issues.slice(1).every((issue) => !issue.is_technical_track)).toBe(
      true,
    );
  });

  it("parses main-track issue rows and preserves the official galley URL", () => {
    const [row] = parseAaaiIssuePage(
      `
        <div class="sections">
          <div class="section">
            <h2>AAAI Technical Track on Application Domains I</h2>
            <div class="obj_article_summary">
              <h3 class="title">
                <a href="/index.php/AAAI/article/view/36958">
                  Resource Efficient Sleep Staging via Multi-Level Masking and Prompt Learning
                </a>
              </h3>
              <div class="authors">Lejun Ai, Yulong Li, Rui Wang</div>
              <div class="pages">3-11</div>
              <a class="obj_galley_link pdf" href="/index.php/AAAI/article/view/36958/40920">PDF</a>
            </div>
          </div>
          <div class="section">
            <h2>AAAI Student Abstracts</h2>
            <div class="obj_article_summary">
              <h3 class="title"><a href="/index.php/AAAI/article/view/99999">Excluded</a></h3>
            </div>
          </div>
        </div>
      `,
      {
        id: "683",
        title: "AAAI-26 Technical Tracks 1",
        year: 2026,
        track_number: 1,
        volume: 40,
        issue: 1,
        source_url: "https://ojs.aaai.org/index.php/AAAI/issue/view/683",
        is_technical_track: true,
      },
    );

    expect(row).toMatchObject({
      id: "36958",
      title:
        "Resource Efficient Sleep Staging via Multi-Level Masking and Prompt Learning",
      authors: ["Lejun Ai", "Yulong Li", "Rui Wang"],
      year: 2026,
      pages: "3-11",
      track: "AAAI Technical Track on Application Domains I",
      volume: "40",
      issue: "1",
      pdf_url: "https://ojs.aaai.org/index.php/AAAI/article/view/36958/40920",
      source_url: "https://ojs.aaai.org/index.php/AAAI/article/view/36958",
      source_adapter: "aaai",
    });
  });

  it("does not parse articles from a non-main issue", () => {
    expect(
      parseAaaiIssuePage(
        `<div class="sections"><div class="section"><h2>AAAI Technical Track on Application Domains I</h2></div></div>`,
        {
          id: "726",
          title: "AAAI-26 Student Abstracts",
          year: 2026,
          source_url: "https://ojs.aaai.org/index.php/AAAI/issue/view/726",
          is_technical_track: false,
        },
      ),
    ).toEqual([]);
  });

  it("maps official article metadata including DOI and canonical PDF", () => {
    const row = parseAaaiPaperPage(
      `
        <meta name="DC.Identifier" content="36958" />
        <meta name="DC.Type.articleType" content="AAAI Technical Track on Application Domains I" />
        <meta name="DC.Description" content="A resource-efficient sleep staging method." />
        <meta name="citation_title" content="Resource Efficient Sleep Staging via Multi-Level Masking and Prompt Learning" />
        <meta name="citation_author" content="Lejun Ai" />
        <meta name="citation_author" content="Yulong Li" />
        <meta name="citation_date" content="2026/03/17" />
        <meta name="citation_journal_title" content="Proceedings of the AAAI Conference on Artificial Intelligence" />
        <meta name="citation_volume" content="40" />
        <meta name="citation_issue" content="1" />
        <meta name="citation_firstpage" content="3" />
        <meta name="citation_lastpage" content="11" />
        <meta name="citation_doi" content="10.1609/aaai.v40i1.36958" />
        <meta name="citation_pdf_url" content="https://ojs.aaai.org/index.php/AAAI/article/download/36958/40920" />
      `,
      "https://ojs.aaai.org/index.php/AAAI/article/view/36958",
    );

    expect(row).toMatchObject({
      id: "36958",
      authors: ["Lejun Ai", "Yulong Li"],
      year: 2026,
      date: "2026-03-17",
      doi: "10.1609/aaai.v40i1.36958",
      pdf_url:
        "https://ojs.aaai.org/index.php/AAAI/article/download/36958/40920",
      pages: "3-11",
      volume: "40",
      issue: "1",
      source_adapter: "aaai",
    });
  });

  it("leaves PDF absent when official article HTML exposes no PDF evidence", () => {
    const row = parseAaaiPaperPage(
      `
        <meta name="DC.Identifier" content="36958" />
        <meta name="DC.Type.articleType" content="AAAI Technical Track on Application Domains I" />
        <meta name="citation_title" content="Paper without a galley" />
      `,
      "https://ojs.aaai.org/index.php/AAAI/article/view/36958",
    );

    expect(row.pdf_url).toBeUndefined();
  });

  it("rejects Student Abstract and Doctoral Consortium article types", () => {
    for (const articleType of [
      "AAAI Student Abstracts",
      "AAAI Doctoral Consortium",
    ]) {
      expect(() =>
        parseAaaiPaperPage(
          `
            <meta name="DC.Identifier" content="12345" />
            <meta name="DC.Type.articleType" content="${articleType}" />
            <meta name="citation_title" content="Excluded article" />
          `,
          "https://ojs.aaai.org/index.php/AAAI/article/view/12345",
        ),
      ).toThrow(
        expect.objectContaining({
          code: "empty_result",
          retryable: false,
        }),
      );
    }
  });

  it("surfaces official OJS rate limiting as a structured retryable error", async () => {
    // REASON: The official network boundary is stubbed to deterministically exercise its HTTP error envelope.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })),
    );

    await expect(
      fetchAaaiHtml("https://ojs.aaai.org/demo", "AAAI demo"),
    ).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
      suggestion: expect.stringContaining("rate-limit"),
    });
  });

  it("surfaces request timeouts as a structured retryable error", async () => {
    // REASON: The official network boundary is stubbed to deterministically exercise its timeout envelope.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("timed out", "TimeoutError")),
    );

    await expect(
      fetchAaaiHtml("https://ojs.aaai.org/demo", "AAAI demo"),
    ).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
      suggestion: expect.stringContaining("Retry"),
    });
  });
});
