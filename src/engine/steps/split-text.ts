//! @owner       src::engine::steps::split_text
//! @does        Splits delimited text (a blob, or each element of an array) into column-mapped rows
//! @needs       ../step-registry, ../executor
//! @feeds       ./index (barrel), pipeline executor via registry "split_text"
//! @breaks      Error when record_separator is absent in blob mode (config contract violation)
//! @invariants  input ctx.data is never mutated; empty records are dropped
//! @side-effects none (pure transform)
//! @perf        O(n) over the payload; one split per record, one per field
//! @concurrency pure; safe to call concurrently
//! @test        tests/unit/engine/steps/split-text.test.ts
//! @stability   stable
//! @since       2026-05-30

import { registerStep, type StepHandler } from "../step-registry.js";
import type { PipelineContext } from "../executor.js";

export interface SplitTextConfig {
  /**
   * "blob" (default): split a single text payload (ctx.data string) into
   * records by record_separator, then each record into fields.
   * "per_item": ctx.data is already an array of strings; split EACH element
   * into fields. record_separator is not required in this mode.
   */
  mode?: "blob" | "per_item";
  /** Delimiter between records (e.g. "@"). Required in blob mode. */
  record_separator?: string;
  /** Delimiter between fields within a record (e.g. "|"). Omit for a flat string array. */
  field_separator?: string;
  /** Column names mapped positionally onto each record's fields. Omit for a flat string array. */
  columns?: string[];
  /** Regex (string form) removed from the start of the blob payload before splitting. */
  strip_prefix?: string;
  /** Regex (string form) removed from the end of the blob payload before splitting. */
  strip_suffix?: string;
  /** Regex (string form, global) removed from EACH element in per_item mode (e.g. "%0A" line-wrap noise). */
  strip_each?: string;
  /** Decode each value/element before field-splitting. "uri" = decodeURIComponent. */
  decode?: "uri";
}

function splitIntoRow(
  record: string,
  fieldSep: string,
  columns: string[],
  decode: "uri" | undefined,
): Record<string, string> {
  const fields = record.split(fieldSep);
  const row: Record<string, string> = {};
  columns.forEach((col, i) => {
    const raw = fields[i] ?? "";
    row[col] = decode === "uri" ? safeDecodeUri(raw) : raw;
  });
  return row;
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // REASON: malformed percent-escapes from a third-party payload must not
    // crash the pipeline; fall back to the raw value.
    return value;
  }
}

export function stepSplitText(
  ctx: PipelineContext,
  config: SplitTextConfig,
): PipelineContext {
  if (config?.mode === "per_item") {
    return splitPerItem(ctx, config);
  }

  if (!config || typeof config.record_separator !== "string") {
    throw new Error("split_text step requires a record_separator");
  }

  let raw = String(ctx.data ?? "");
  if (config.strip_prefix) {
    raw = raw.replace(new RegExp(config.strip_prefix), "");
  }
  if (config.strip_suffix) {
    raw = raw.replace(new RegExp(config.strip_suffix), "");
  }

  if (raw === "") {
    return { ...ctx, data: [] };
  }

  const records = raw
    .split(config.record_separator)
    .filter((r) => r.length > 0);

  if (!config.columns || config.field_separator === undefined) {
    return { ...ctx, data: records };
  }

  const columns = config.columns;
  const fieldSep = config.field_separator;
  const rows = records.map((record) =>
    splitIntoRow(record, fieldSep, columns, config.decode),
  );

  return { ...ctx, data: rows };
}

/**
 * per_item mode: ctx.data is an array of strings (e.g. 12306 queryX
 * `data.result[]`). Optionally strip a noise regex from and URL-decode each
 * element, then split it into a column-mapped row.
 */
function splitPerItem(
  ctx: PipelineContext,
  config: SplitTextConfig,
): PipelineContext {
  if (!Array.isArray(ctx.data)) {
    return { ...ctx, data: [] };
  }
  const stripEach = config.strip_each
    ? new RegExp(config.strip_each, "g")
    : null;

  const out = ctx.data.map((element) => {
    let value = String(element ?? "");
    if (stripEach) value = value.replace(stripEach, "");
    if (config.decode === "uri") value = safeDecodeUri(value);

    if (!config.columns || config.field_separator === undefined) {
      return value;
    }
    // decode already applied to the whole element above; split into fields
    // without re-decoding per field.
    return splitIntoRow(
      value,
      config.field_separator,
      config.columns,
      undefined,
    );
  });

  return { ...ctx, data: out };
}

registerStep("split_text", stepSplitText as StepHandler);
