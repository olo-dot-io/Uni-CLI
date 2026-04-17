/**
 * Output formatter — renders command results in agent-friendly formats.
 *
 * Supported formats (6): json, yaml, csv, md, compact, table (deprecated)
 *
 *   - json    — v2 AgentEnvelope as JSON
 *   - yaml    — v2 AgentEnvelope as YAML (zero deps, minimal serializer)
 *   - md      — v2 AgentEnvelope as agent-native Markdown (frontmatter + sections)
 *   - csv     — legacy comma-separated with quoted escapes (array-only)
 *   - compact — one row per line, `|` separator, no headers (array-only)
 *   - table   — deprecated alias for md; emits stderr warning
 *
 * `format()` requires a ctx (AgentContext) parameter — callers must supply
 * at least command name and duration_ms. This is intentional: the compiler
 * enforces that every call site plumbs through command metadata.
 *
 * Non-TTY stdout and agent user-agents both default to "md" (v2 envelope MD).
 */

import type { OutputFormat } from "../types.js";
import type { AgentContext, AgentEnvelope } from "./envelope.js";
import { makeEnvelope, makeError } from "./envelope.js";
import { renderMd } from "./md.js";

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Format command output. For agent-facing formats (json/yaml/md) the payload
 * is wrapped in a v2 AgentEnvelope. For csv/compact legacy formats the payload
 * is rendered as a flat table (unchanged).
 *
 * `ctx` is REQUIRED — callers must supply at least command name and duration_ms.
 */
export function format(
  data: unknown[] | Record<string, unknown> | null | undefined,
  columns: string[] | undefined,
  fmt: OutputFormat,
  ctx: AgentContext,
): string {
  if (fmt === "csv") return toCsv(toArray(data), columns);
  if (fmt === "compact") return toCompact(toArray(data), columns);

  if (fmt === "table") {
    process.stderr.write(
      "[deprecated] `-f table` → `md`. Migrate before v0.215.\n",
    );
    fmt = "md";
  }

  const envelope: AgentEnvelope = ctx.error
    ? makeError(ctx, ctx.error)
    : makeEnvelope(ctx, data ?? []);

  if (fmt === "md") return renderMd(envelope);
  if (fmt === "json") return JSON.stringify(envelope, null, 2);
  if (fmt === "yaml") return renderYamlEnvelope(envelope);
  // Unknown format — JSON envelope as safe default
  return JSON.stringify(envelope, null, 2);
}

/**
 * Auto-pick output format.
 *  - explicit param → that format
 *  - env UNICLI_OUTPUT or OUTPUT ∈ {md|json|yaml|csv|compact|table} → that format
 *  - non-TTY stdout OR isAgentUA() → "md"
 *  - TTY human → "md"
 */
export function detectFormat(explicit?: OutputFormat): OutputFormat {
  if (explicit) return explicit;
  const envOverride = (
    process.env.UNICLI_OUTPUT ?? process.env.OUTPUT
  )?.toLowerCase();
  if (
    envOverride &&
    ["md", "json", "yaml", "csv", "compact", "table"].includes(envOverride)
  ) {
    return envOverride as OutputFormat;
  }
  if (!process.stdout.isTTY) return "md";
  if (isAgentUA()) return "md";
  return "md";
}

/** Detect whether an AI agent / coding tool invoked us. Public for tests. */
export function isAgentUA(): boolean {
  return Boolean(
    process.env.CLAUDE_CODE ||
    process.env.CODEX_CLI ||
    process.env.OPENCODE ||
    process.env.HERMES_AGENT ||
    process.env.UNICLI_AGENT ||
    /Claude-Code|Codex|Agent|LLM/i.test(process.env.USER_AGENT ?? ""),
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Normalize data to array for legacy csv/compact formats. */
function toArray(
  d: unknown[] | Record<string, unknown> | null | undefined,
): unknown[] {
  if (d === null || d === undefined) return [];
  if (Array.isArray(d)) return d;
  // Object → single-row array (best-effort for tabular legacy formats)
  return [d];
}

function toCsv(data: unknown[], columns?: string[]): string {
  if (data.length === 0) return "";
  const rows = data as Record<string, unknown>[];
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const header = cols.join(",");
  const body = rows.map((r) =>
    cols.map((c) => csvEscape(String(r[c] ?? ""))).join(","),
  );
  return [header, ...body].join("\n");
}

function toCompact(data: unknown[], columns?: string[]): string {
  if (data.length === 0) return "";
  const rows = data as Record<string, unknown>[];
  const cols = columns ?? Object.keys(rows[0] ?? {});
  return rows
    .map((r) => cols.map((c) => compactCell(r[c])).join("|"))
    .join("\n");
}

function compactCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "/");
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── YAML envelope serializer (zero deps) ─────────────────────────────────────

/**
 * Minimal YAML serializer for AgentEnvelope objects.
 * Handles: string, number, boolean, null, arrays of primitives/objects, nested objects.
 * Does NOT handle: cycles, Date, Buffer, BigInt (envelope doesn't contain these).
 */
function renderYamlEnvelope(envelope: AgentEnvelope): string {
  return yamlValue(envelope as unknown as Record<string, unknown>, 0) + "\n";
}

function yamlValue(value: unknown, indent: number): string {
  const pad = " ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return yamlString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        const rendered = yamlValue(item, indent + 2);
        // Inline scalars go on same line; objects/arrays start on next line
        if (rendered.includes("\n")) {
          return `${pad}-\n${pad}  ${rendered.trimStart()}`;
        }
        return `${pad}- ${rendered}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    return keys
      .map((k) => {
        const v = obj[k];
        const rendered = yamlValue(v, indent + 2);
        if (rendered.includes("\n")) {
          return `${pad}${k}:\n${rendered}`;
        }
        return `${pad}${k}: ${rendered}`;
      })
      .join("\n");
  }
  return String(value);
}

function yamlString(s: string): string {
  // Scalars that need quoting: empty, contains special chars, looks like number/bool/null
  if (
    s === "" ||
    /[\n\r:#{}[\],&*?|<>=!%@`]/.test(s) ||
    /^(true|false|null|yes|no|on|off)$/i.test(s) ||
    /^-?\d/.test(s)
  ) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
  }
  return s;
}
