import { describe, expect, it } from "vitest";

import { resolveTaskIntentFrame } from "../../src/core/intent-frame.js";

describe("task intent frame", () => {
  it.each([
    [
      "read GitHub repository issues",
      {
        entity: "github-issue",
        cardinality: "many",
        site_hints: ["gh"],
        operation_family: "list",
      },
    ],
    [
      "fetch a GitHub issue thread",
      {
        entity: "github-issue",
        cardinality: "one",
        site_hints: ["gh"],
        operation_family: "get",
      },
    ],
    [
      "read latest GitHub releases",
      {
        entity: "github-release",
        cardinality: "many",
        site_hints: ["gh"],
        operation_family: "list",
      },
    ],
    [
      "get GitHub release",
      {
        entity: "github-release",
        cardinality: "many",
        site_hints: ["gh"],
        operation_family: "list",
      },
    ],
    [
      "read https://x.com/jack/status/20",
      {
        entity: "twitter-post",
        cardinality: "one",
        site_hints: ["twitter"],
        operation_family: "get",
      },
    ],
    [
      "list open browser tabs using browser protocol",
      {
        entity: "browser-tabs",
        cardinality: "many",
        site_hints: ["browser"],
        operation_family: "list",
        operator: "browser-protocol",
      },
    ],
    [
      "local computer use capture accessibility screenshot app shots reference",
      {
        entity: "desktop-context-capture",
        cardinality: "one",
        site_hints: ["compute"],
        operation_family: "capture",
        operator: "local-runtime",
      },
    ],
  ])("composes %s", (intent, expected) => {
    expect(resolveTaskIntentFrame(intent)).toMatchObject(expected);
  });

  it("treats coordinate variables as action data, never a Twitter/X alias", () => {
    expect(
      resolveTaskIntentFrame("point click x y via CUA driver"),
    ).toMatchObject({
      entity: "coordinate-action",
      operation_family: "invoke",
      operator: "visual-coordinate",
      site_hints: [],
    });
  });
});
