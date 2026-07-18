/**
 * Tool-definition builder tests. Pins the contract that collision warnings
 * are emitted to stderr regardless of build mode (expanded vs deferred) —
 * silent `continue` was the P2 review gap.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDefaultTools,
  buildDeferredTools,
  buildExpandedTools,
  DEFAULT_TOOL_NAMES,
} from "../../../src/mcp/tools.js";
import { buildHandler } from "../../../src/mcp/handler.js";
import { registerAdapter } from "../../../src/registry.js";
import {
  loadAllAdapters,
  loadTsAdapters,
  primeKernelCache,
} from "../../../src/discovery/loader.js";
import { describe as describeUnicli } from "../../../src/commands/describe.js";
import { invalidateCache } from "../../../src/discovery/search.js";
import { AdapterType } from "../../../src/types.js";
import type { AdapterManifest } from "../../../src/types.js";

const originalRulesPath = process.env.UNICLI_PERMISSION_RULES_PATH;

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
  category: "dev",
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

beforeAll(async () => {
  loadAllAdapters();
  await loadTsAdapters();
  registerAdapter(ADAPTER_A);
  registerAdapter(ADAPTER_B);
  registerAdapter(ADAPTER_C);
  primeKernelCache();
  invalidateCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalRulesPath === undefined) {
    delete process.env.UNICLI_PERMISSION_RULES_PATH;
  } else {
    process.env.UNICLI_PERMISSION_RULES_PATH = originalRulesPath;
  }
});

describe("deterministic tool ordering", () => {
  // MCP 2026-07-28 requires tools/list to be deterministically ordered so
  // clients can prompt-cache it. Adapter tools must be sorted by
  // (site, command) regardless of registry load order.
  it("buildDeferredTools lists adapter tools sorted by tool name", () => {
    const adapterTools = buildDeferredTools()
      .map((tool) => tool.name)
      .filter((name) => !DEFAULT_TOOL_NAMES.has(name));
    const sorted = [...adapterTools].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    expect(adapterTools.length).toBeGreaterThan(0);
    expect(adapterTools).toEqual(sorted);
  });
});

describe("DEFAULT_TOOL_NAMES registry", () => {
  it("buildDefaultTools stays in lock-step with DEFAULT_TOOL_NAMES", () => {
    const names = buildDefaultTools().map((t) => t.name);
    for (const n of names) {
      expect(DEFAULT_TOOL_NAMES.has(n)).toBe(true);
    }
  });

  it("unicli_list exposes category filtering in the MCP schema", () => {
    const listTool = buildDefaultTools().find(
      (candidate) => candidate.name === "unicli_list",
    );

    expect(listTool?.inputSchema.properties).toHaveProperty("category");
    expect(listTool?.description).toContain("category");
  });

  it("unicli_search exposes category filtering in the MCP schema", () => {
    const searchTool = buildDefaultTools().find(
      (candidate) => candidate.name === "unicli_search",
    );

    expect(searchTool?.inputSchema.properties).toHaveProperty("category");
    expect(searchTool?.description).toContain("category");
  });

  it("unicli_list filters and returns adapter categories", async () => {
    const handler = buildHandler(buildDefaultTools());

    const response = await handler({
      jsonrpc: "2.0",
      id: 301,
      method: "tools/call",
      params: {
        name: "unicli_list",
        arguments: { category: "dev" },
      },
    });

    const payload = response?.result as {
      structuredContent?: {
        data?: {
          adapters?: Array<{ site: string; category: string }>;
        };
      };
    };
    const adapters = payload.structuredContent?.data?.adapters ?? [];
    expect(adapters.length).toBeGreaterThan(0);
    expect(adapters.every((adapter) => adapter.category === "dev")).toBe(true);
    expect(adapters.some((adapter) => adapter.site === "contract-write")).toBe(
      true,
    );
  });

  it("unicli_list exposes core compute commands alongside adapters", async () => {
    const handler = buildHandler(buildDefaultTools());

    const response = await handler({
      jsonrpc: "2.0",
      id: 303,
      method: "tools/call",
      params: {
        name: "unicli_list",
        arguments: { site: "compute" },
      },
    });

    const payload = response?.result as {
      structuredContent?: {
        data?: {
          adapters?: Array<{
            site: string;
            category: string;
            type: string;
            commands: Array<{
              name: string;
              source_kind: "adapter" | "core";
              mcp_run_supported: boolean;
              invocation: string;
            }>;
          }>;
        };
      };
    };
    const adapters = payload.structuredContent?.data?.adapters ?? [];
    expect(adapters).toEqual([
      expect.objectContaining({
        site: "compute",
        category: "desktop",
        type: "desktop",
        commands: expect.arrayContaining([
          expect.objectContaining({
            name: "capture",
            source_kind: "core",
            mcp_run_supported: false,
            invocation: "unicli compute capture",
          }),
          expect.objectContaining({
            name: "snapshot",
            source_kind: "core",
            mcp_run_supported: false,
            invocation: "unicli compute snapshot",
          }),
        ]),
      }),
    ]);
  });

  it("unicli_run returns an explicit native-CLI route for fixed core commands", async () => {
    const handler = buildHandler(buildDefaultTools());

    const created = await handler({
      jsonrpc: "2.0",
      id: 304,
      method: "tools/call",
      params: {
        name: "unicli_run",
        arguments: { site: "architecture", command: "audit" },
        task: { ttl: 60_000 },
      },
    });
    const taskId = (
      created?.result as { task?: { taskId?: string } } | undefined
    )?.task?.taskId;
    expect(taskId).toEqual(expect.any(String));
    const response = await handler({
      jsonrpc: "2.0",
      id: 305,
      method: "tasks/result",
      params: { taskId },
    });

    const payload = response?.result as {
      isError?: boolean;
      structuredContent?: {
        data?: {
          code?: string;
          source_kind?: string;
          mcp_run_supported?: boolean;
          invocation?: string;
        };
      };
    };
    expect(payload.isError).toBe(true);
    expect(payload.structuredContent?.data).toEqual(
      expect.objectContaining({
        code: "unsupported_surface",
        source_kind: "core",
        mcp_run_supported: false,
        invocation: "unicli architecture audit",
      }),
    );
  });

  it("unicli_search hard-filters results by category", async () => {
    const handler = buildHandler(buildDefaultTools());

    const response = await handler({
      jsonrpc: "2.0",
      id: 302,
      method: "tools/call",
      params: {
        name: "unicli_search",
        arguments: {
          query: "open access pdf doi",
          category: "scholarly",
          limit: 8,
        },
      },
    });

    const payload = response?.result as {
      structuredContent?: {
        data?: {
          results?: Array<{ site: string; category: string }>;
        };
      };
    };
    const results = payload.structuredContent?.data?.results ?? [];
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.category === "scholarly")).toBe(
      true,
    );
    expect(results.map((result) => result.site)).toContain("unpaywall");
  });
});

describe("computer-use profile", () => {
  it("enforces default-deny policy before direct MCP computer dispatch", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "unicli-compute-mcp-policy-"));
    try {
      const path = join(tmp, "policy.json");
      writeFileSync(
        path,
        JSON.stringify({
          schema_version: "2",
          default: "deny",
          rules: [],
        }),
        "utf-8",
      );
      process.env.UNICLI_PERMISSION_RULES_PATH = path;
      const toolsModule = await import("../../../src/mcp/tools.js");
      const click = toolsModule
        .selectTools("computer-use")
        .find((tool) => tool.name === "computer-use.click");

      const result = await click?.handler?.({
        ref: "olo:accessibility:foreign",
      });

      expect(result?.isError).toBe(true);
      expect(result?.structuredContent?.data).toMatchObject({
        action: "compute_click.authorize",
        minimum_capability: "permission.denied",
        exit_code: 77,
        reason: expect.stringContaining("policy-default-deny"),
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("selectTools returns the desktop and bounded Chrome computer-use tools", async () => {
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
      "computer-use.capture",
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
      "computer-use.browser_tabs",
      "computer-use.browser_prepare",
      "computer-use.browser_state",
      "computer-use.browser_screenshot",
      "computer-use.browser_navigate",
      "computer-use.browser_click",
      "computer-use.browser_type",
      "computer-use.browser_press",
      "computer-use.browser_scroll",
      "computer-use.browser_search",
      "computer-use.browser_claim",
      "computer-use.browser_dialogs",
      "computer-use.browser_dialog",
      "computer-use.browser_downloads",
      "computer-use.browser_presence",
      "computer-use.browser_cursor",
    ]);
    const capture = tools.find(
      (candidate) => candidate.name === "computer-use.capture",
    );
    expect(capture?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
    });
    expect(capture?.inputSchema.properties).toMatchObject({
      app: { type: "string" },
      include: { type: "string", default: "snapshot,screenshot" },
      format: {
        type: "string",
        enum: ["compact", "tree", "json"],
        default: "compact",
      },
      saveReference: { type: "boolean", default: false },
      copyReference: { type: "boolean", default: false },
      referenceRoot: { type: "string" },
    });
    const browserState = tools.find(
      (candidate) => candidate.name === "computer-use.browser_state",
    );
    expect(browserState).toMatchObject({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      execution: { taskSupport: "optional" },
    });
    expect(browserState?.inputSchema.properties).not.toHaveProperty(
      "allow_launch",
    );
    for (const name of [
      "computer-use.click",
      "computer-use.type",
      "computer-use.press",
      "computer-use.scroll",
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.properties?.focus).toMatchObject({
        type: "boolean",
        default: false,
      });
    }
    for (const name of [
      "computer-use.click",
      "computer-use.type",
      "computer-use.scroll",
    ]) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.properties).toHaveProperty("overlay", {
        type: "boolean",
        default: false,
        description:
          "Render the system-level virtual cursor HUD for this action.",
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
    expect(prompts[0]?.text).toContain("app-shot references");
    expect(prompts[0]?.text).toContain("re-snapshot after actions");
    expect(prompts[0]?.text).toContain("browser_search");
    expect(prompts[0]?.text).toContain("--browser-visibility foreground");
  });

  it("keeps shared compute action schemas in parity with core describe", async () => {
    const toolsModule = await import("../../../src/mcp/tools.js");
    const selectTools = (
      toolsModule as unknown as {
        selectTools?: (profile: string) => Array<{
          name: string;
          inputSchema: {
            properties?: Record<string, unknown>;
            required?: string[];
          };
        }>;
      }
    ).selectTools;
    expect(typeof selectTools).toBe("function");
    const tools = selectTools!("computer-use");

    for (const [command, toolName] of [
      ["apps", "computer-use.apps"],
      ["windows", "computer-use.windows"],
      ["capture", "computer-use.capture"],
      ["snapshot", "computer-use.snapshot"],
      ["find", "computer-use.find"],
      ["click", "computer-use.click"],
      ["type", "computer-use.type"],
      ["press", "computer-use.press"],
      ["scroll", "computer-use.scroll"],
      ["launch", "computer-use.launch"],
      ["screenshot", "computer-use.screenshot"],
      ["attach", "computer-use.attach"],
      ["eval", "computer-use.evaluate"],
      ["wait", "computer-use.wait"],
      ["observe", "computer-use.observe"],
      ["assert", "computer-use.assert"],
    ] as const) {
      const corePayload = describeUnicli("compute", command).payload as {
        args_schema: {
          properties: Record<string, unknown>;
          required: string[];
        };
      };
      const tool = tools.find((candidate) => candidate.name === toolName);
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.properties).toEqual(
        corePayload.args_schema.properties,
      );
      expect(tool?.inputSchema.required ?? []).toEqual(
        corePayload.args_schema.required,
      );
    }
  });

  it("computer-use.capture rejects invalid format at the MCP boundary", async () => {
    const toolsModule = await import("../../../src/mcp/tools.js");
    const tools = toolsModule.selectTools("computer-use");
    const capture = tools.find((tool) => tool.name === "computer-use.capture");

    const result = await capture?.handler?.({ format: "text" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.data).toMatchObject({
      minimum_capability: "compute.capture",
      exit_code: 2,
      reason: "invalid snapshot format: text",
    });
    expect(result?._meta?.evidence).toMatchObject({
      evidence_type: "computer-use-action",
      tool: "computer-use.capture",
      action: "compute_capture",
      ok: false,
      visual_timeline: {
        schema_version: 1,
        replayable: true,
        events: [
          expect.objectContaining({ state: "observe" }),
          expect.objectContaining({ state: "error" }),
        ],
      },
    });
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
      visual_timeline: {
        schema_version: 1,
        replayable: true,
        subject: { tool: "computer-use.find" },
        events: [
          expect.objectContaining({ state: "observe" }),
          expect.objectContaining({
            state: "error",
            transport: "visual",
          }),
        ],
      },
      visual_action: {
        schema_version: 2,
        tool: "computer-use.find",
        action: "compute_find",
        dispatch: {
          status: "failed",
          transport: "visual",
        },
        overlay: {
          provider: "none",
          status: "not_requested",
        },
      },
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
    const created = await handler({
      jsonrpc: "2.0",
      id: 301,
      method: "tools/call",
      params: {
        name: "unicli_contract_write_delete",
        arguments: { _args: {} },
        task: {},
      },
    });

    expect(created?.error).toBeUndefined();
    const taskId = (
      created?.result as { task?: { taskId?: string } } | undefined
    )?.task?.taskId;
    expect(taskId).toEqual(expect.any(String));
    const response = await handler({
      jsonrpc: "2.0",
      id: 302,
      method: "tasks/result",
      params: { taskId },
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
