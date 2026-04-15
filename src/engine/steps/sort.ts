import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";

export interface SortConfig {
  by: string;
  order?: "asc" | "desc";
}

export function stepSort(
  ctx: PipelineContext,
  config: SortConfig,
): PipelineContext {
  if (!Array.isArray(ctx.data)) return ctx;
  const items = [...ctx.data] as Record<string, unknown>[];
  const desc = config.order === "desc";
  items.sort((a, b) => {
    const va = a[config.by];
    const vb = b[config.by];
    const na = Number(va);
    const nb = Number(vb);
    if (!isNaN(na) && !isNaN(nb)) return desc ? nb - na : na - nb;
    return desc
      ? String(vb ?? "").localeCompare(String(va ?? ""))
      : String(va ?? "").localeCompare(String(vb ?? ""));
  });
  return { ...ctx, data: items };
}

registerStep("sort", stepSort as StepHandler);
