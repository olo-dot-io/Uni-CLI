import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

describe("maoyan hot adapter", () => {
  it("selects the current public box-office movie list path", () => {
    const raw = readFileSync("src/adapters/maoyan/hot.yaml", "utf8");
    const parsed = yaml.load(raw) as {
      pipeline?: Array<{ select?: string }>;
    };

    expect(parsed.pipeline?.[1]?.select).toBe("movieList.list");
    expect(raw).not.toContain("movieList.data.list");
  });
});
