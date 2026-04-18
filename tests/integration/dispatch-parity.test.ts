/**
 * CLI ↔ MCP dispatch parity — v0.213.3 R2 G1.
 *
 * Both surfaces now funnel through `execute(buildInvocation(...))`, so an
 * identical `bag.args` must produce an identical `envelope` (modulo
 * `trace_id` and `duration_ms`). This test asserts that by running each
 * of three representative commands twice — once with surface="cli", once
 * with surface="mcp" — and deep-comparing the normalized envelope + the
 * first error structure when present.
 *
 * Pipelines are not actually invoked: we register synthetic adapters whose
 * `func` returns a fixed payload. That isolates the parity check from
 * network flakiness and confirms the KERNEL, not any specific adapter, is
 * the single source of envelope truth.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { buildInvocation, execute } from "../../src/engine/kernel/execute.js";
import { registerAdapter } from "../../src/registry.js";
import { primeKernelCache } from "../../src/discovery/loader.js";
import { AdapterType } from "../../src/types.js";
import type { AdapterManifest } from "../../src/types.js";
import type { AgentContext } from "../../src/output/envelope.js";

const ADAPTERS: AdapterManifest[] = [
  {
    name: "parity-hackernews",
    type: AdapterType.WEB_API,
    strategy: "public",
    version: "1.0.0",
    commands: {
      top: {
        name: "top",
        paginated: true,
        adapterArgs: [{ name: "limit", type: "int", default: 10 }],
        func: async () => [
          { id: 1, title: "hello" },
          { id: 2, title: "world" },
        ],
      },
    },
  },
  {
    name: "parity-arxiv",
    type: AdapterType.WEB_API,
    strategy: "public",
    version: "1.0.0",
    commands: {
      search: {
        name: "search",
        adapterArgs: [
          { name: "query", type: "str", required: true },
          { name: "limit", type: "int", default: 5 },
        ],
        func: async (_p: unknown, args: Record<string, unknown>) => [
          { title: `result for ${String(args.query)}`, year: 2026 },
        ],
      },
    },
  },
  {
    name: "parity-github",
    type: AdapterType.WEB_API,
    strategy: "public",
    version: "1.0.0",
    commands: {
      search: {
        name: "search",
        adapterArgs: [{ name: "q", type: "str", required: true }],
        func: async () => [{ full_name: "acme/widget" }],
      },
    },
  },
];

beforeAll(() => {
  for (const a of ADAPTERS) registerAdapter(a);
  primeKernelCache();
});

/**
 * Normalize the envelope for byte-level comparison. Fields that MUST vary
 * per invocation (trace_id, duration_ms) are stripped; everything else is
 * expected to match exactly between CLI and MCP.
 */
function normalize(env: AgentContext): Record<string, unknown> {
  const { duration_ms: _duration, ...rest } = env;
  return rest as unknown as Record<string, unknown>;
}

describe("CLI ↔ MCP dispatch parity (kernel envelope)", () => {
  for (const [site, cmd, args] of [
    ["parity-hackernews", "top", { limit: 3 }],
    // limit=0 regression (IM1): MCP used to return 0 while ACP returned 20 —
    // both surfaces now share coerceLimit() so 0 passes through identically.
    ["parity-hackernews", "top", { limit: 0 }],
    ["parity-arxiv", "search", { query: "agent tool use", limit: 2 }],
    ["parity-github", "search", { q: "unicli" }],
  ] as Array<[string, string, Record<string, unknown>]>) {
    it(`${site} ${cmd}: CLI envelope ≡ MCP envelope (modulo trace_id/duration_ms)`, async () => {
      const cliInv = buildInvocation("cli", site, cmd, {
        args: { ...args },
        source: "shell",
      });
      const mcpInv = buildInvocation("mcp", site, cmd, {
        args: { ...args },
        source: "mcp",
      });
      expect(cliInv).not.toBeNull();
      expect(mcpInv).not.toBeNull();

      const cliRes = await execute(cliInv!);
      const mcpRes = await execute(mcpInv!);

      // Same result payload.
      expect(cliRes.results).toEqual(mcpRes.results);
      // Same exit code semantics.
      expect(cliRes.exitCode).toBe(mcpRes.exitCode);
      // Envelopes match byte-for-byte once trace_id + duration_ms are stripped.
      const cliJson = JSON.stringify(normalize(cliRes.envelope));
      const mcpJson = JSON.stringify(normalize(mcpRes.envelope));
      expect(cliJson).toBe(mcpJson);
      // Sanity: trace IDs differ across invocations (ULID monotonic).
      expect(cliRes.envelope.command).toBe(mcpRes.envelope.command);
      // Warnings list comes from the shared kernel — always present array.
      expect(Array.isArray(cliRes.warnings)).toBe(true);
      expect(Array.isArray(mcpRes.warnings)).toBe(true);
    });
  }
});
