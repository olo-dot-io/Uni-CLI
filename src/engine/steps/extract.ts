import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";
import { acquirePage } from "./browser-helpers.js";

interface FieldDef {
  selector: string;
  type?: "text" | "number" | "html" | "attribute";
  attribute?: string;
  pattern?: string;
}

export interface ExtractConfig {
  from: string;
  fields: Record<string, FieldDef>;
}

export async function stepExtract(
  ctx: PipelineContext,
  config: ExtractConfig,
): Promise<PipelineContext> {
  const page = await acquirePage(ctx);
  const containerSelector = evalTemplate(config.from, ctx);

  // Build a JS expression that extracts structured data
  const fieldEntries = Object.entries(config.fields);
  const fieldJs = fieldEntries
    .map(([key, def]) => {
      const sel = JSON.stringify(def.selector);
      const attr = def.attribute ? JSON.stringify(def.attribute) : null;
      const pattern = def.pattern ? JSON.stringify(def.pattern) : null;
      const type = def.type ?? "text";

      if (type === "attribute" || attr) {
        return `${JSON.stringify(key)}: (() => { const el = item.querySelector(${sel}); return el ? el.getAttribute(${attr ?? JSON.stringify("href")}) : null; })()`;
      } else if (type === "number") {
        return `${JSON.stringify(key)}: (() => { const el = item.querySelector(${sel}); if (!el) return null; const txt = el.textContent || ''; ${pattern ? `const m = txt.match(new RegExp(${pattern})); return m ? parseFloat(m[0]) : null;` : `return parseFloat(txt.replace(/[^\\d.-]/g, '')) || null;`} })()`;
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
  let data: unknown[];
  try {
    data = JSON.parse(resultStr) as unknown[];
  } catch {
    data = [];
  }

  return { ...ctx, data, page };
}

registerStep("extract", stepExtract as StepHandler);
