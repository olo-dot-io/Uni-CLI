/**
 * @owner   src/engine/steps/map.ts
 * @does    Project pipeline arrays or singleton values into rows.
 * @needs   PipelineContext data, template expressions
 * @feeds   YAML adapter map step, package info projections
 * @breaks  Singleton API responses can leak unbounded upstream payloads.
 */

import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";
import { evalTemplate } from "../template.js";

function itemsForMap(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data === null || data === undefined) return null;
  return [data];
}

export function stepMap(
  ctx: PipelineContext,
  template: Record<string, string>,
): PipelineContext {
  const items = itemsForMap(ctx.data);
  if (!items) return ctx;

  const mapped = items.map((item, index) => {
    const row: Record<string, unknown> = {};
    for (const [key, expr] of Object.entries(template)) {
      row[key] = evalTemplate(String(expr), {
        ...ctx,
        data: { item, index },
      });
    }
    return row;
  });

  return { ...ctx, data: mapped };
}

registerStep("map", stepMap as StepHandler);
