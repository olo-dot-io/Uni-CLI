import { describe, expect, it } from "vitest";

import { runCnipaSearch } from "../../../../src/adapters/cnipa/search.js";
import { browserPageReturning, failingBrowserPage } from "../browser-page.js";

describe("cnipa.search", () => {
  it("throws PATENT_UNSUPPORTED_QUERY for an empty query", async () => {
    await expect(
      runCnipaSearch(browserPageReturning({}), { query: "" }),
    ).rejects.toMatchObject({
      code: "PATENT_UNSUPPORTED_QUERY",
      adapter_path: "src/adapters/cnipa/search.ts",
    });
  });

  it("fails the command when browser navigation fails", async () => {
    await expect(
      runCnipaSearch(failingBrowserPage("browser unavailable"), {
        query: "graphene",
      }),
    ).rejects.toThrow("browser unavailable");
  });

  it("normalizes browser rows into PatentRecord", async () => {
    const rows = await runCnipaSearch(
      browserPageReturning({
        rows: [
          {
            publication_number: "CN114123456A",
            application_number: "202310001234",
            title: "An apparatus for widget assembly",
            applicant: "Acme China Co., Ltd",
            publication_date: "2024-06-01",
          },
          {
            publication_number: "CN999000111B",
            title: "Quantum dot foo bar",
            applicant: "Beta R&D",
            publication_date: "2024-07-15",
          },
        ],
        html_marker: "搜索结果：检索到2条记录",
      }),
      { query: "graphene", limit: 5 },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      publication_number: "CN-114123456-A",
      title: "An apparatus for widget assembly",
      source_adapter: "cnipa",
    });
    expect(
      Date.parse((rows[0] as { retrieved_at: string }).retrieved_at),
    ).toBeGreaterThan(0);
  });

  it("throws PATENT_BROWSER_CAPTCHA for a challenged empty result", async () => {
    await expect(
      runCnipaSearch(
        browserPageReturning({ rows: [], html_marker: "请输入验证码" }),
        { query: "graphene" },
      ),
    ).rejects.toMatchObject({
      code: "PATENT_BROWSER_CAPTCHA",
      retryable: false,
    });
  });

  it("rejects rows missing publication_number rather than synthesizing", async () => {
    await expect(
      runCnipaSearch(
        browserPageReturning({
          rows: [{ title: "Some patent without a number" }],
          html_marker: "Results page",
        }),
        { query: "x" },
      ),
    ).rejects.toMatchObject({
      code: "PATENT_SCHEMA_DRIFT",
    });
  });
});
