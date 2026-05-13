import { describe, expect, it, beforeEach } from "vitest";

import {
  buildInvocation,
  compileAll,
  execute,
  _resetCompiledCacheForTests,
} from "../../src/engine/invoke.js";
import {
  KERNEL_STAGE_ORDER,
  authorizeKernelInvocation,
  hardenKernelInput,
  resolveKernelCommandContext,
  validateKernelInput,
} from "../../src/engine/kernel/stages.js";
import { AdapterType, type AdapterManifest } from "../../src/types.js";
import { registerAdapter } from "../../src/registry.js";

function stageAdapter(): AdapterManifest {
  return {
    name: "kernel-stage-fixture",
    type: AdapterType.WEB_API,
    domain: "stage.example.com",
    commands: {
      read: {
        name: "read",
        description: "Read records",
        adapter_path: "src/adapters/kernel-stage-fixture/read.yaml",
        adapterArgs: [{ name: "query", type: "str", required: true }],
        func: async (_page, kwargs) => [{ query: kwargs.query }],
      },
      shell: {
        name: "shell",
        description: "Read shell-safe token",
        adapter_path: "src/adapters/kernel-stage-fixture/shell.yaml",
        adapterArgs: [
          {
            name: "token",
            type: "str",
            required: true,
            "x-unicli-kind": "shell-safe",
          },
        ],
        func: async (_page, kwargs) => [{ token: kwargs.token }],
      },
      send: {
        name: "send",
        description: "Send a message",
        adapter_path: "src/adapters/kernel-stage-fixture/send.yaml",
        adapterArgs: [{ name: "text", type: "str", required: true }],
        func: async () => [{ sent: true }],
      },
    },
  };
}

beforeEach(() => {
  _resetCompiledCacheForTests();
  const adapter = stageAdapter();
  registerAdapter(adapter);
  compileAll([adapter]);
});

describe("kernel stage parity", () => {
  it("publishes the explicit kernel stage order", () => {
    expect(KERNEL_STAGE_ORDER).toEqual([
      "compile",
      "validate",
      "harden",
      "authorize",
      "execute",
      "observe",
      "envelope",
      "repair-diagnostics",
    ]);
  });

  it("validate stage returns the same invalid-input error as execute", async () => {
    const inv = buildInvocation("cli", "kernel-stage-fixture", "read", {
      args: {},
      source: "shell",
    })!;
    const ctx = resolveKernelCommandContext(inv);
    const stage = validateKernelInput(inv, ctx, Date.now(), []);
    const result = await execute(inv);

    expect(stage?.stage).toBe("validate");
    expect(stage?.result.error).toEqual(result.error);
    expect(stage?.result.exitCode).toBe(result.exitCode);
    expect(stage?.result.envelope.error).toEqual(result.envelope.error);
  });

  it("harden stage returns the same hardening error as execute", async () => {
    const inv = buildInvocation("cli", "kernel-stage-fixture", "shell", {
      args: { token: "rm -rf $HOME" },
      source: "shell",
    })!;
    const ctx = resolveKernelCommandContext(inv);
    expect(validateKernelInput(inv, ctx, Date.now(), [])).toBeUndefined();

    const stage = hardenKernelInput(inv, ctx, Date.now(), []);
    const result = await execute(inv);

    expect(stage?.stage).toBe("harden");
    expect(stage?.result.error).toEqual(result.error);
    expect(stage?.result.exitCode).toBe(result.exitCode);
    expect(stage?.result.envelope.error).toEqual(result.envelope.error);
  });

  it("authorize stage returns the same permission error as execute", async () => {
    const inv = buildInvocation(
      "cli",
      "kernel-stage-fixture",
      "send",
      {
        args: { text: "hello" },
        source: "shell",
      },
      { permissionProfile: "locked" },
    )!;
    const ctx = resolveKernelCommandContext(inv);
    const stage = await authorizeKernelInvocation(inv, ctx, Date.now(), []);
    const result = await execute(inv);

    expect(stage.stage).toBe("authorize");
    if (stage.stage !== "authorize") throw new Error("unexpected stage");
    expect(stage.blocked?.result.error).toEqual(result.error);
    expect(stage.blocked?.result.exitCode).toBe(result.exitCode);
    expect(stage.blocked?.result.envelope.error).toEqual(result.envelope.error);
  });
});
