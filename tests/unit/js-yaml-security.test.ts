import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

function mergedMapping(keyCount: number): string {
  const keys = Array.from(
    { length: keyCount },
    (_, index) => `  key_${index}: ${index}`,
  ).join("\n");
  return `base: &base\n${keys}\ntarget:\n  <<: *base\n`;
}

describe("js-yaml merge complexity boundary", () => {
  it("keeps ordinary adapter merge aliases compatible", () => {
    const parsed = yaml.load(mergedMapping(3)) as {
      target: Record<string, number>;
    };
    expect(parsed.target).toEqual({ key_0: 0, key_1: 1, key_2: 2 });
  });

  it("rejects a merge expansion beyond the upstream default budget", () => {
    expect(() => yaml.load(mergedMapping(10_001))).toThrow(
      /maxTotalMergeKeys \(10000\)/,
    );
  });
});
