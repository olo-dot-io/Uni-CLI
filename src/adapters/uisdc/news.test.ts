import { describe, expect, it } from "vitest";
import {
  buildExtractUisdcNewsJs,
  mapUisdcNewsPayload,
  requireNewsLimit,
} from "./news.js";

describe("uisdc agent-facing news command", () => {
  it("validates limits and exposes selector extraction code", () => {
    expect(requireNewsLimit(undefined)).toBe(20);
    expect(requireNewsLimit("50")).toBe(50);
    expect(() => requireNewsLimit("51")).toThrow("limit must be");
    expect(buildExtractUisdcNewsJs()).toContain(".dubao-item");
  });

  it("maps extracted rows and rejects selector drift", () => {
    expect(
      mapUisdcNewsPayload(
        {
          ok: true,
          rows: [
            {
              title: " Design  news ",
              summary: " AI update ",
              url: " https://www.uisdc.com/news/a ",
            },
          ],
        },
        1,
      ),
    ).toEqual([
      {
        rank: 1,
        title: "Design news",
        summary: "AI update",
        url: "https://www.uisdc.com/news/a",
      },
    ]);
    expect(() =>
      mapUisdcNewsPayload({ ok: false, reason: "selector-missing" }, 10),
    ).toThrow("selector drift");
    expect(() => mapUisdcNewsPayload({ ok: true, rows: [] }, 10)).toThrow(
      "no news rows",
    );
  });
});
