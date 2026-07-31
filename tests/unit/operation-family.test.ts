import { describe, expect, it } from "vitest";

import {
  inferIntentOperationFamily,
  resolveOperationFamily,
} from "../../src/core/operation-family.js";

describe("operation family", () => {
  it.each([
    ["read a twitter post", "get"],
    ["view post comments on reddit", "get"],
    ["get upload status", "get"],
    ["inspect delete history", "get"],
    ["post this update to twitter", "create"],
    ["delete the reddit post", "delete"],
    ["search Reddit posts", "search"],
    ["get Hacker News top stories", "list"],
    ["recommend related papers", "list"],
    ["推荐相关论文", "list"],
  ] as const)("preserves the leading action in %s", (intent, expected) => {
    expect(inferIntentOperationFamily(intent)).toBe(expected);
  });

  it("does not turn an ambiguous object noun into a mutation", () => {
    expect(inferIntentOperationFamily("reddit post details")).toBeUndefined();
  });

  it("uses list semantics from a command description before generic retrieval discovery", () => {
    expect(
      resolveOperationFamily({
        command: "release",
        description: "List GitHub releases",
        retrieval: {
          operation: "discover",
          result_kind: "release",
          source_class: "official",
        },
      }),
    ).toMatchObject({
      family: "list",
      source: "description",
    });
  });

  it("classifies recommendation command names as list operations", () => {
    expect(
      resolveOperationFamily({ command: "recommendations" }),
    ).toMatchObject({
      family: "list",
      source: "command_name",
    });
  });
});
