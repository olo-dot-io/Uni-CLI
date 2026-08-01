import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildHandler } from "../../../src/mcp/handler.js";
import { buildDefaultTools } from "../../../src/mcp/tools.js";

const originalPath = process.env.PATH;
const originalRulesPath = process.env.UNICLI_PERMISSION_RULES_PATH;
const temporaryDirectories: string[] = [];

function writeUnicliShim(
  directory: string,
  markerPath: string,
  observation: "arguments" | "logging-env",
): void {
  const windows = process.platform === "win32";
  const shimPath = join(directory, windows ? "unicli.cmd" : "unicli");
  const marker = JSON.stringify(markerPath);
  const observed =
    observation === "arguments"
      ? windows
        ? "%*"
        : "$*"
      : windows
        ? "%UNICLI_NO_LOG%,%UNICLI_NO_LEDGER%"
        : "$UNICLI_NO_LOG,$UNICLI_NO_LEDGER";
  // REASON: the PATH shim observes the external subprocess boundary without replacing owned authorization or MCP modules.
  writeFileSync(
    shimPath,
    windows
      ? `@echo off\r\n> ${marker} echo ${observed}\r\necho {"shim":true}\r\n`
      : `#!/bin/sh\nprintf '%s\\n' "${observed}" > ${marker}\nprintf '{"shim":true}\\n'\n`,
  );
  if (!windows) chmodSync(shimPath, 0o755);
}

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
    const policyPath = join(directory, "permission-rules.json");

    writeFileSync(
      policyPath,
      JSON.stringify({ schema_version: "2", default: "deny", rules: [] }),
    );
    writeUnicliShim(directory, markerPath, "arguments");
    process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
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

  it.skipIf(process.platform === "win32")(
    "disables both current and legacy child logging protocols",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "unicli-mcp-explore-env-"));
      temporaryDirectories.push(directory);
      const markerPath = join(directory, "child-env.txt");
      const policyPath = join(directory, "permission-rules.json");

      writeFileSync(
        policyPath,
        JSON.stringify({ schema_version: "2", default: "allow", rules: [] }),
      );
      writeUnicliShim(directory, markerPath, "logging-env");
      process.env.PATH = `${directory}${delimiter}${originalPath ?? ""}`;
      process.env.UNICLI_PERMISSION_RULES_PATH = policyPath;

      const handler = buildHandler(buildDefaultTools());
      const context = {
        transport: "mcp-stdio" as const,
        mcpSessionId: "logging-compatibility",
      };
      const created = await handler(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "unicli_explore",
            arguments: { url: "https://example.com" },
            task: {},
          },
        },
        context,
      );
      const taskId = (
        created?.result as { task?: { taskId?: unknown } } | undefined
      )?.task?.taskId;
      expect(taskId).toEqual(expect.any(String));
      await handler(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tasks/result",
          params: { taskId },
        },
        context,
      );

      expect(readFileSync(markerPath, "utf-8").trim()).toBe("1,1");
    },
  );
});
