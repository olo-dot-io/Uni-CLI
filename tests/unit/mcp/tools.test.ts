/**
 * Tool-definition builder tests. Pins the contract that collision warnings
 * are emitted to stderr regardless of build mode (expanded vs deferred) —
 * silent `continue` was the P2 review gap.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import {
  buildDefaultTools,
  buildDeferredTools,
  buildExpandedTools,
  DEFAULT_TOOL_NAMES,
} from "../../../src/mcp/tools.js";
import { registerAdapter } from "../../../src/registry.js";
import { primeKernelCache } from "../../../src/discovery/loader.js";
import { AdapterType } from "../../../src/types.js";
import type { AdapterManifest } from "../../../src/types.js";

// Two synthetic adapters whose (site, command) pairs normalize to the same
// tool name via buildToolName — `unicli_collider_twin_x` is produced by
// both { site: "collider-twin", command: "x" } and { site: "collider",
// command: "twin_x" } because non-alphanumerics collapse to `_`.
const ADAPTER_A: AdapterManifest = {
  name: "collider-twin",
  type: AdapterType.WEB_API,
  strategy: "public",
  version: "1.0.0",
  commands: {
    x: {
      name: "x",
      description: "collision fixture A",
      func: async () => [{ ok: "A" }],
    },
  },
};

const ADAPTER_B: AdapterManifest = {
  name: "collider",
  type: AdapterType.WEB_API,
  strategy: "public",
  version: "1.0.0",
  commands: {
    twin_x: {
      name: "twin_x",
      description: "collision fixture B",
      func: async () => [{ ok: "B" }],
    },
  },
};

beforeAll(() => {
  registerAdapter(ADAPTER_A);
  registerAdapter(ADAPTER_B);
  primeKernelCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DEFAULT_TOOL_NAMES registry", () => {
  it("buildDefaultTools stays in lock-step with DEFAULT_TOOL_NAMES", () => {
    const names = buildDefaultTools().map((t) => t.name);
    for (const n of names) {
      expect(DEFAULT_TOOL_NAMES.has(n)).toBe(true);
    }
  });
});

describe("collision warnings — expanded vs deferred parity", () => {
  it("buildDeferredTools warns on collisions (parity with buildExpandedTools)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    buildDeferredTools();
    const calls = spy.mock.calls.flat().join("");
    expect(calls).toMatch(/tool name collision/);
    expect(calls).toMatch(/unicli_collider_twin_x/);
  });

  it("buildExpandedTools warns on collisions (existing behavior)", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    buildExpandedTools();
    const calls = spy.mock.calls.flat().join("");
    expect(calls).toMatch(/tool name collision/);
    expect(calls).toMatch(/unicli_collider_twin_x/);
  });
});
