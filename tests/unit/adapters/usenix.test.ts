import { describe, expect, it } from "vitest";

import {
  parseUsenixPresentation,
  parseUsenixSchedule,
  resolveUsenixSeries,
} from "../../../src/adapters/usenix/proceedings.js";

describe("USENIX official proceedings", () => {
  it("resolves CCF A names and the renamed ATC alias", () => {
    expect(resolveUsenixSeries("FAST")).toBe("fast");
    expect(resolveUsenixSeries("USENIX Security Symposium")).toBe(
      "usenixsecurity",
    );
    expect(resolveUsenixSeries("ACM SIGOPS ATC")).toBe("atc");
  });

  it("parses paper rows and official award labels from a schedule", () => {
    const rows = parseUsenixSchedule(`
      <article class="node node-paper">
        <h2><a href="/conference/fast25/presentation/ananke">Ananke</a></h2>
        <span class="usenix-schedule-media pdf"></span>
        <div class="field-name-field-paper-people-text"><div class="field-item">
          Jing Liu, <em>Microsoft Research;</em> Yifan Dai, <em>UW</em>
          <span class="paper-award-badge">Awarded Best Paper!</span>
        </div></div>
        <div class="field-name-field-paper-description-long">Filesystem recovery.</div>
        <p>Awarded Best Paper!</p>
      </article>
    `);
    expect(rows).toEqual([
      expect.objectContaining({
        id: "conference/fast25/presentation/ananke",
        title: "Ananke",
        authors: ["Jing Liu", "Yifan Dai"],
        abstract: "Filesystem recovery.",
        award: "Best Paper",
        landing_url:
          "https://www.usenix.org/conference/fast25/presentation/ananke",
      }),
    ]);
  });

  it("excludes schedule talks without an official paper PDF", () => {
    const rows = parseUsenixSchedule(`
      <article class="node node-paper">
        <h2><a href="/conference/fast25/presentation/remarks">Opening Remarks</a></h2>
        <span class="usenix-schedule-media video"></span>
      </article>
    `);

    expect(rows).toEqual([]);
  });

  it("uses citation meta tags for exact metadata and open PDF evidence", () => {
    const row = parseUsenixPresentation(
      `
        <meta name="citation_title" content="Ananke" />
        <meta name="citation_author" content="Jing Liu" />
        <meta name="citation_author" content="Yifan Dai" />
        <meta name="citation_publication_date" content="2025" />
        <meta name="citation_conference_title" content="FAST 25" />
        <meta name="citation_pdf_url" content="https://www.usenix.org/system/files/fast25-ananke.pdf" />
        <body><div class="field-name-field-paper-description"><div class="field-item">Recovery.</div></div></body>
      `,
      "https://www.usenix.org/conference/fast25/presentation/ananke",
    );
    expect(row).toMatchObject({
      title: "Ananke",
      authors: ["Jing Liu", "Yifan Dai"],
      year: 2025,
      venue: "FAST 25",
      pdf_url: "https://www.usenix.org/system/files/fast25-ananke.pdf",
      source_adapter: "usenix",
    });
  });
});
