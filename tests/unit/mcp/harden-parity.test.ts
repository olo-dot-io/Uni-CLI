/**
 * MCP hardening parity — v0.213.3 R2 G1.
 *
 * Before R2 the MCP `runResolvedCommand` bypassed `hardenArgs` entirely,
 * so an agent could submit `output: "../../etc/passwd"` and reach the
 * adapter. R2 routes every surface through the invocation kernel; this
 * test pins the contract by dispatching a malicious path via the MCP
 * bridge and asserting the structured error shape.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runResolvedCommand } from "../../../src/mcp/dispatch.js";
import { registerAdapter, resolveCommand } from "../../../src/registry.js";
import { primeKernelCache } from "../../../src/discovery/loader.js";
import { AdapterType } from "../../../src/types.js";
import type { AdapterManifest } from "../../../src/types.js";

const FIXTURE: AdapterManifest = {
  name: "parity-fixture",
  type: AdapterType.WEB_API,
  strategy: "public",
  commands: {
    dump: {
      name: "dump",
      description: "write result to a path — hardening test fixture",
      adapterArgs: [
        {
          name: "output",
          type: "str",
          required: true,
          "x-unicli-kind": "path",
        },
      ],
      func: async () => ({ ok: true }),
    },
  },
};

beforeAll(() => {
  registerAdapter(FIXTURE);
  primeKernelCache();
});

describe("MCP hardening parity — path traversal", () => {
  it("rejects an absolute /etc/passwd with isError + suggestion", async () => {
    const resolved = resolveCommand("parity-fixture", "dump");
    expect(resolved).toBeDefined();
    const result = await runResolvedCommand(
      resolved!.adapter,
      resolved!.command,
      "dump",
      { output: "/etc/passwd" },
    );
    expect(result.isError).toBe(true);
    const data = result.structuredContent?.data as Record<string, unknown>;
    expect(data).toBeDefined();
    expect(String(data.suggestion ?? "")).not.toBe("");
    expect(String(data.error ?? "")).toMatch(/path|escape|traversal|outside/i);
  });

  it("accepts a safe relative path inside CWD", async () => {
    const resolved = resolveCommand("parity-fixture", "dump");
    const result = await runResolvedCommand(
      resolved!.adapter,
      resolved!.command,
      "dump",
      { output: "./safe-output.json" },
    );
    expect(result.isError).toBeUndefined();
    const data = result.structuredContent?.data as Record<string, unknown>;
    expect(data.count).toBe(1);
  });

  it("flattens control-char injection into a structured error", async () => {
    const resolved = resolveCommand("parity-fixture", "dump");
    const result = await runResolvedCommand(
      resolved!.adapter,
      resolved!.command,
      "dump",
      { output: "foo\x00bar" },
    );
    expect(result.isError).toBe(true);
    const data = result.structuredContent?.data as Record<string, unknown>;
    expect(String(data.suggestion ?? "")).not.toBe("");
  });
});
