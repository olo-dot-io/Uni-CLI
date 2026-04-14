import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { runPipeline } from "../../src/engine/yaml-runner.js";

// write_temp is written on every platform, but the assertions here shell out
// to `cat` and `echo`, which are not on a default Windows runner PATH.
// Skip on win32 — the write_temp logic in src/engine/yaml-runner.ts is
// exercised by cross-platform tests in loader.test.ts and eval.test.ts.
const skipOnWindows = process.platform === "win32";

describe.skipIf(skipOnWindows)("write_temp step", () => {
  it("writes template-resolved content to temp file", async () => {
    const steps = [
      {
        write_temp: {
          filename: "script.py",
          content: 'print("Hello ${{ args.name }}")',
        },
      },
      {
        exec: {
          command: "cat",
          args: ["${{ temp.script_py }}"],
          parse: "text",
        },
      },
    ];

    const result = await runPipeline(steps, { name: "World" });
    expect(result[0]).toBe('print("Hello World")');
  });

  it("creates unique temp directory per run", async () => {
    const steps = [
      {
        write_temp: {
          filename: "test.txt",
          content: "content",
        },
      },
      {
        exec: {
          command: "echo",
          args: ["${{ temp.test_txt }}"],
          parse: "text",
        },
      },
    ];

    const result1 = await runPipeline(steps, {});
    const tempPath1 = (result1[0] as string).trim();

    const result2 = await runPipeline(steps, {});
    const tempPath2 = (result2[0] as string).trim();

    expect(tempPath1).not.toBe(tempPath2);
  });

  it("cleans up temp files after pipeline completes", async () => {
    const steps = [
      {
        write_temp: {
          filename: "cleanup-test.txt",
          content: "temp content",
        },
      },
      {
        exec: {
          command: "echo",
          args: ["${{ temp.cleanup_test_txt }}"],
          parse: "text",
        },
      },
    ];

    const result = await runPipeline(steps, {});
    const capturedPath = (result[0] as string).trim();

    // After pipeline completes, temp file should be cleaned up
    expect(existsSync(capturedPath)).toBe(false);
  });

  it("sanitizes filename to valid temp key", async () => {
    const steps = [
      {
        write_temp: {
          filename: "my-script.config.scm",
          content: "test",
        },
      },
      {
        exec: {
          command: "cat",
          args: ["${{ temp.my_script_config_scm }}"],
          parse: "text",
        },
      },
    ];

    const result = await runPipeline(steps, {});
    expect(result[0]).toBe("test");
  });
});
