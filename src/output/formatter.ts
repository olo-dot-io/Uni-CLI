/**
 * Output formatter — renders command results in multiple formats.
 *
 * Formats: table (human), json (agent), yaml, csv, md
 * Auto-detects piped output and switches to json for agent consumption.
 */

import chalk from "chalk";
import Table from "cli-table3";
import type { OutputFormat } from "../types.js";

export function format(
  data: unknown[],
  columns: string[] | undefined,
  fmt: OutputFormat,
): string {
  if (!data || data.length === 0) {
    return fmt === "json" ? "[]" : chalk.dim("No results");
  }

  switch (fmt) {
    case "json":
      return JSON.stringify(data, null, 2);
    case "yaml":
      return toYaml(data);
    case "csv":
      return toCsv(data, columns);
    case "md":
      return toMarkdown(data, columns);
    case "table":
    default:
      return toTable(data, columns);
  }
}

function toTable(data: unknown[], columns?: string[]): string {
  const rows = data as Record<string, unknown>[];
  const cols = columns ?? Object.keys(rows[0] ?? {});

  const table = new Table({
    head: cols.map((c) => chalk.bold.cyan(c)),
    style: { head: [], border: [] },
    wordWrap: true,
  });

  for (const row of rows) {
    table.push(cols.map((c) => truncate(String(row[c] ?? ""), 60)));
  }

  return table.toString();
}

function toCsv(data: unknown[], columns?: string[]): string {
  const rows = data as Record<string, unknown>[];
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const header = cols.join(",");
  const body = rows.map((r) =>
    cols.map((c) => csvEscape(String(r[c] ?? ""))).join(","),
  );
  return [header, ...body].join("\n");
}

function toMarkdown(data: unknown[], columns?: string[]): string {
  const rows = data as Record<string, unknown>[];
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const header = `| ${cols.join(" | ")} |`;
  const separator = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (r) => `| ${cols.map((c) => String(r[c] ?? "")).join(" | ")} |`,
  );
  return [header, separator, ...body].join("\n");
}

function toYaml(data: unknown[]): string {
  return data
    .map((item, i) => {
      const obj = item as Record<string, unknown>;
      const entries = Object.entries(obj)
        .map(([k, v]) => `  ${k}: ${yamlValue(v)}`)
        .join("\n");
      return `- # ${i + 1}\n${entries}`;
    })
    .join("\n");
}

function yamlValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string")
    return v.includes(":") || v.includes("#") ? `"${v}"` : v;
  return String(v);
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Auto-detect if output should be agent-optimized (piped stdout) */
export function detectFormat(explicit?: OutputFormat): OutputFormat {
  if (explicit) return explicit;
  if (!process.stdout.isTTY) return "json";
  return "table";
}
