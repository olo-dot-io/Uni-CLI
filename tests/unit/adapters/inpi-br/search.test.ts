import { describe, expect, it } from "vitest";

import { runInpiBrSearch } from "../../../../src/adapters/inpi-br/search.js";
import { browserPageReturning, failingBrowserPage } from "../browser-page.js";

describe("inpi-br.search", () => {
  it("rejects an empty query", async () => {
    await expect(
      runInpiBrSearch(browserPageReturning({}), { query: "" }),
    ).rejects.toMatchObject({
      code: "PATENT_UNSUPPORTED_QUERY",
    });
  });

  it("fails instead of returning a successful error row", async () => {
    await expect(
      runInpiBrSearch(failingBrowserPage("browser unavailable"), {
        query: "vacina",
      }),
    ).rejects.toThrow("browser unavailable");
  });

  it("normalises rows and prefixes BR when absent", async () => {
    const rows = await runInpiBrSearch(
      browserPageReturning({
        rows: [
          {
            publication_number: "1020230012345A2",
            title: "Algum invento",
            applicant: "Empresa Brasil S.A.",
            publication_date: "2024-08-22",
          },
        ],
      }),
      { query: "invento" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      publication_number: "BR-1020230012345-A2",
      source_adapter: "inpi-br",
    });
  });
});
