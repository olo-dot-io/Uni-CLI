import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserInvocationContext } from "../../src/browser/invocation-context.js";
import {
  createBrowserInvocationScope,
  runBrowserInvocation,
} from "../../src/browser/invocation-scope.js";
import type { ResolvedArgs } from "../../src/engine/args.js";
import { runPipeline } from "../../src/engine/executor.js";
import "../../src/engine/steps/index.js";
import type { PipelineStep } from "../../src/types.js";
import { InMemoryBrowserRuntimeHarness } from "../helpers/in-memory-browser-runtime.js";

let runtime: InMemoryBrowserRuntimeHarness;
let previousRuntimeRoot: string | undefined;
let invocationNumber = 0;

beforeEach(async () => {
  previousRuntimeRoot = process.env.UNICLI_BROWSER_RUNTIME_DIR;
  runtime = new InMemoryBrowserRuntimeHarness();
  process.env.UNICLI_BROWSER_RUNTIME_DIR = runtime.runtimeRoot;
  invocationNumber = 0;
  await runtime.start();
});

afterEach(async () => {
  await runtime.cleanup();
  if (previousRuntimeRoot === undefined) {
    delete process.env.UNICLI_BROWSER_RUNTIME_DIR;
  } else {
    process.env.UNICLI_BROWSER_RUNTIME_DIR = previousRuntimeRoot;
  }
});

describe("broker-backed extract pipeline step", () => {
  it("extracts text fields with a templated container selector", async () => {
    const { result, expression } = await runExtract(
      {
        extract: {
          from: "#${{ args.section }} .item",
          fields: { title: { selector: ".title" } },
        },
      },
      [{ title: "Product A" }, { title: "Product B" }],
      { args: { section: "products" }, source: "internal" },
    );

    expect(result).toEqual([{ title: "Product A" }, { title: "Product B" }]);
    expect(expression).toContain("#products .item");
    expect(expression).toContain(".title");
    expect(expression).toContain("textContent.trim()");
  });

  it("generates patterned and unpatterned number extraction", async () => {
    const patterned = await runExtract(
      {
        extract: {
          from: ".product",
          fields: {
            price: {
              selector: ".price",
              type: "number",
              pattern: "\\d+\\.?\\d*",
            },
          },
        },
      },
      [{ price: 29.99 }],
    );
    const unpatterned = await runExtract(
      {
        extract: {
          from: ".stats",
          fields: { count: { selector: ".count", type: "number" } },
        },
      },
      [{ count: 42 }],
    );

    expect(patterned.result).toEqual([{ price: 29.99 }]);
    expect(patterned.expression).toContain("new RegExp");
    expect(patterned.expression).toContain("\\d+");
    expect(patterned.expression).toContain("parseFloat(m[0])");
    expect(unpatterned.result).toEqual([{ count: 42 }]);
    expect(unpatterned.expression).toContain("replace(/[^\\d.-]/g");
  });

  it("generates explicit and default attribute extraction", async () => {
    const { result, expression } = await runExtract(
      {
        extract: {
          from: ".card",
          fields: {
            url: {
              selector: "a.primary",
              type: "attribute",
              attribute: "data-url",
            },
            fallback: { selector: "a.fallback", type: "attribute" },
          },
        },
      },
      [{ url: "/primary", fallback: "/fallback" }],
    );

    expect(result).toEqual([{ url: "/primary", fallback: "/fallback" }]);
    expect(expression).toContain("getAttribute");
    expect(expression).toContain("data-url");
    expect(expression).toContain("href");
  });

  it("generates HTML field extraction", async () => {
    const { result, expression } = await runExtract(
      {
        extract: {
          from: ".post",
          fields: { content: { selector: ".body", type: "html" } },
        },
      },
      [{ content: "<b>Bold</b> text" }],
    );

    expect(result).toEqual([{ content: "<b>Bold</b> text" }]);
    expect(expression).toContain("innerHTML");
  });

  it("generates capture-group text extraction", async () => {
    const { result, expression } = await runExtract(
      {
        extract: {
          from: ".item",
          fields: {
            id: {
              selector: ".meta",
              type: "text",
              pattern: "ID:\\s*(\\d+)",
            },
          },
        },
      },
      [{ id: "12345" }],
    );

    expect(result).toEqual([{ id: "12345" }]);
    expect(expression).toContain("ID:\\\\s*(\\\\d+)");
    expect(expression).toContain("m[1] || m[0]");
  });

  it("returns an empty collection when the page has no matching elements", async () => {
    const { result } = await runExtract(
      {
        extract: {
          from: ".missing",
          fields: { title: { selector: ".title" } },
        },
      },
      [],
    );

    expect(result).toEqual([]);
  });

  it("contains malformed page JSON as an empty extraction result", async () => {
    const { result } = await runExtract(
      {
        extract: {
          from: ".item",
          fields: { title: { selector: ".title" } },
        },
      },
      "not valid json",
    );

    expect(result).toEqual([]);
  });
});

async function runExtract(
  step: PipelineStep,
  pageResult: unknown[] | string,
  bag: ResolvedArgs = { args: {}, source: "internal" },
): Promise<{ result: unknown[]; expression: string }> {
  const serialized =
    typeof pageResult === "string" ? pageResult : JSON.stringify(pageResult);
  let expression = "";
  runtime.provider.evaluationResolver = (candidate) => {
    if (!candidate.includes("document.querySelectorAll")) return undefined;
    expression = candidate;
    return serialized;
  };
  const invocationId = ++invocationNumber;
  const context = createBrowserInvocationContext({
    transport: "cli",
    agentSessionId: `extract-agent-${String(invocationId)}`,
    turnId: `extract-turn-${String(invocationId)}`,
    profilePartitionId: "extract-login",
  });
  const scope = createBrowserInvocationScope({ context });
  const result = await runBrowserInvocation(scope, () =>
    runPipeline([step], bag, undefined, { browserSession: "cdp" }),
  );
  expect(expression).not.toBe("");
  return { result, expression };
}
