/**
 * ACP hardening parity — v0.213.3 R2 G1.
 *
 * Before R2 the ACP `runCommand` bypassed `hardenArgs`. R2 routes it
 * through the invocation kernel; this test pins the contract by calling
 * the exported `runCommand` helper with a malicious path and asserting
 * the error carries the hardening suggestion.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runCommand } from "../../../src/protocol/acp.js";
import { registerAdapter, resolveCommand } from "../../../src/registry.js";
import { primeKernelCache } from "../../../src/discovery/loader.js";
import { AdapterType } from "../../../src/types.js";
import type { AdapterManifest } from "../../../src/types.js";

const FIXTURE: AdapterManifest = {
  name: "acp-parity-fixture",
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

describe("ACP hardening parity — path traversal", () => {
  it("rejects an absolute /etc/passwd with a suggestion-bearing error", async () => {
    const resolved = resolveCommand("acp-parity-fixture", "dump");
    expect(resolved).toBeDefined();
    try {
      await runCommand(resolved!.adapter, resolved!.command, {
        output: "/etc/passwd",
      });
      throw new Error("expected runCommand to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const suggestion = (err as Error & { suggestion?: string }).suggestion;
      expect(typeof suggestion).toBe("string");
      expect(String(suggestion ?? "")).not.toBe("");
      expect((err as Error).message).toMatch(/path|escape|traversal|outside/i);
    }
  });

  it("accepts a safe relative path inside CWD", async () => {
    const resolved = resolveCommand("acp-parity-fixture", "dump");
    const results = await runCommand(resolved!.adapter, resolved!.command, {
      output: "./safe-output.json",
    });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(1);
  });
});
