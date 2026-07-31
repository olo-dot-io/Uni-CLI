import { describe, expect, it } from "vitest";

import { runEspacenetSearch } from "../../../../src/adapters/espacenet/search.js";
import { browserPageReturning, failingBrowserPage } from "../browser-page.js";

describe("espacenet.search", () => {
  it("throws PATENT_UNSUPPORTED_QUERY for an empty query", async () => {
    await expect(
      runEspacenetSearch(browserPageReturning({}), { query: "" }),
    ).rejects.toMatchObject({
      code: "PATENT_UNSUPPORTED_QUERY",
    });
  });

  it("fails the command when its declared browser substrate fails", async () => {
    await expect(
      runEspacenetSearch(failingBrowserPage("browser unavailable"), {
        query: "graphene",
      }),
    ).rejects.toThrow("browser unavailable");
  });

  it("normalises browser rows into PatentRecord", async () => {
    const rows = await runEspacenetSearch(
      browserPageReturning({
        rows: [
          {
            publication_number: "EP4123456A1",
            title: "Energy harvesting widget",
            applicant: "Acme EU",
            publication_date: "2024-03-10",
            source_url:
              "https://worldwide.espacenet.com/patent/search/publication/EP4123456A1",
          },
        ],
        html_marker: "Found 1 result",
      }),
      { query: "energy" },
    );
    expect(rows[0]).toMatchObject({
      publication_number: "EP-4123456-A1",
      title: "Energy harvesting widget",
      source_adapter: "espacenet",
    });
  });

  it("throws PATENT_BROWSER_CAPTCHA for a challenged empty result", async () => {
    await expect(
      runEspacenetSearch(
        browserPageReturning({
          rows: [],
          html_marker: "Are you a human? Solve the CAPTCHA",
        }),
        { query: "energy" },
      ),
    ).rejects.toMatchObject({
      code: "PATENT_BROWSER_CAPTCHA",
    });
  });

  it("throws PATENT_NOT_FOUND for an ordinary empty result", async () => {
    await expect(
      runEspacenetSearch(
        browserPageReturning({
          rows: [],
          html_marker: "No documents match your query",
        }),
        { query: "energy" },
      ),
    ).rejects.toMatchObject({
      code: "PATENT_NOT_FOUND",
    });
  });
});
