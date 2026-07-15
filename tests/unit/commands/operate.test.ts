import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Command } from "commander";

import { registerOperateCommands } from "../../../src/commands/operate.js";
import { InMemoryBrowserRuntimeHarness } from "../../helpers/in-memory-browser-runtime.js";

let runtime: InMemoryBrowserRuntimeHarness;
let previousRuntimeRoot: string | undefined;

beforeEach(async () => {
  previousRuntimeRoot = process.env.UNICLI_BROWSER_RUNTIME_DIR;
  runtime = new InMemoryBrowserRuntimeHarness();
  process.env.UNICLI_BROWSER_RUNTIME_DIR = runtime.runtimeRoot;
  process.exitCode = undefined;
  await runtime.start();
});

afterEach(async () => {
  await runtime.cleanup();
  if (previousRuntimeRoot === undefined) {
    delete process.env.UNICLI_BROWSER_RUNTIME_DIR;
  } else {
    process.env.UNICLI_BROWSER_RUNTIME_DIR = previousRuntimeRoot;
  }
  process.exitCode = undefined;
});

describe("unicli operate broker compatibility surface", () => {
  it("reuses the same hidden broker target across alias invocations", async () => {
    const opened = await runOperate([
      "operate",
      "--session",
      "operate-agent",
      "open",
      "https://example.com/path",
    ]);
    const state = await runOperate([
      "operate",
      "--session",
      "operate-agent",
      "state",
      "--compact",
    ]);

    expect(opened.error).toBeNull();
    expect(opened.data).toMatchObject({
      url: "https://example.com/path",
      title: "Example fixture",
    });
    expect(state.data).toEqual({
      url: "https://example.com/path",
      snapshot: "[1]<button>Continue</button>",
    });
    expect(runtime.provider.acquireCount).toBe(1);
    expect(runtime.provider.pages[0]?.visibility).toBe("hidden");
  });

  it("routes key chords through the broker page command surface", async () => {
    const result = await runOperate([
      "operate",
      "--session",
      "keys-agent",
      "keys",
      "Control+Enter",
    ]);

    expect(result).toMatchObject({
      data: { ok: true, key: "Control+Enter" },
    });
    expect(runtime.provider.pages[0]?.presses).toEqual([
      { key: "Enter", modifiers: ["control"] },
    ]);
  });

  it("validates upload refs before allocating a target", async () => {
    const result = await runOperate([
      "operate",
      "upload",
      "not-a-ref",
      join(process.cwd(), "fixtures", "upload.txt"),
    ]);

    expect(result.data).toBeNull();
    expect(result.error?.message).toContain("Invalid ref");
    expect(runtime.provider.acquireCount).toBe(0);
  });

  it("sends an allowed absolute upload path to the broker target", async () => {
    const uploadPath = join(process.cwd(), "fixtures", "upload.txt");
    const result = await runOperate([
      "operate",
      "--session",
      "upload-agent",
      "upload",
      "42",
      uploadPath,
    ]);

    expect(result).toMatchObject({
      data: { ok: true, ref: "42", path: uploadPath },
    });
    expect(runtime.provider.pages[0]?.uploads).toEqual([
      {
        selector: '[data-unicli-ref="42"]',
        files: [uploadPath],
      },
    ]);
  });

  it("normalizes provider network capture without a JavaScript fallback", async () => {
    await runOperate([
      "operate",
      "--session",
      "network-agent",
      "open",
      "https://example.com",
    ]);
    runtime.provider.pages[0]!.networkCaptureEntries = [
      {
        url: "https://example.com/api/data.js",
        method: "GET",
        status: 200,
        contentType: "text/javascript",
        size: 27,
        responseBody: '{"data":{"enabled":true}}',
      },
    ];

    const result = await runOperate([
      "operate",
      "--session",
      "network-agent",
      "network",
      "--raw",
    ]);

    expect(result.data).toEqual([
      expect.objectContaining({
        url: "https://example.com/api/data.js",
        method: "GET",
        status: 200,
        contentType: "text/javascript",
        bodySize: 27,
        body: '{"data":{"enabled":true}}',
      }),
    ]);
  });
});

async function runOperate(args: string[]): Promise<{
  data: unknown;
  error?: { code: string; message: string; retryable: boolean } | null;
  stdout: string;
  stderr: string;
}> {
  const program = new Command();
  program.exitOverride();
  program.option("-f, --format <format>", "output format");
  registerOperateCommands(program);
  let stdout = "";
  let stderr = "";
  const originalLog = console.log;
  const originalError = console.error;
  console.log = ((...values: unknown[]) => {
    stdout += `${values.map(String).join(" ")}\n`;
  }) as typeof console.log;
  console.error = ((...values: unknown[]) => {
    stderr += `${values.map(String).join(" ")}\n`;
  }) as typeof console.error;
  try {
    await program.parseAsync(["-f", "json", ...args], { from: "user" });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const envelope = JSON.parse((stdout || stderr).trim()) as {
    data: unknown;
    error?: { code: string; message: string; retryable: boolean } | null;
  };
  return { ...envelope, stdout, stderr };
}
