import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeRefsPath,
  loadRefStore,
  RefAllocator,
  RefStore,
  saveRefStore,
} from "../../src/transport/refs.js";

describe("RefAllocator", () => {
  it("allocates monotonic aliases and preserves stable-token identity", () => {
    const alloc = new RefAllocator();

    const first = alloc.alloc({
      stable: "desktop-ax:42:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Send",
    });
    const second = alloc.alloc({
      stable: "desktop-ax:42:AXWindow[0]/AXTextField[0]",
      role: "AXTextField",
      name: "Message",
    });
    const firstAgain = alloc.alloc({
      stable: "desktop-ax:42:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Send",
    });

    expect(first.alias).toBe("@e1");
    expect(second.alias).toBe("@e2");
    expect(firstAgain).toBe(first);
    expect(alloc.size).toBe(2);
  });

  it("freezes immutable lookup buckets", () => {
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "desktop-atspi:calc:frame[0]/push_button[7]",
      role: "push_button",
      name: "7",
    });

    const bucket = alloc.freeze("desktop-atspi", "calc");

    expect(bucket.transport).toBe("desktop-atspi");
    expect(bucket.scope).toBe("calc");
    expect(bucket.byAlias.get("@e1")?.name).toBe("7");
    expect(
      bucket.byStable.get("desktop-atspi:calc:frame[0]/push_button[7]"),
    ).toBeTruthy();
  });
});

describe("RefStore", () => {
  it("resolves aliases and stable tokens across latest buckets", () => {
    const ax = new RefAllocator();
    const uia = new RefAllocator();
    ax.alloc({
      stable: "desktop-ax:slack:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Send",
    });
    uia.alloc({
      stable: "desktop-uia:notepad:Window[0]/Edit[0]",
      role: "Edit",
      name: "Text Editor",
    });

    const store = new RefStore();
    store.put(ax.freeze("desktop-ax", "slack"));
    store.put(uia.freeze("desktop-uia", "notepad"));

    expect(store.resolve("@e1")?.stable).toBe(
      "desktop-ax:slack:AXWindow[0]/AXButton[0]",
    );
    expect(
      store.resolveStable("desktop-uia:notepad:Window[0]/Edit[0]")?.role,
    ).toBe("Edit");
  });

  it("replaces old aliases for the same transport and scope", () => {
    const first = new RefAllocator();
    first.alloc({
      stable: "desktop-ax:slack:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "Send",
    });

    const second = new RefAllocator();
    second.alloc({
      stable: "desktop-ax:slack:AXWindow[0]/AXTextField[0]",
      role: "AXTextField",
      name: "Message",
    });

    const store = new RefStore();
    store.put(first.freeze("desktop-ax", "slack"));
    store.put(second.freeze("desktop-ax", "slack"));

    expect(
      store.resolveStable("desktop-ax:slack:AXWindow[0]/AXButton[0]"),
    ).toBeUndefined();
    expect(store.resolve("@e1")?.stable).toBe(
      "desktop-ax:slack:AXWindow[0]/AXTextField[0]",
    );
  });

  it("lists refs, clones buckets, and clears current buckets", () => {
    const alloc = new RefAllocator();
    alloc.alloc({
      stable: "desktop-ax:calc:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "1",
    });
    const store = new RefStore();
    store.put(alloc.freeze("desktop-ax", "calc"));

    expect(store.list()).toHaveLength(1);
    const [bucket] = store.buckets();
    expect(bucket?.byAlias.get("@e1")?.name).toBe("1");
    bucket?.byAlias.clear();

    expect(store.resolve("@e1")?.name).toBe("1");
    store.clear();
    expect(store.list()).toEqual([]);
    expect(store.resolve("@e1")).toBeUndefined();
    expect(
      store.resolveStable("desktop-ax:calc:AXWindow[0]/AXButton[0]"),
    ).toBeUndefined();
  });

  it("persists and reloads latest ref buckets for separate CLI processes", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-"));
    const file = join(dir, "refs.json");
    try {
      const alloc = new RefAllocator();
      alloc.alloc({
        stable: "desktop-ax:calc:AXWindow[0]/AXButton[4]",
        role: "AXButton",
        name: "5",
        value: "5",
        bounds: { x: 1, y: 2, w: 3, h: 4 },
        screenIndex: 1,
        states: ["enabled"],
        app: "Calculator",
        pid: 42,
      });
      const store = new RefStore();
      store.put(alloc.freeze("desktop-ax", "calc"));

      saveRefStore(store, file);
      const loaded = loadRefStore(file);

      expect(loaded.resolve("@e1")).toMatchObject({
        stable: "desktop-ax:calc:AXWindow[0]/AXButton[4]",
        role: "AXButton",
        name: "5",
        value: "5",
        app: "Calculator",
        pid: 42,
        screenIndex: 1,
      });
      expect(
        loaded.resolveStable("desktop-ax:calc:AXWindow[0]/AXButton[4]"),
      ).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an empty persisted refs file as an empty store", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-"));
    const file = join(dir, "refs.json");
    try {
      writeFileSync(file, "");
      const loaded = loadRefStore(file);
      expect(loaded.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses env override or the default refs path", () => {
    const previous = process.env.UNICLI_COMPUTE_REFS_PATH;
    try {
      process.env.UNICLI_COMPUTE_REFS_PATH = "/tmp/unicli-refs-test.json";
      expect(computeRefsPath()).toBe("/tmp/unicli-refs-test.json");
      delete process.env.UNICLI_COMPUTE_REFS_PATH;
      expect(computeRefsPath()).toContain(".unicli/compute/refs.json");
    } finally {
      if (previous === undefined) {
        delete process.env.UNICLI_COMPUTE_REFS_PATH;
      } else {
        process.env.UNICLI_COMPUTE_REFS_PATH = previous;
      }
    }
  });

  it("returns an empty store for missing or invalid persisted payloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-"));
    try {
      expect(loadRefStore(join(dir, "missing.json")).list()).toEqual([]);

      const invalidSchema = join(dir, "invalid-schema.json");
      writeFileSync(
        invalidSchema,
        JSON.stringify({ schema_version: 2, buckets: [] }),
      );
      expect(loadRefStore(invalidSchema).list()).toEqual([]);

      const invalidBuckets = join(dir, "invalid-buckets.json");
      writeFileSync(
        invalidBuckets,
        JSON.stringify({ schema_version: 1, buckets: "nope" }),
      );
      expect(loadRefStore(invalidBuckets).list()).toEqual([]);

      const invalidRef = join(dir, "invalid-ref.json");
      writeFileSync(
        invalidRef,
        JSON.stringify({
          schema_version: 1,
          buckets: [
            {
              transport: "desktop-ax",
              scope: "calc",
              createdAt: Date.now(),
              refs: [{ alias: "@e1", stable: "desktop-ax:calc:Button[0]" }],
            },
          ],
        }),
      );
      expect(loadRefStore(invalidRef).list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
