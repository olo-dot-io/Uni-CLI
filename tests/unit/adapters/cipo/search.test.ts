import { describe, expect, it } from "vitest";

import { runCipoSearch } from "../../../../src/adapters/cipo/search.js";
import { browserPageReturning, failingBrowserPage } from "../browser-page.js";

describe("cipo.search", () => {
  it("rejects an empty query without touching the browser", async () => {
    await expect(
      runCipoSearch(browserPageReturning({}), { query: "" }),
    ).rejects.toMatchObject({
      code: "PATENT_UNSUPPORTED_QUERY",
    });
  });

  it("fails the command when its declared browser substrate fails", async () => {
    await expect(
      runCipoSearch(failingBrowserPage("browser unavailable"), {
        query: "vaccine",
      }),
    ).rejects.toThrow("browser unavailable");
  });

  it("normalises rows into PatentRecord and prefixes CA when absent", async () => {
    const rows = await runCipoSearch(
      browserPageReturning({
        rows: [
          {
            publication_number: "3001234A1",
            title: "Maple-syrup widget",
            applicant: "Big Maple Inc",
            publication_date: "2024-01-15",
          },
        ],
      }),
      { query: "maple" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      publication_number: "CA-3001234-A1",
      source_adapter: "cipo",
    });
  });
});
