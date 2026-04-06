/**
 * Plugin system tests — step registry, manifest parsing, and scaffold.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerStep,
  getCustomStep,
  listCustomSteps,
  unregisterStep,
} from "../../src/plugin/step-registry.js";
import type { PluginPipelineContext } from "../../src/plugin/step-registry.js";
import { createPlugin, listManifestPlugins } from "../../src/plugin/loader.js";
import type { PluginManifest } from "../../src/plugin/loader.js";

// ---------------------------------------------------------------------------
// Step Registry
// ---------------------------------------------------------------------------
describe("step-registry", () => {
  const TEST_STEP = "__test_step__";

  afterEach(() => {
    unregisterStep(TEST_STEP);
  });

  it("registers and retrieves a custom step", () => {
    const handler = async (ctx: PluginPipelineContext) => ctx;
    registerStep(TEST_STEP, handler);
    expect(getCustomStep(TEST_STEP)).toBe(handler);
  });

  it("returns undefined for unregistered step", () => {
    expect(getCustomStep("nonexistent_step_xyz")).toBeUndefined();
  });

  it("lists registered steps", () => {
    registerStep(TEST_STEP, async (ctx) => ctx);
    expect(listCustomSteps()).toContain(TEST_STEP);
  });

  it("overwrites existing step with warning", () => {
    const first = async (ctx: PluginPipelineContext) => ctx;
    const second = async (ctx: PluginPipelineContext) => ({
      ...ctx,
      data: "overwritten",
    });
    registerStep(TEST_STEP, first);
    registerStep(TEST_STEP, second);
    expect(getCustomStep(TEST_STEP)).toBe(second);
  });

  it("unregisters a step", () => {
    registerStep(TEST_STEP, async (ctx) => ctx);
    expect(unregisterStep(TEST_STEP)).toBe(true);
    expect(getCustomStep(TEST_STEP)).toBeUndefined();
  });

  it("unregister returns false for missing step", () => {
    expect(unregisterStep("nonexistent")).toBe(false);
  });

  it("executes a custom step handler and transforms data", async () => {
    const handler = async (ctx: PluginPipelineContext, config: unknown) => {
      const cfg = config as { prefix: string };
      return { ...ctx, data: `${cfg.prefix}-${String(ctx.data)}` };
    };
    registerStep(TEST_STEP, handler);

    const step = getCustomStep(TEST_STEP)!;
    const result = await step(
      { data: "hello", args: {}, vars: {} },
      { prefix: "test" },
    );
    expect(result.data).toBe("test-hello");
  });
});

// ---------------------------------------------------------------------------
// Plugin Manifest & Scaffold
// ---------------------------------------------------------------------------
describe("plugin scaffold (createPlugin)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `unicli-test-plugin-${Date.now()}`);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates plugin directory with manifest", () => {
    const dir = createPlugin("my-test", tmpDir);
    expect(dir).toBe(tmpDir);
    expect(existsSync(join(dir, "unicli-plugin.json"))).toBe(true);
    expect(existsSync(join(dir, "adapters"))).toBe(true);
    expect(existsSync(join(dir, "steps"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
  });

  it("manifest has correct structure", () => {
    createPlugin("my-test", tmpDir);
    const raw = readFileSync(join(tmpDir, "unicli-plugin.json"), "utf-8");
    const manifest = JSON.parse(raw) as PluginManifest;
    expect(manifest.name).toBe("my-test");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.adapters).toBe("adapters/");
    expect(manifest.steps).toBe("steps/");
    expect(manifest.unicli).toBe(">=0.206.0");
  });
});

// ---------------------------------------------------------------------------
// Manifest Parsing
// ---------------------------------------------------------------------------
describe("listManifestPlugins", () => {
  it("returns empty array when plugins dir does not exist", () => {
    // listManifestPlugins checks ~/.unicli/plugins/ which may or may not exist
    // but it should never throw
    const result = listManifestPlugins();
    expect(Array.isArray(result)).toBe(true);
  });
});
