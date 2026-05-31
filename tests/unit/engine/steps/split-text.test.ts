import { describe, expect, it } from "vitest";

import { stepSplitText } from "../../../../src/engine/steps/split-text.js";

const ctx = (data: unknown) => ({ data, args: {}, vars: {} });

describe("split_text step", () => {
  it("splits a delimited record string into an array of mapped objects", () => {
    const data = "a|1@b|2@c|3";
    const out = stepSplitText(ctx(data), {
      record_separator: "@",
      field_separator: "|",
      columns: ["name", "id"],
    });
    expect(out.data).toEqual([
      { name: "a", id: "1" },
      { name: "b", id: "2" },
      { name: "c", id: "3" },
    ]);
  });

  it("drops empty records produced by a trailing separator", () => {
    const out = stepSplitText(ctx("a|1@b|2@"), {
      record_separator: "@",
      field_separator: "|",
      columns: ["name", "id"],
    });
    expect(out.data).toEqual([
      { name: "a", id: "1" },
      { name: "b", id: "2" },
    ]);
  });

  it("strips an enclosing prefix via strip_prefix regex before splitting", () => {
    // Mirrors the 12306 station_name.js bundle: `var x ='@a|1@b|2';`
    const data = "var station_names ='@bjb|北京北|VAP@bjd|北京东|BOP';";
    const out = stepSplitText(ctx(data), {
      strip_prefix: "^[^']*'",
      strip_suffix: "';?\\s*$",
      record_separator: "@",
      field_separator: "|",
      columns: ["abbr", "name", "code"],
    });
    expect(out.data).toEqual([
      { abbr: "bjb", name: "北京北", code: "VAP" },
      { abbr: "bjd", name: "北京东", code: "BOP" },
    ]);
  });

  it("keeps extra fields beyond the declared columns out of the row", () => {
    const out = stepSplitText(ctx("a|1|x|y"), {
      record_separator: "@",
      field_separator: "|",
      columns: ["name", "id"],
    });
    expect(out.data).toEqual([{ name: "a", id: "1" }]);
  });

  it("assigns empty string when a record has fewer fields than columns", () => {
    const out = stepSplitText(ctx("a@b|2"), {
      record_separator: "@",
      field_separator: "|",
      columns: ["name", "id"],
    });
    expect(out.data).toEqual([
      { name: "a", id: "" },
      { name: "b", id: "2" },
    ]);
  });

  it("returns a flat string array when no columns are declared", () => {
    const out = stepSplitText(ctx("a,b,c"), {
      record_separator: ",",
    });
    expect(out.data).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input context", () => {
    const input = ctx("a|1@b|2");
    stepSplitText(input, {
      record_separator: "@",
      field_separator: "|",
      columns: ["name", "id"],
    });
    expect(input.data).toBe("a|1@b|2");
  });

  it("throws when record_separator is missing", () => {
    expect(() =>
      stepSplitText(ctx("a|1"), {
        field_separator: "|",
        columns: ["name", "id"],
      } as never),
    ).toThrow(/record_separator/);
  });

  it("yields an empty array for empty input", () => {
    const out = stepSplitText(ctx(""), {
      record_separator: "@",
      field_separator: "|",
      columns: ["name"],
    });
    expect(out.data).toEqual([]);
  });
});

describe("split_text mode: per_item", () => {
  it("splits each string element of an existing array by columns", () => {
    const out = stepSplitText(ctx(["a|1", "b|2"]), {
      mode: "per_item",
      field_separator: "|",
      columns: ["name", "id"],
    });
    expect(out.data).toEqual([
      { name: "a", id: "1" },
      { name: "b", id: "2" },
    ]);
  });

  it("URL-decodes each element when decode: uri is set", () => {
    const out = stepSplitText(ctx(["%E5%8C%97|VNP"]), {
      mode: "per_item",
      decode: "uri",
      field_separator: "|",
      columns: ["name", "code"],
    });
    expect(out.data).toEqual([{ name: "北", code: "VNP" }]);
  });

  it("strips a noise regex from each element before decode+split (12306 %0A)", () => {
    // mirrors 12306: rows carry %0A line-wrap noise, then URL-encoded fields
    const out = stepSplitText(ctx(["a%0Ab|G547|240000G547"]), {
      mode: "per_item",
      strip_each: "%0A",
      field_separator: "|",
      columns: ["raw", "code", "train_no"],
    });
    expect(out.data).toEqual([
      { raw: "ab", code: "G547", train_no: "240000G547" },
    ]);
  });

  it("does not require record_separator in per_item mode", () => {
    expect(() =>
      stepSplitText(ctx(["a|1"]), {
        mode: "per_item",
        field_separator: "|",
        columns: ["name", "id"],
      }),
    ).not.toThrow();
  });

  it("yields an empty array when the input array is empty", () => {
    const out = stepSplitText(ctx([]), {
      mode: "per_item",
      field_separator: "|",
      columns: ["name"],
    });
    expect(out.data).toEqual([]);
  });

  it("coerces non-array input to empty in per_item mode", () => {
    const out = stepSplitText(ctx("not-an-array"), {
      mode: "per_item",
      field_separator: "|",
      columns: ["name"],
    });
    expect(out.data).toEqual([]);
  });
});
