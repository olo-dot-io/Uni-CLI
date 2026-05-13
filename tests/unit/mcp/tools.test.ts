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
import { buildHandler } from "../../../src/mcp/handler.js";
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

const ADAPTER_C: AdapterManifest = {
  name: "contract-write",
  type: AdapterType.WEB_API,
  strategy: "public",
  version: "1.0.0",
  domain: "write.example.com",
  commands: {
    delete: {
      name: "delete",
      description: "Delete a remote record",
      adapter_path: "src/adapters/contract-write/delete.yaml",
      func: async () => [{ ok: true }],
    },
  },
};

beforeAll(() => {
  registerAdapter(ADAPTER_A);
  registerAdapter(ADAPTER_B);
  registerAdapter(ADAPTER_C);
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

describe("computer-use profile", () => {
  it("selectTools returns exactly the 15 computer-use tools", async () => {
    const toolsModule = await import("../../../src/mcp/tools.js");
    const selectTools = (
      toolsModule as unknown as {
        selectTools?: (profile: string) => Array<{ name: string }>;
      }
    ).selectTools;

    expect(typeof selectTools).toBe("function");
    const tools = selectTools!("computer-use");

    expect(tools.map((tool) => tool.name)).toEqual([
      "computer-use.apps",
      "computer-use.windows",
      "computer-use.snapshot",
      "computer-use.find",
      "computer-use.click",
      "computer-use.type",
      "computer-use.press",
      "computer-use.scroll",
      "computer-use.launch",
      "computer-use.screenshot",
      "computer-use.attach",
      "computer-use.evaluate",
      "computer-use.wait",
      "computer-use.observe",
      "computer-use.assert",
    ]);
    for (const name of [
      "computer-use.click",
      "computer-use.type",
      "computer-use.press",
      "computer-use.scroll",
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.properties).toHaveProperty("focus", {
        type: "boolean",
        default: false,
      });
    }
  });

  it("selectPrompts returns the computer-use operating prompt", async () => {
    const toolsModule = await import("../../../src/mcp/tools.js");
    const selectPrompts = (
      toolsModule as unknown as {
        selectPrompts?: (profile: string) => Array<{
          name: string;
          description: string;
          text: string;
        }>;
      }
    ).selectPrompts;

    expect(typeof selectPrompts).toBe("function");
    const prompts = selectPrompts!("computer-use");

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      name: "computer-use",
      description: expect.stringContaining("desktop"),
    });
    expect(prompts[0]?.text).toContain("compact accessibility snapshots");
    expect(prompts[0]?.text).toContain("re-snapshot after actions");
  });

  it("MCP handler serves the computer-use prompt through prompts/list and prompts/get", async () => {
    const [{ buildHandler }, { selectPrompts, selectTools }] =
      await Promise.all([
        import("../../../src/mcp/handler.js"),
        import("../../../src/mcp/tools.js") as Promise<
          typeof import("../../../src/mcp/tools.js") & {
            selectPrompts: (
              profile: string,
            ) => Array<{ name: string; description: string; text: string }>;
          }
        >,
      ]);
    const handler = buildHandler(
      selectTools("computer-use"),
      selectPrompts("computer-use"),
    );

    const listed = await handler({
      jsonrpc: "2.0",
      id: 201,
      method: "prompts/list",
      params: {},
    });
    expect(listed?.result).toEqual({
      prompts: [
        expect.objectContaining({
          name: "computer-use",
          description: expect.stringContaining("desktop"),
        }),
      ],
    });

    const got = await handler({
      jsonrpc: "2.0",
      id: 202,
      method: "prompts/get",
      params: { name: "computer-use" },
    });
    expect(got?.result).toMatchObject({
      description: expect.stringContaining("desktop"),
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: expect.stringContaining("compact accessibility snapshots"),
          },
        },
      ],
    });
  });

  it("computer-use tool results include action evidence and preserve remedies", async () => {
    const toolsModule = await import("../../../src/mcp/tools.js");
    const tools = toolsModule.selectTools("computer-use");
    const find = tools.find((tool) => tool.name === "computer-use.find");

    const result = await find?.handler?.({
      role: "spinbutton",
      name: "definitely-not-present",
      first: true,
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.data).toMatchObject({
      minimum_capability: "compute.compute_find.ref-store",
      remedy: {
        command: "unicli compute snapshot",
      },
    });
    expect(result?._meta?.evidence).toMatchObject({
      evidence_type: "computer-use-action",
      tool: "computer-use.find",
      action: "compute_find",
      ok: false,
      minimum_capability: "compute.compute_find.ref-store",
    });
  });
});

describe("collision warnings — expanded vs deferred parity", () => {
  it("expanded tools derive safety annotations from CommandContract", () => {
    const tools = buildExpandedTools();
    const tool = tools.find(
      (candidate) => candidate.name === "unicli_contract_write_delete",
    );

    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("deferred tools derive safety annotations from CommandContract", () => {
    const tools = buildDeferredTools();
    const tool = tools.find(
      (candidate) => candidate.name === "unicli_contract_write_delete",
    );

    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("deferred tool calls unwrap _args before invoking the kernel", async () => {
    const handler = buildHandler(buildDeferredTools());
    const response = await handler({
      jsonrpc: "2.0",
      id: 301,
      method: "tools/call",
      params: {
        name: "unicli_contract_write_delete",
        arguments: { _args: {} },
      },
    });

    expect(response?.error).toBeUndefined();
    const result = response?.result as {
      structuredContent?: { data?: { count?: number } };
      isError?: boolean;
    };
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.data?.count).toBe(1);
  });

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
