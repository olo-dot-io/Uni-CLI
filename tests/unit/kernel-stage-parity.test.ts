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
import { runResolvedCommand } from "../../src/mcp/dispatch.js";
import { OperationOutcomeAmbiguousError } from "../../src/transport/contained-process.js";

let sendImplementation: () => Promise<unknown>;
let registeredAdapter: AdapterManifest;

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
        func: async () => sendImplementation(),
      },
    },
  };
}

beforeEach(() => {
  _resetCompiledCacheForTests();
  sendImplementation = async () => [{ sent: true }];
  registeredAdapter = stageAdapter();
  registerAdapter(registeredAdapter);
  compileAll([registeredAdapter]);
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

  it("keeps a mutating function command fulfillment authoritative over late cancellation", async () => {
    const controller = new AbortController();
    let effects = 0;
    sendImplementation = async () => {
      effects += 1;
      controller.abort(
        new DOMException("late client cancellation", "AbortError"),
      );
      return [{ sent: true }];
    };
    const inv = buildInvocation(
      "mcp",
      "kernel-stage-fixture",
      "send",
      { args: { text: "hello" }, source: "mcp" },
      { signal: controller.signal },
    )!;

    const result = await execute(inv);

    expect(result.error).toBeUndefined();
    expect(result.results).toEqual([{ sent: true }]);
    expect(effects).toBe(1);
  });

  it("turns a mutation failure sentinel into a top-level non-zero error", async () => {
    sendImplementation = async () => [
      { status: "failed", message: "Submit button not found" },
    ];
    const inv = buildInvocation("cli", "kernel-stage-fixture", "send", {
      args: { text: "hello" },
      source: "shell",
    })!;

    const result = await execute(inv);

    expect(result.exitCode).not.toBe(0);
    expect(result.results).toEqual([]);
    expect(result.error).toMatchObject({
      code: "provider_reported_failure",
      message: "Submit button not found",
      retryable: false,
    });
    expect(result.effectVerdict.status).not.toBe("confirmed");
  });

  it("preserves bounded receipts when only part of a mutation batch fails", async () => {
    sendImplementation = async () => [
      { ok: true, id: "sent-1" },
      { ok: false, id: "failed-2", reason: "recipient rejected" },
    ];
    const inv = buildInvocation("cli", "kernel-stage-fixture", "send", {
      args: { text: "hello" },
      source: "shell",
    })!;

    const result = await execute(inv);

    expect(result.exitCode).not.toBe(0);
    expect(result.error).toMatchObject({
      code: "partial_mutation",
      retryable: false,
      partial_success: true,
      mutation_receipts: {
        successful_count: 1,
        failed_count: 1,
        truncated: false,
        successful: [{ ok: true, id: "sent-1" }],
        failed: [{ ok: false, id: "failed-2", reason: "recipient rejected" }],
      },
    });
    expect(result.effectVerdict).toMatchObject({
      status: "unverifiable",
      evidence: "dispatch_receipt",
    });
  });

  it("preserves structural outcome ambiguity through the MCP envelope", async () => {
    sendImplementation = async () => {
      throw new OperationOutcomeAmbiguousError(
        "fixture send",
        new DOMException("client cancelled", "AbortError"),
      );
    };
    const command = registeredAdapter.commands.send!;

    const result = await runResolvedCommand(registeredAdapter, command, {
      cmdName: "send",
      args: { text: "hello" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.data).toMatchObject({
      code: "operation_outcome_ambiguous",
      outcome_ambiguous: true,
      operation: "fixture send",
      retryable: false,
    });
  });
});
