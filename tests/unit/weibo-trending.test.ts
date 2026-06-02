import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

describe("weibo trending adapter", () => {
  it("sends the referer required by the public hotSearch endpoint", () => {
    const raw = readFileSync("src/adapters/weibo/trending.yaml", "utf8");
    const parsed = yaml.load(raw) as {
      pipeline?: Array<{ fetch?: { headers?: Record<string, string> } }>;
    };

    expect(parsed.pipeline?.[0]?.fetch?.headers?.Referer).toBe(
      "https://weibo.com/",
    );
  });
});
