import { describe, expect, it } from "vitest";
import {
  buildExtractAibaseNewsJs,
  mapAibaseNewsPayload,
  requireNewsLimit,
} from "./news.js";

describe("aibase agent-facing news command", () => {
  it("validates limits and exposes selector extraction code", () => {
    expect(requireNewsLimit(undefined)).toBe(20);
    expect(requireNewsLimit("50")).toBe(50);
    expect(() => requireNewsLimit("0")).toThrow("limit must be");
    expect(buildExtractAibaseNewsJs()).toContain("/zh/daily/");
  });

  it("maps extracted rows and rejects selector drift", () => {
    expect(
      mapAibaseNewsPayload(
        {
          ok: true,
          rows: [
            { title: " AI  news ", url: " https://www.aibase.com/zh/daily/1 " },
            { title: "", url: "https://example.test/empty" },
          ],
        },
        10,
      ),
    ).toEqual([
      {
        rank: 1,
        title: "AI news",
        url: "https://www.aibase.com/zh/daily/1",
      },
    ]);
    expect(() =>
      mapAibaseNewsPayload({ ok: false, reason: "selector-missing" }, 10),
    ).toThrow("selector drift");
    expect(() => mapAibaseNewsPayload({ ok: true, rows: [] }, 10)).toThrow(
      "no article rows",
    );
  });
});
