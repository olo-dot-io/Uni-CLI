import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { runResolvedCommand } from "../../src/mcp/dispatch.js";
import { runCommand } from "../../src/protocol/acp-helpers.js";
import {
  compileAll,
  _resetCompiledCacheForTests,
} from "../../src/engine/invoke.js";
import { registerAdapter } from "../../src/registry.js";
import { AdapterType, type AdapterManifest } from "../../src/types.js";

const fixture: AdapterManifest = {
  name: "permission-surfaces",
  type: AdapterType.WEB_API,
  commands: {
    send: {
      name: "send",
      description: "Send a message",
      adapterArgs: [{ name: "text", type: "str", required: true }],
      func: async () => ({ sent: true }),
    },
  },
};

const originalProfile = process.env.UNICLI_PERMISSION_PROFILE;
const originalApprove = process.env.UNICLI_APPROVE;

describe("permission enforcement across protocol surfaces", () => {
  beforeEach(() => {
    _resetCompiledCacheForTests();
    registerAdapter(fixture);
    compileAll([fixture]);
    process.env.UNICLI_PERMISSION_PROFILE = "locked";
    delete process.env.UNICLI_APPROVE;
  });

  afterEach(() => {
    if (originalProfile === undefined) {
      delete process.env.UNICLI_PERMISSION_PROFILE;
    } else {
      process.env.UNICLI_PERMISSION_PROFILE = originalProfile;
    }
    if (originalApprove === undefined) {
      delete process.env.UNICLI_APPROVE;
    } else {
      process.env.UNICLI_APPROVE = originalApprove;
    }
  });

  it("blocks matching MCP tool calls before execution", async () => {
    const result = await runResolvedCommand(
      fixture,
      fixture.commands.send,
      "send",
      { text: "hello" },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.data).toMatchObject({
      code: "permission_denied",
      adapter_path: "src/adapters/permission-surfaces/send.yaml",
    });
  });

  it("blocks matching ACP command execution before execution", async () => {
    await expect(
      runCommand(fixture, fixture.commands.send, { text: "hello" }),
    ).rejects.toThrow(/requires approval/);
  });
});
