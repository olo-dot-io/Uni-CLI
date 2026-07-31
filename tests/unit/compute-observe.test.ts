import { describe, expect, it } from "vitest";

import { observeComputeRefs } from "../../src/compute/observe.js";
import { RefAllocator, RefStore } from "../../src/transport/refs.js";

function fixtureStore(): RefStore {
  const textEdit = new RefAllocator();
  textEdit.alloc({
    stable: "desktop-ax:window-10:Window[0]/Button[1]",
    role: "button",
    name: "Save document",
    app: "TextEdit",
    windowId: 10,
  });
  textEdit.alloc({
    stable: "desktop-ax:window-10:Window[0]/TextField[1]",
    role: "input",
    name: "Document title",
    value: "Draft",
    app: "TextEdit",
    windowId: 10,
  });
  const browser = new RefAllocator();
  browser.alloc({
    stable: "cdp-browser:target-1:button#save",
    role: "button",
    name: "Save settings",
    app: "Browser",
  });

  const store = new RefStore();
  store.put(textEdit.freeze("desktop-ax", "window-10"));
  store.put(browser.freeze("cdp-browser", "target-1"));
  return store;
}

describe("compute observe", () => {
  it("ranks provider-owned refs locally with stable bounded Top-K", () => {
    const result = observeComputeRefs(fixtureStore(), {
      goal: "save document",
      topK: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      goal: "save document",
      evaluated: 3,
      candidates: [
        {
          stable: "desktop-ax:window-10:Window[0]/Button[1]",
          name: "Save document",
          score: expect.any(Number),
        },
      ],
    });
  });

  it("applies exact app scope before ranking", () => {
    const result = observeComputeRefs(fixtureStore(), {
      goal: "save",
      app: "browser",
      topK: 5,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      app: "browser",
      evaluated: 1,
      candidates: [{ app: "Browser", name: "Save settings" }],
    });
  });

  it("rejects unbounded or empty requests", () => {
    expect(
      observeComputeRefs(fixtureStore(), { goal: "", topK: 5 }),
    ).toMatchObject({
      ok: false,
      error: { exit_code: 2, retryable: false },
    });
    expect(
      observeComputeRefs(fixtureStore(), { goal: "save", topK: 51 }),
    ).toMatchObject({
      ok: false,
      error: { exit_code: 2, retryable: false },
    });
  });
});
