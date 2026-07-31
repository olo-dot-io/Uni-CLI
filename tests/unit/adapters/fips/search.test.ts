import { describe, expect, it } from "vitest";

import { runFipsSearch } from "../../../../src/adapters/fips/search.js";
import { browserPageReturning, failingBrowserPage } from "../browser-page.js";

describe("fips.search", () => {
  it("rejects an empty query", async () => {
    await expect(
      runFipsSearch(browserPageReturning({}), { query: "" }),
    ).rejects.toMatchObject({
      code: "PATENT_UNSUPPORTED_QUERY",
    });
  });

  it("fails instead of returning a successful error row", async () => {
    await expect(
      runFipsSearch(failingBrowserPage("browser unavailable"), {
        query: "квантовый",
      }),
    ).rejects.toThrow("browser unavailable");
  });

  it("normalises rows and prefixes RU when absent", async () => {
    const rows = await runFipsSearch(
      browserPageReturning({
        rows: [
          {
            publication_number: "2789000C1",
            title: "Quantum widget",
            applicant: "Skoltech",
            publication_date: "2024-04-22",
          },
        ],
      }),
      { query: "quantum" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      publication_number: "RU-2789000-C1",
      source_adapter: "fips",
    });
  });
});
