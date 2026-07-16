import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildHandler } from "../../../src/mcp/handler.js";
import { buildDefaultTools } from "../../../src/mcp/tools.js";

const originalPath = process.env.PATH;
const originalRulesPath = process.env.UNICLI_PERMISSION_RULES_PATH;
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalRulesPath === undefined) {
    delete process.env.UNICLI_PERMISSION_RULES_PATH;
  } else {
    process.env.UNICLI_PERMISSION_RULES_PATH = originalRulesPath;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("MCP explore authorization", () => {
  it("does not spawn adapter generation when policy defaults to deny", async () => {
    const directory = mkdtempSync(join(tmpdir(), "unicli-mcp-explore-policy-"));
    temporaryDirectories.push(directory);
    const markerPath = join(directory, "spawned.txt");
    const shimPath = join(directory, "unicli");
    const policyPath = join(directory, "permission-rules.json");

    writeFileSync(
      policyPath,
      JSON.stringify({ schema_version: "2", default: "deny", rules: [] }),
    );
    // REASON: the PATH shim observes the external subprocess boundary without replacing owned authorization or MCP modules.
    writeFileSync(
      shimPath,
      `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(markerPath)}\nprintf '{"shim":true}\\n'\n`,
    );
    chmodSync(shimPath, 0o755);
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    process.env.UNICLI_PERMISSION_RULES_PATH = policyPath;

    const handler = buildHandler(buildDefaultTools());
    const context = {
      transport: "mcp-stdio" as const,
      mcpSessionId: "policy-regression",
    };
    const created = await handler(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "unicli_explore",
          arguments: { url: "https://example.com", goal: "proof" },
          task: {},
        },
      },
      context,
    );
    const taskId = (
      created?.result as { task?: { taskId?: unknown } } | undefined
    )?.task?.taskId;
    expect(taskId).toEqual(expect.any(String));
    const response = await handler(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/result",
        params: { taskId },
      },
      context,
    );

    expect(existsSync(markerPath)).toBe(false);
    expect(response?.result).toMatchObject({
      isError: true,
      structuredContent: {
        data: {
          code: "permission_denied",
          error: expect.stringContaining("policy-default-deny"),
        },
      },
    });
  });
});
