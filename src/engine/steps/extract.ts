/**
 * @owner       src::engine::steps::extract
 * @does        Extracts typed records from fetched HTML or the active browser page and distinguishes configured challenge, legitimate-empty, and selector-drift states.
 * @needs       cheerio, template evaluation, optional browser page acquisition, step registry
 * @feeds       keyless HTTP search adapters and browser extraction pipelines
 * @breaks      Transport-specific selector semantics or silent anti-bot/empty-page ambiguity make adapters pass lint while returning false success.
 * @invariants  HTTP extraction never starts a browser; one-to-many fields preserve DOM order; configured challenge states fail explicitly; configured legitimate-empty states return []; required selector misses fail explicitly; browser extraction preserves the acquired page in context; malformed browser serialization raises an error.
 * @side-effects Browser mode may acquire and evaluate a CDP page; HTTP mode is pure.
 * @perf        O(D * F), where D is matched DOM records and F is configured fields.
 * @concurrency safe per pipeline context
 * @test        tests/unit/extract-step.test.ts
 * @stability   stable
 * @since       2026-07-17
 */

import { load, type CheerioAPI } from "cheerio";
import { registerStep, type StepHandler } from "../step-registry.js";
import { PipelineError, type PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";
import { acquirePage } from "./browser-helpers.js";

interface FieldDef {
  selector: string;
  type?: "text" | "number" | "html" | "attribute";
  attribute?: string;
  pattern?: string;
  multiple?: boolean;
}

export interface ExtractConfig {
  from: string;
  fields: Record<string, FieldDef>;
  challenge_selector?: string;
  challenge_suggestion?: string;
  empty_selector?: string;
  required?: boolean;
}

function extractionStateError(
  config: ExtractConfig,
  stepIndex: number,
  errorType: "challenge_required" | "selector_miss",
  selector: string,
): PipelineError {
  const challenge = errorType === "challenge_required";
  return new PipelineError(
    challenge
      ? `Extraction stopped because the response matched challenge selector "${selector}".`
      : `Required extraction selector "${selector}" matched no records.`,
    {
      step: stepIndex,
      action: "extract",
      config,
      errorType,
      suggestion: challenge
        ? (config.challenge_suggestion ??
          "Complete the upstream verification challenge in the shared browser session, then retry.")
        : `Inspect the live response and update the stale extraction selector "${selector}".`,
      retryable: false,
      alternatives: [],
      preserveErrorCode: true,
    },
  );
}

function matchText(value: string, pattern: string | undefined): string {
  if (!pattern) return value.trim();
  const match = value.match(new RegExp(pattern));
  return match ? match[1] || match[0] : value.trim();
}

function extractStaticField(
  scope: ReturnType<CheerioAPI>,
  def: FieldDef,
): string | number | null | Array<string | number> {
  const elements = scope.find(def.selector);
  if (elements.length === 0) return def.multiple ? [] : null;

  const extract = (index: number): string | number | null => {
    const element = elements.eq(index);
    if (def.type === "attribute" || def.attribute) {
      return element.attr(def.attribute ?? "href") ?? null;
    }
    if (def.type === "html") return element.html();

    const text = element.text();
    if (def.type === "number") {
      const matched = def.pattern ? text.match(new RegExp(def.pattern)) : null;
      const numeric = matched ? matched[0] : text.replace(/[^\d.-]/g, "");
      const parsed = Number.parseFloat(numeric);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return matchText(text, def.pattern);
  };

  if (def.multiple) {
    return elements
      .toArray()
      .map((_element, index) => extract(index))
      .filter((value): value is string | number => value !== null);
  }
  return extract(0);
}

export function extractHtmlRows(
  html: string,
  containerSelector: string,
  fields: Record<string, FieldDef>,
): Array<Record<string, string | number | null | Array<string | number>>> {
  const $: CheerioAPI = load(html);
  return $(containerSelector)
    .toArray()
    .map((item) => {
      const scope = $(item);
      return Object.fromEntries(
        Object.entries(fields).map(([key, def]) => [
          key,
          extractStaticField(scope, def),
        ]),
      );
    });
}

export async function stepExtract(
  ctx: PipelineContext,
  config: ExtractConfig,
  stepIndex = 0,
): Promise<PipelineContext> {
  const containerSelector = evalTemplate(config.from, ctx);
  const challengeSelector = config.challenge_selector
    ? evalTemplate(config.challenge_selector, ctx)
    : undefined;
  const emptySelector = config.empty_selector
    ? evalTemplate(config.empty_selector, ctx)
    : undefined;

  if (typeof ctx.data === "string" && !ctx.page) {
    const $ = load(ctx.data);
    if (challengeSelector && $(challengeSelector).length > 0) {
      throw extractionStateError(
        config,
        stepIndex,
        "challenge_required",
        challengeSelector,
      );
    }
    const data = extractHtmlRows(ctx.data, containerSelector, config.fields);
    if (data.length === 0) {
      if (emptySelector && $(emptySelector).length > 0) {
        return { ...ctx, data };
      }
      if (config.required) {
        throw extractionStateError(
          config,
          stepIndex,
          "selector_miss",
          containerSelector,
        );
      }
    }
    return {
      ...ctx,
      data,
    };
  }

  const page = await acquirePage(ctx);
  if (
    challengeSelector &&
    (await page.evaluate(
      `!!document.querySelector(${JSON.stringify(challengeSelector)})`,
    ))
  ) {
    throw extractionStateError(
      config,
      stepIndex,
      "challenge_required",
      challengeSelector,
    );
  }

  // Build a JS expression that extracts structured data
  const fieldEntries = Object.entries(config.fields);
  const fieldJs = fieldEntries
    .map(([key, def]) => {
      const sel = JSON.stringify(def.selector);
      const attr = def.attribute ? JSON.stringify(def.attribute) : null;
      const pattern = def.pattern ? JSON.stringify(def.pattern) : null;
      const type = def.type ?? "text";

      if (def.multiple) {
        if (type === "attribute" || attr) {
          return `${JSON.stringify(key)}: Array.from(item.querySelectorAll(${sel})).map(el => el.getAttribute(${attr ?? JSON.stringify("href")})).filter(value => value !== null)`;
        }
        if (type === "number") {
          return `${JSON.stringify(key)}: Array.from(item.querySelectorAll(${sel})).map(el => { const txt = el.textContent || ''; ${pattern ? `const m = txt.match(new RegExp(${pattern})); return m ? parseFloat(m[0]) : null;` : `const n = parseFloat(txt.replace(/[^\\d.-]/g, '')); return Number.isFinite(n) ? n : null;`} }).filter(value => value !== null)`;
        }
        if (type === "html") {
          return `${JSON.stringify(key)}: Array.from(item.querySelectorAll(${sel})).map(el => el.innerHTML)`;
        }
        if (pattern) {
          return `${JSON.stringify(key)}: Array.from(item.querySelectorAll(${sel})).map(el => { const txt = el.textContent || ''; const m = txt.match(new RegExp(${pattern})); return m ? (m[1] || m[0]) : txt.trim(); })`;
        }
        return `${JSON.stringify(key)}: Array.from(item.querySelectorAll(${sel})).map(el => (el.textContent || '').trim())`;
      }

      if (type === "attribute" || attr) {
        return `${JSON.stringify(key)}: (() => { const el = item.querySelector(${sel}); return el ? el.getAttribute(${attr ?? JSON.stringify("href")}) : null; })()`;
      } else if (type === "number") {
        return `${JSON.stringify(key)}: (() => { const el = item.querySelector(${sel}); if (!el) return null; const txt = el.textContent || ''; ${pattern ? `const m = txt.match(new RegExp(${pattern})); return m ? parseFloat(m[0]) : null;` : `const n = parseFloat(txt.replace(/[^\\d.-]/g, '')); return Number.isFinite(n) ? n : null;`} })()`;
      } else if (type === "html") {
        return `${JSON.stringify(key)}: (() => { const el = item.querySelector(${sel}); return el ? el.innerHTML : null; })()`;
      } else {
        // text (default)
        if (pattern) {
          return `${JSON.stringify(key)}: (() => { const el = item.querySelector(${sel}); if (!el) return null; const txt = el.textContent || ''; const m = txt.match(new RegExp(${pattern})); return m ? (m[1] || m[0]) : txt.trim(); })()`;
        }
        return `${JSON.stringify(key)}: (() => { const el = item.querySelector(${sel}); return el ? el.textContent.trim() : null; })()`;
      }
    })
    .join(",\n      ");

  const extractJs = `
    JSON.stringify(
      Array.from(document.querySelectorAll(${JSON.stringify(containerSelector)})).map(item => ({
        ${fieldJs}
      }))
    )
  `;

  const resultStr = (await page.evaluate(extractJs)) as string;
  const data = JSON.parse(resultStr) as unknown[];
  if (data.length === 0) {
    if (
      emptySelector &&
      (await page.evaluate(
        `!!document.querySelector(${JSON.stringify(emptySelector)})`,
      ))
    ) {
      return { ...ctx, data, page };
    }
    if (config.required) {
      throw extractionStateError(
        config,
        stepIndex,
        "selector_miss",
        containerSelector,
      );
    }
  }

  return { ...ctx, data, page };
}

registerStep("extract", stepExtract as StepHandler);
