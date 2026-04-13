/**
 * Shared JSON Schema builders for MCP tools and CLI schema command.
 *
 * Single source of truth for:
 *   - Adapter arg → JSON Schema type mapping
 *   - Input/output schema generation from AdapterCommand metadata
 *   - Tool name normalization (site + command → MCP tool name)
 *   - Description truncation within token budgets
 */

import type { AdapterCommand } from "../types.js";

// ── JSON Schema Types ───────────────────────────────────────────────────────

export interface JsonSchemaProperty {
  type: string;
  description?: string;
  default?: unknown;
  enum?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
}

export interface JsonSchemaObject {
  type: "object" | "array";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaProperty;
}

// ── Type Mapping ────────────────────────────────────────────────────────────

/**
 * Map adapter `arg.type` to JSON Schema primitive.
 * Defaults to "string" for unknown/missing — safer than failing the build.
 */
export function jsonTypeFor(t: string | undefined): string {
  switch (t) {
    case "int":
      return "integer";
    case "float":
      return "number";
    case "bool":
      return "boolean";
    case "str":
    default:
      return "string";
  }
}

// ── Schema Builders ─────────────────────────────────────────────────────────

/**
 * Build JSON Schema for a command's input from its `args` definition.
 * Always includes a `limit` parameter (default 20) for result capping.
 */
export function buildInputSchema(cmd: AdapterCommand): JsonSchemaObject {
  const props: Record<string, JsonSchemaProperty> = {
    limit: {
      type: "integer",
      description: "Cap result count (default 20)",
      default: 20,
    },
  };
  const required: string[] = [];

  for (const a of cmd.adapterArgs ?? []) {
    if (a.name === "limit") continue;
    const prop: JsonSchemaProperty = {
      type: jsonTypeFor(a.type),
      description: a.description,
    };
    if (a.default !== undefined) prop.default = a.default;
    if (a.choices) prop.enum = a.choices;
    props[a.name] = prop;
    if (a.required) required.push(a.name);
  }

  const schema: JsonSchemaObject = {
    type: "object",
    properties: props,
    additionalProperties: false,
  };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Build JSON Schema for a command's output.
 *
 * Two formats:
 *   - `wrapped` (MCP): `{count: int, results: [{...columns}]}`
 *   - `flat` (CLI schema): `[{...columns}]`
 *
 * MCP clients expect the wrapped format; the CLI `unicli schema` command
 * exposes the flat array format for simpler consumption.
 */
export function buildOutputSchema(
  cmd: AdapterCommand,
  format: "wrapped" | "flat" = "wrapped",
): JsonSchemaObject {
  const itemProps: Record<string, JsonSchemaProperty> = {};
  for (const col of cmd.columns ?? []) {
    itemProps[col] = { type: "string", description: `Column: ${col}` };
  }

  const itemSchema: JsonSchemaProperty = {
    type: "object",
    ...(Object.keys(itemProps).length > 0 ? { properties: itemProps } : {}),
  };

  if (format === "flat") {
    return { type: "array", items: itemSchema };
  }

  return {
    type: "object",
    properties: {
      count: { type: "integer", description: "Number of results returned" },
      results: {
        type: "array",
        description: "Result rows",
        items: itemSchema,
      } as JsonSchemaProperty,
    },
  };
}

// ── Tool Name ───────────────────────────────────────────────────────────────

/**
 * Build normalized MCP tool name: `unicli_<site>_<command>`.
 *
 * Non-alphanumeric chars collapse to `_`. This normalization is NOT
 * reversible — callers must use a lookup table for reverse mapping.
 */
export function buildToolName(site: string, command: string): string {
  return `unicli_${site}_${command}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

// ── Description Truncation ──────────────────────────────────────────────────

/**
 * Approximate token count. Uses `words × 1.3` — closely tracks
 * tiktoken cl100k for English + mixed-case identifiers.
 */
export function approxTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

/**
 * Truncate description to fit within a token budget.
 * Cuts at word boundary, appends "…" when truncated.
 */
export function truncateDescription(desc: string, maxTokens = 68): string {
  if (approxTokens(desc) <= maxTokens) return desc;
  const words = desc.split(/\s+/).filter(Boolean);
  let result = "";
  for (const word of words) {
    const candidate = result ? `${result} ${word}` : word;
    if (approxTokens(candidate + " …") > maxTokens) break;
    result = candidate;
  }
  return result ? `${result} …` : words[0] + " …";
}
