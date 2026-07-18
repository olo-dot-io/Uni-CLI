import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeRefsPath,
  describeElementRef,
  loadRefStore,
  RefAllocator,
  RefStoreAccessError,
  RefStore,
  RefStoreStateError,
  saveRefStore,
} from "../../src/transport/refs.js";
import { withRecoverableFileStoreLock } from "../../src/runtime/recoverable-file-lock.js";

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
  it("rejects duplicate aliases while preserving unique stable tokens", () => {
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

    expect(store.resolve("@e1")).toBeUndefined();
    expect(store.matches("@e1").map(({ ref }) => ref.stable)).toEqual([
      "desktop-ax:slack:AXWindow[0]/AXButton[0]",
      "desktop-uia:notepad:Window[0]/Edit[0]",
    ]);
    expect(
      store.matches("desktop-uia:notepad:Window[0]/Edit[0]")[0]?.ref.role,
    ).toBe("Edit");
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

  it("invalidates an exact binding when its bucket generation changes", () => {
    const first = new RefAllocator();
    first.alloc({
      stable: "desktop-ax:calc:AXWindow[0]/AXButton[0]",
      role: "AXButton",
      name: "1",
    });
    const second = new RefAllocator();
    second.alloc({
      stable: "desktop-ax:calc:AXWindow[0]/AXButton[1]",
      role: "AXButton",
      name: "2",
    });
    const store = new RefStore();
    store.put(first.freeze("desktop-ax", "calc"));
    const binding = store.matches("@e1")[0];

    expect(binding).toBeDefined();
    expect(binding && store.isCurrent(binding)).toBe(true);

    store.put(second.freeze("desktop-ax", "calc"));

    expect(binding && store.isCurrent(binding)).toBe(false);
    expect(store.resolve("@e1")?.name).toBe("2");
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
        stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[4]",
        role: "AXButton",
        name: "5",
        value: "5",
        bounds: { x: 1, y: 2, w: 3, h: 4 },
        screenIndex: 1,
        states: ["enabled"],
        app: "Calculator",
        pid: 42,
        windowId: 4242,
      });
      const store = new RefStore();
      store.put(alloc.freeze("desktop-ax", "window-4242"));

      saveRefStore(store, file);
      const loaded = loadRefStore(file);

      expect(loaded.resolve("@e1")).toMatchObject({
        stable: "desktop-ax:window-4242:AXWindow[0]/AXButton[4]",
        role: "AXButton",
        name: "5",
        value: "5",
        app: "Calculator",
        pid: 42,
        windowId: 4242,
        screenIndex: 1,
      });
      expect(
        loaded.resolveStable("desktop-ax:window-4242:AXWindow[0]/AXButton[4]"),
      ).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves alias ambiguity after persisted buckets reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-"));
    const file = join(dir, "refs.json");
    try {
      const left = new RefAllocator();
      left.alloc({
        stable: "desktop-ax:window-4101:AXWindow[0]/AXButton[0]",
        role: "AXButton",
        name: "Left",
        app: "Slack",
        pid: 101,
        windowId: 4101,
      });
      const right = new RefAllocator();
      right.alloc({
        stable: "desktop-ax:window-4202:AXWindow[0]/AXButton[0]",
        role: "AXButton",
        name: "Right",
        app: "Slack",
        pid: 202,
        windowId: 4202,
      });
      const store = new RefStore();
      store.put(left.freeze("desktop-ax", "window-4101"));
      store.put(right.freeze("desktop-ax", "window-4202"));
      saveRefStore(store, file);

      const loaded = loadRefStore(file);

      expect(loaded.resolve("@e1")).toBeUndefined();
      expect(loaded.matches("@e1")).toHaveLength(2);
      expect(
        loaded.resolveStable("desktop-ax:window-4202:AXWindow[0]/AXButton[0]")
          ?.name,
      ).toBe("Right");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges independently written target records without a stale read-modify-write", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-concurrent-"));
    const file = join(dir, "refs.json");
    try {
      const leftAllocator = new RefAllocator();
      leftAllocator.alloc({
        stable: "desktop-ax:window-101:AXWindow[0]/AXButton[0]",
        role: "AXButton",
        app: "Left",
        windowId: 101,
      });
      const rightAllocator = new RefAllocator();
      rightAllocator.alloc({
        stable: "desktop-ax:window-202:AXWindow[0]/AXButton[0]",
        role: "AXButton",
        app: "Right",
        windowId: 202,
      });
      const left = new RefStore();
      left.put(leftAllocator.freeze("desktop-ax", "window-101"));
      const right = new RefStore();
      right.put(rightAllocator.freeze("desktop-ax", "window-202"));

      saveRefStore(left, file);
      saveRefStore(right, file);

      const loaded = loadRefStore(file);
      expect(loaded.buckets()).toHaveLength(2);
      expect(
        loaded.resolveStable("desktop-ax:window-101:AXWindow[0]/AXButton[0]"),
      ).toBeDefined();
      expect(
        loaded.resolveStable("desktop-ax:window-202:AXWindow[0]/AXButton[0]"),
      ).toBeDefined();
      for (const record of readdirSync(`${file}.d`)) {
        expect(statSync(join(`${file}.d`, record)).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces live ref-store lock contention as a retryable temporary failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-contention-"));
    const file = join(dir, "refs.json");
    try {
      loadRefStore(file);
      let observed: unknown;
      withRecoverableFileStoreLock(`${file}.d`, () => {
        try {
          loadRefStore(file);
        } catch (error) {
          observed = error;
        }
      });

      expect(observed).toBeInstanceOf(RefStoreAccessError);
      expect(observed).toMatchObject({
        accessCode: "lock_timeout",
        minimum_capability: "compute.refs.lock_contention",
        exit_code: 75,
        retryable: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it("never republishes an untouched bucket loaded before another writer update", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-dirty-targets-"));
    const file = join(dir, "refs.json");
    const bucket = (windowId: number, name: string, createdAt = 1234) => {
      const allocator = new RefAllocator();
      allocator.alloc({
        stable: `desktop-ax:window-${String(windowId)}:AXWindow[0]/AXButton[0]`,
        role: "AXButton",
        name,
        app: `App-${String(windowId)}`,
        windowId,
      });
      return {
        ...allocator.freeze("desktop-ax", `window-${String(windowId)}`),
        createdAt,
      };
    };
    try {
      const initial = new RefStore();
      initial.put(bucket(101, "old-a"));
      initial.put(bucket(202, "old-b"));
      saveRefStore(initial, file);

      const writerA = loadRefStore(file);
      const writerB = loadRefStore(file);
      writerB.put(bucket(202, "new-b"));
      saveRefStore(writerB, file);
      writerA.put(bucket(101, "new-a"));
      saveRefStore(writerA, file);

      expect(
        loadRefStore(file)
          .list()
          .map((ref) => ref.name)
          .sort(),
      ).toEqual(["new-a", "new-b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chooses the later same-target publication when timestamps tie", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-order-"));
    const file = join(dir, "refs.json");
    try {
      const storeFor = (name: string): RefStore => {
        const allocator = new RefAllocator();
        allocator.alloc({
          stable: `desktop-ax:window-303:AXWindow[0]/AXButton[${name === "Old" ? 0 : 1}]`,
          role: "AXButton",
          name,
          app: "Editor",
          windowId: 303,
        });
        const store = new RefStore();
        store.put({
          ...allocator.freeze("desktop-ax", "window-303"),
          createdAt: 1234,
        });
        return store;
      };

      saveRefStore(storeFor("Old"), file);
      saveRefStore(storeFor("New"), file);

      expect(loadRefStore(file).list()).toMatchObject([{ name: "New" }]);
      expect(
        readdirSync(`${file}.d`).filter((name) => name.endsWith(".json")),
      ).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists exact string-valued UIA window identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-"));
    const file = join(dir, "refs.json");
    try {
      const alloc = new RefAllocator();
      alloc.alloc({
        stable: "desktop-uia:window-0x2:Window[0]/Button[0]",
        role: "Button",
        name: "Save",
        app: "Notepad",
        pid: 42,
        windowId: "0x2",
      });
      const store = new RefStore();
      store.put(alloc.freeze("desktop-uia", "desktop"));

      saveRefStore(store, file);

      expect(loadRefStore(file).resolve("@e1")).toMatchObject({
        stable: "desktop-uia:window-0x2:Window[0]/Button[0]",
        app: "Notepad",
        pid: 42,
        windowId: "0x2",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on an empty persisted refs file", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-"));
    const file = join(dir, "refs.json");
    try {
      writeFileSync(file, "");
      expect(() => loadRefStore(file)).toThrow(RefStoreStateError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists an empty latest bucket so invocation-only CDP refs cannot revive old refs", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-ephemeral-cdp-"));
    const file = join(dir, "refs.json");
    try {
      const priorAllocator = new RefAllocator();
      priorAllocator.alloc({
        stable: "cdp-browser:renderer-a:#old-submit",
        role: "button",
        cdpEndpoint: {
          port: 9222,
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/renderer-a",
          targetId: "renderer-a",
        },
      });
      const prior = new RefStore();
      prior.put(priorAllocator.freeze("cdp-browser", "renderer-a"));
      saveRefStore(prior, file);
      expect(loadRefStore(file).list()).toHaveLength(1);

      const allocator = new RefAllocator();
      allocator.alloc({
        stable: "cdp-browser:renderer-a:#submit",
        role: "button",
      });
      const store = new RefStore();
      store.put(allocator.freeze("cdp-browser", "renderer-a"));

      saveRefStore(store, file);

      expect(existsSync(file)).toBe(false);
      expect(existsSync(`${file}.d`)).toBe(true);
      expect(loadRefStore(file).list()).toEqual([]);
      expect(store.persistenceCandidates()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops legacy native and CDP refs that cannot prove their original target", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-"));
    const file = join(dir, "refs.json");
    try {
      writeFileSync(
        file,
        JSON.stringify({
          schema_version: 1,
          buckets: [
            {
              transport: "desktop-ax",
              scope: "focusedWindow",
              createdAt: Date.now(),
              refs: [
                {
                  alias: "@e1",
                  stable: "desktop-ax:focusedWindow:AXWindow[0]",
                  role: "AXWindow",
                  app: "Finder",
                },
              ],
            },
            {
              transport: "cdp-browser",
              scope: "renderer",
              createdAt: Date.now(),
              refs: [
                {
                  alias: "@e1",
                  stable: "cdp-browser:renderer:#submit",
                  role: "button",
                },
              ],
            },
            {
              transport: "desktop-uia",
              scope: "desktop",
              createdAt: Date.now(),
              refs: [
                {
                  alias: "@e2",
                  stable: "desktop-uia:pid-42:Window[0]/Button[0]",
                  role: "Button",
                  app: "Notepad",
                  pid: 42,
                },
              ],
            },
          ],
        }),
      );

      expect(loadRefStore(file).list()).toEqual([]);
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

  it("projects ref provenance with transport scope, identity, and expiry", () => {
    const alloc = new RefAllocator();
    const ref = alloc.alloc({
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
    const bucket = {
      ...alloc.freeze("desktop-ax", "calc"),
      createdAt: Date.parse("2026-06-15T04:00:00.000Z"),
    };

    expect(describeElementRef(ref, bucket, { ttlMs: 30_000 })).toEqual({
      provider: "unicli.compute",
      alias: "@e1",
      stable: "desktop-ax:calc:AXWindow[0]/AXButton[4]",
      namespace: "desktop-ax",
      transport: "desktop-ax",
      scope: "calc",
      createdAt: Date.parse("2026-06-15T04:00:00.000Z"),
      createdAtIso: "2026-06-15T04:00:00.000Z",
      expiresAt: Date.parse("2026-06-15T04:00:30.000Z"),
      expiresAtIso: "2026-06-15T04:00:30.000Z",
      ttlMs: 30_000,
      role: "AXButton",
      name: "5",
      value: "5",
      bounds: { x: 1, y: 2, w: 3, h: 4 },
      screenIndex: 1,
      states: ["enabled"],
      app: "Calculator",
      pid: 42,
      identity: {
        provider: "unicli.compute",
        transport: "desktop-ax",
        scope: "calc",
        app: "Calculator",
        pid: 42,
        screenIndex: 1,
      },
    });
  });

  it("projects minimal ref provenance without optional expiry", () => {
    const alloc = new RefAllocator();
    const ref = alloc.alloc({
      stable: "raw-ref-without-namespace",
      role: "button",
    });
    const bucket = {
      ...alloc.freeze("visual", "screen"),
      createdAt: Date.parse("2026-06-15T04:01:00.000Z"),
    };

    expect(describeElementRef(ref, bucket)).toEqual({
      provider: "unicli.compute",
      alias: "@e1",
      stable: "raw-ref-without-namespace",
      namespace: "alias",
      transport: "visual",
      scope: "screen",
      createdAt: Date.parse("2026-06-15T04:01:00.000Z"),
      createdAtIso: "2026-06-15T04:01:00.000Z",
      role: "button",
      identity: {
        provider: "unicli.compute",
        transport: "visual",
        scope: "screen",
      },
    });
  });

  it("returns an empty store only for missing state and rejects invalid payloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "unicli-refs-"));
    try {
      expect(loadRefStore(join(dir, "missing.json")).list()).toEqual([]);

      const invalidSchema = join(dir, "invalid-schema.json");
      writeFileSync(
        invalidSchema,
        JSON.stringify({ schema_version: 2, buckets: [] }),
      );
      expect(() => loadRefStore(invalidSchema)).toThrow(RefStoreStateError);

      const invalidBuckets = join(dir, "invalid-buckets.json");
      writeFileSync(
        invalidBuckets,
        JSON.stringify({ schema_version: 1, buckets: "nope" }),
      );
      expect(() => loadRefStore(invalidBuckets)).toThrow(RefStoreStateError);

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
      expect(() => loadRefStore(invalidRef)).toThrow(RefStoreStateError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
