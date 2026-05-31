//! @owner       src::engine::steps::to_entries
//! @does        Converts a plain object in ctx.data into a [{key,value}] array for map/filter
//! @needs       ../step-registry, ../executor
//! @feeds       ./index (barrel), pipeline executor via registry "to_entries"
//! @breaks      never throws; non-object input yields []
//! @invariants  input ctx.data is never mutated; an existing array passes through unchanged
//! @side-effects none (pure)
//! @perf        O(n) over the object's own enumerable keys
//! @concurrency pure
//! @test        tests/unit/engine/steps/to-entries.test.ts
//! @stability   stable
//! @since       2026-05-30

import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";

export interface ToEntriesConfig {
  /** Field name for the object key in each emitted row (default "key"). */
  key_name?: string;
  /** Field name for the object value in each emitted row (default "value"). */
  value_name?: string;
}

export function stepToEntries(
  ctx: PipelineContext,
  config: ToEntriesConfig,
): PipelineContext {
  const data = ctx.data;
  if (Array.isArray(data)) return ctx;
  if (data === null || typeof data !== "object") {
    return { ...ctx, data: [] };
  }
  const keyName = config?.key_name ?? "key";
  const valueName = config?.value_name ?? "value";
  const rows = Object.entries(data as Record<string, unknown>).map(
    ([k, v]) => ({ [keyName]: k, [valueName]: v }),
  );
  return { ...ctx, data: rows };
}

registerStep("to_entries", stepToEntries as StepHandler);
