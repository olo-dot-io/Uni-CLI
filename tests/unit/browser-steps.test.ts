import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserInvocationContext } from "../../src/browser/invocation-context.js";
import {
  createBrowserInvocationScope,
  runBrowserInvocation,
} from "../../src/browser/invocation-scope.js";
import { runPipeline } from "../../src/engine/executor.js";
import type { ResolvedArgs } from "../../src/engine/args.js";
import type { PipelineStep } from "../../src/types.js";
import { InMemoryBrowserRuntimeHarness } from "../helpers/in-memory-browser-runtime.js";

let runtime: InMemoryBrowserRuntimeHarness;
let previousRuntimeRoot: string | undefined;
let previousPermissionRulesPath: string | undefined;
let turnNumber = 0;

beforeEach(async () => {
  previousRuntimeRoot = process.env.UNICLI_BROWSER_RUNTIME_DIR;
  previousPermissionRulesPath = process.env.UNICLI_PERMISSION_RULES_PATH;
  delete process.env.UNICLI_PERMISSION_RULES_PATH;
  runtime = new InMemoryBrowserRuntimeHarness();
  process.env.UNICLI_BROWSER_RUNTIME_DIR = runtime.runtimeRoot;
  turnNumber = 0;
  await runtime.start();
});

afterEach(async () => {
  await runtime.cleanup();
  restoreEnv("UNICLI_BROWSER_RUNTIME_DIR", previousRuntimeRoot);
  restoreEnv("UNICLI_PERMISSION_RULES_PATH", previousPermissionRulesPath);
});

describe("broker-backed browser pipeline steps", () => {
  it("executes a multi-step pipeline on one hidden broker target and finalizes its turn", async () => {
    runtime.provider.evaluationResults.set("6 * 7", 42);

    const result = await runBrokerPipeline(
      [
        {
          navigate: {
            url: "https://example.com/${{ args.path }}",
            settleMs: 25,
          },
        },
        { evaluate: "6 * 7" },
        { click: ".continue" },
        { type: { selector: "#search", text: "hello", submit: true } },
        { press: { key: "a", modifiers: ["ctrl"] } },
        { scroll: "bottom" },
        {
          snapshot: { interactive: true, compact: true, max_depth: 5 },
        },
      ],
      { args: { path: "feed" }, source: "internal" },
    );

    expect(result).toEqual(["[1]<button>Continue</button>"]);
    expect(runtime.provider.acquireCount).toBe(1);
    const page = runtime.provider.pages[0]!;
    expect(page.navigations).toEqual([
      {
        url: "https://example.com/feed",
        options: { settleMs: 25 },
      },
    ]);
    expect(page.clicks).toEqual([".continue"]);
    expect(page.typed).toEqual([{ selector: "#search", text: "hello" }]);
    expect(page.presses).toEqual([
      { key: "Enter" },
      { key: "a", modifiers: ["ctrl"] },
    ]);
    expect(page.scrolls).toEqual(["bottom"]);
    expect(page.evaluations).toEqual(
      expect.arrayContaining([
        "6 * 7",
        expect.stringContaining("const INTERACTIVE = true"),
        expect.stringContaining("const COMPACT = true"),
        expect.stringContaining("const MAX_DEPTH = 5"),
      ]),
    );
    expect(page.cdpCalls[0]).toMatchObject({
      method: "Page.addScriptToEvaluateOnNewDocument",
    });
    const status = await runtime.status();
    expect(status.sessions.sessions).toEqual([
      expect.objectContaining({
        agent_session_id: "pipeline-agent",
        active_turn_ids: [],
        target_ids: [page.targetId],
      }),
    ]);
  });

  it("accepts shorthand navigate and evaluate forms", async () => {
    runtime.provider.evaluationResults.set("document.title", "Fixture title");

    const result = await runBrokerPipeline(
      [
        { navigate: "https://example.com/trending" },
        { evaluate: "document.title" },
      ],
      { args: {}, source: "internal" },
    );

    expect(result).toEqual(["Fixture title"]);
    expect(runtime.provider.pages[0]?.navigations).toEqual([
      {
        url: "https://example.com/trending",
        options: { settleMs: 0 },
      },
    ]);
  });

  it("routes coordinate clicks and focused typing through broker CDP commands", async () => {
    await runBrokerPipeline(
      [{ click: { x: 150, y: 300 } }, { type: { text: "focused input" } }],
      { args: {}, source: "internal" },
    );

    expect(runtime.provider.pages[0]?.cdpCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "Input.dispatchMouseEvent",
          params: expect.objectContaining({ x: 150, y: 300 }),
        }),
        {
          method: "Input.insertText",
          params: { text: "focused input" },
        },
      ]),
    );
  });

  it("rejects malformed click configuration with a structured pipeline error", async () => {
    await expect(
      runBrokerPipeline([{ click: {} }], {
        args: {},
        source: "internal",
      }),
    ).rejects.toMatchObject({
      detail: { action: "click", errorType: "expression_error" },
    });
  });

  it("times out an interceptor when the broker target captures no matching request", async () => {
    await expect(
      runBrokerPipeline(
        [
          {
            intercept: {
              trigger: "scroll",
              capture: "/api/data",
              timeout: 250,
            },
          },
        ],
        { args: {}, source: "internal" },
      ),
    ).rejects.toThrow(/Intercept timeout/);
    expect(runtime.provider.pages[0]?.scrolls).toEqual(["down"]);
  });

  it("returns parsed data from a framework tap over the broker page", async () => {
    runtime.provider.evaluationResolver = (expression) =>
      expression.includes("userStore")
        ? JSON.stringify({ url: "/api/user", data: { name: "test" } })
        : undefined;

    const result = await runBrokerPipeline(
      [
        {
          tap: {
            store: "userStore",
            action: "fetchData",
            capture: "/api/user",
            framework: "pinia",
          },
        },
      ],
      { args: {}, source: "internal" },
    );

    expect(result).toEqual([{ url: "/api/user", data: { name: "test" } }]);
    expect(runtime.provider.pages[0]?.evaluations[0]).toContain("fetchData");
  });

  it("blocks a denied navigation domain before allocating any browser target", async () => {
    const rulesRoot = installPermissionRule({
      id: "deny-example-navigation",
      decision: "deny",
      match: { resources: { domains: ["example.com"] } },
      reason: "navigation target is blocked",
    });
    try {
      await expect(
        runBrokerPipeline(
          [{ navigate: { url: "https://example.com/private" } }],
          { args: {}, source: "internal" },
        ),
      ).rejects.toMatchObject({
        detail: { action: "navigate", errorType: "permission_denied" },
      });
      expect(runtime.provider.acquireCount).toBe(0);
    } finally {
      rmSync(rulesRoot, { recursive: true, force: true });
    }
  });

  it("blocks a denied file navigation before allocating any browser target", async () => {
    const deniedRoot = mkdtempSync(join(tmpdir(), "unicli-file-deny-"));
    const deniedPath = join(deniedRoot, "secret.html");
    const rulesRoot = installPermissionRule({
      id: "deny-file-navigation",
      decision: "deny",
      match: { resources: { paths: [deniedPath] } },
      reason: "file navigation target is blocked",
    });
    try {
      await expect(
        runBrokerPipeline(
          [{ navigate: { url: pathToFileURL(deniedPath).href } }],
          { args: {}, source: "internal" },
        ),
      ).rejects.toMatchObject({
        detail: { action: "navigate", errorType: "permission_denied" },
      });
      expect(runtime.provider.acquireCount).toBe(0);
    } finally {
      rmSync(rulesRoot, { recursive: true, force: true });
      rmSync(deniedRoot, { recursive: true, force: true });
    }
  });

  it("keeps non-browser steps browser-free", async () => {
    const result = await runBrokerPipeline([{ limit: 2 }], {
      args: {},
      source: "internal",
    });

    expect(result).toEqual([]);
    expect(runtime.provider.acquireCount).toBe(0);
  });
});

async function runBrokerPipeline(
  steps: PipelineStep[],
  bag: ResolvedArgs,
): Promise<unknown[]> {
  const context = createBrowserInvocationContext({
    transport: "cli",
    agentSessionId: "pipeline-agent",
    turnId: `pipeline-turn-${String(++turnNumber)}`,
    profilePartitionId: "pipeline-login",
  });
  const scope = createBrowserInvocationScope({ context });
  return runBrowserInvocation(scope, () =>
    runPipeline(steps, bag, undefined, { browserSession: "cdp" }),
  );
}

function installPermissionRule(rule: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "unicli-browser-rule-"));
  const path = join(root, "permission-rules.json");
  process.env.UNICLI_PERMISSION_RULES_PATH = path;
  writeFileSync(
    path,
    JSON.stringify({ schema_version: "1", rules: [rule] }),
    "utf-8",
  );
  return root;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
