import { describe, expect, it } from "vitest";
import { verifyRowShape } from "../../src/engine/verify-row-shape.js";

describe("verifyRowShape", () => {
  it("returns skipped when no columns declared", () => {
    expect(verifyRowShape([{ a: 1 }], undefined)).toMatchObject({
      skipped: true,
    });
    expect(verifyRowShape([{ a: 1 }], [])).toMatchObject({ skipped: true });
  });

  it("returns skipped when results not an array", () => {
    expect(verifyRowShape("not an array", ["a"])).toMatchObject({
      skipped: true,
    });
    expect(verifyRowShape({}, ["a"])).toMatchObject({ skipped: true });
  });

  it("returns skipped on empty results array", () => {
    expect(verifyRowShape([], ["a", "b"])).toMatchObject({ skipped: true });
  });

  it("identifies populated and dropped columns", () => {
    const rows = [
      { id: 1, title: "x", author: null },
      { id: 2, title: "y", author: undefined },
    ];
    const report = verifyRowShape(rows, ["id", "title", "author"]);
    expect(report.skipped).toBe(false);
    expect(report.populated.sort()).toEqual(["id", "title"]);
    expect(report.dropped).toEqual(["author"]);
  });

  it("treats empty string as unpopulated", () => {
    const rows = [{ id: 1, label: "" }];
    expect(verifyRowShape(rows, ["id", "label"])).toMatchObject({
      populated: ["id"],
      dropped: ["label"],
    });
  });

  it("populated when at least one row has the column non-null", () => {
    const rows = [{ id: 1 }, { id: 2, optional: "ok" }];
    expect(verifyRowShape(rows, ["id", "optional"])).toMatchObject({
      populated: ["id", "optional"],
      dropped: [],
    });
  });

  it("ignores non-object items in the array", () => {
    const rows = [null, "string", { id: 1 }];
    expect(verifyRowShape(rows, ["id"])).toMatchObject({
      populated: ["id"],
      dropped: [],
    });
  });
});
