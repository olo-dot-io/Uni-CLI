import { describe, expect, it } from "vitest";

import { assertComputeRefs } from "../../src/compute/assert.js";
import { RefAllocator, RefStore } from "../../src/transport/refs.js";

function refs(): RefStore {
  const allocator = new RefAllocator();
  allocator.alloc({
    stable: "desktop-ax:settings:checkbox",
    role: "checkbox",
    name: "Enable sync",
    value: "On",
    states: ["enabled", "checked", "visible"],
    app: "Settings",
  });
  const store = new RefStore();
  store.put(allocator.freeze("desktop-ax", "settings"));
  return store;
}

describe("assertComputeRefs", () => {
  it("matches all predicates against one current ref generation", () => {
    expect(
      assertComputeRefs(refs(), {
        ref: "desktop-ax:settings:checkbox",
        text: "sync",
        state: "checked",
      }),
    ).toMatchObject({
      ok: true,
      data: {
        asserted: true,
        evidence: "latest-ref-generation",
        stable: "desktop-ax:settings:checkbox",
      },
    });
  });

  it("fails when no current ref satisfies the requested state", () => {
    expect(assertComputeRefs(refs(), { state: "focused" })).toMatchObject({
      ok: false,
      error: {
        transport: "local-runtime",
        minimum_capability: "compute.compute_assert.current-ref",
      },
    });
  });

  it("rejects an assertion without a predicate", () => {
    expect(assertComputeRefs(refs(), {})).toMatchObject({
      ok: false,
      error: { exit_code: 2 },
    });
  });
});
