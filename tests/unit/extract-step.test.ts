import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserInvocationContext } from "../../src/browser/invocation-context.js";
import {
  createBrowserInvocationScope,
  runBrowserInvocation,
} from "../../src/browser/invocation-scope.js";
import type { ResolvedArgs } from "../../src/engine/args.js";
import {
  runPipeline,
  type PipelineContext,
} from "../../src/engine/executor.js";
import {
  extractHtmlRows,
  stepExtract,
} from "../../src/engine/steps/extract.js";
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

  it("generates ordered one-to-many text extraction", async () => {
    const { result, expression } = await runExtract(
      {
        extract: {
          from: ".story",
          fields: { tags: { selector: ".tag", multiple: true } },
        },
      },
      [{ tags: ["api", "graphics"] }],
    );

    expect(result).toEqual([{ tags: ["api", "graphics"] }]);
    expect(expression).toContain("querySelectorAll");
    expect(expression).toContain(".tag");
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

  it("surfaces malformed page serialization instead of faking an empty result", async () => {
    await expect(
      runExtract(
        {
          extract: {
            from: ".item",
            fields: { title: { selector: ".title" } },
          },
        },
        "not valid json",
      ),
    ).rejects.toThrow();
  });
});

describe("HTTP HTML extract pipeline contract", () => {
  it("extracts text, attributes, HTML, numbers, and capture groups without a page", () => {
    const rows = extractHtmlRows(
      `<article class="item"><a href="/a"><span class="title">Alpha</span></a><div class="body"><b>Fast</b></div><span class="count">42 stars</span><span class="meta">ID: 17</span></article>`,
      "article.item",
      {
        title: { selector: ".title" },
        url: { selector: "a", type: "attribute" },
        body: { selector: ".body", type: "html" },
        count: { selector: ".count", type: "number" },
        id: { selector: ".meta", pattern: "ID:\\s*(\\d+)" },
        tags: { selector: ".tag", multiple: true },
      },
    );

    expect(rows).toEqual([
      {
        title: "Alpha",
        url: "/a",
        body: "<b>Fast</b>",
        count: 42,
        id: "17",
        tags: [],
      },
    ]);
  });

  it("surfaces a configured anti-bot challenge instead of false empty success", async () => {
    const context = staticHtmlContext(
      `<form id="challenge-form"><div data-testid="anomaly-modal">Verify you are human</div></form>`,
    );

    await expect(
      stepExtract(
        context,
        {
          from: "div.result",
          challenge_selector: "#challenge-form",
          challenge_suggestion: "Use another registered public source.",
          empty_selector: ".result--no-result",
          required: true,
          fields: { title: { selector: ".title" } },
        },
        2,
      ),
    ).rejects.toMatchObject({
      detail: expect.objectContaining({
        step: 2,
        errorType: "challenge_required",
        preserveErrorCode: true,
        suggestion: "Use another registered public source.",
      }),
    });
  });

  it("distinguishes a configured legitimate empty page from selector drift", async () => {
    const config = {
      from: "div.result:not(.result--no-result)",
      challenge_selector: "#challenge-form",
      empty_selector: ".result--no-result",
      required: true,
      fields: { title: { selector: ".title" } },
    };
    const legitimateEmpty = await stepExtract(
      staticHtmlContext(
        `<div class="result result--no-result"><p>No results found</p></div>`,
      ),
      config,
      1,
    );

    expect(legitimateEmpty.data).toEqual([]);
    await expect(
      stepExtract(
        staticHtmlContext(`<main>Changed result markup</main>`),
        config,
        1,
      ),
    ).rejects.toMatchObject({
      detail: expect.objectContaining({
        errorType: "selector_miss",
        preserveErrorCode: true,
      }),
    });
  });
});

function staticHtmlContext(html: string): PipelineContext {
  return {
    data: html,
    args: {},
    vars: {},
    canMutate: false,
  };
}

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
