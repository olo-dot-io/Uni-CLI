import { describe, expect, it } from "vitest";

import { stepToEntries } from "../../../../src/engine/steps/to-entries.js";

const ctx = (data: unknown) => ({ data, args: {}, vars: {} });

describe("to_entries step", () => {
  it("converts an object into a key/value array", () => {
    const out = stepToEntries(ctx({ A9: "¥2315.0", M: "¥1005.0" }), {});
    expect(out.data).toEqual([
      { key: "A9", value: "¥2315.0" },
      { key: "M", value: "¥1005.0" },
    ]);
  });

  it("honors custom key_name / value_name", () => {
    const out = stepToEntries(ctx({ O: "¥598.0" }), {
      key_name: "seat",
      value_name: "price",
    });
    expect(out.data).toEqual([{ seat: "O", price: "¥598.0" }]);
  });

  it("returns an empty array for a non-object", () => {
    expect(stepToEntries(ctx("x"), {}).data).toEqual([]);
    expect(stepToEntries(ctx(null), {}).data).toEqual([]);
    expect(stepToEntries(ctx(42), {}).data).toEqual([]);
  });

  it("leaves an existing array untouched (passes it through)", () => {
    const arr = [{ a: 1 }];
    expect(stepToEntries(ctx(arr), {}).data).toBe(arr);
  });

  it("does not mutate the input object", () => {
    const obj = { a: "1" };
    stepToEntries(ctx(obj), {});
    expect(obj).toEqual({ a: "1" });
  });
});
