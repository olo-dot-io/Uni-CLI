/**
 * Argv tokenisation, schema generation, and envelope rendering helpers
 * shared by every fast-path handler.
 *
 * Pure utilities only — no manifest or policy IO. Handlers compose these
 * with `manifest.ts` and `policy.ts`.
 */

import { writeSync } from "node:fs";
import { format, detectFormat } from "../output/formatter.js";
import { type OutputFormat } from "../types.js";
import type { ManifestArg } from "./manifest.js";

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export const DEFAULT_IO: Io = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

export function emitStderrAndExit(io: Io, text: string, code: number): void {
  if (io === DEFAULT_IO) {
    writeSync(process.stderr.fd, `${text}\n`);
    process.exit(code);
  }
  io.stderr(text);
  process.exitCode = code;
}

export function isOutputFormat(value: string): value is OutputFormat {
  return (
    value === "json" ||
    value === "yaml" ||
    value === "md" ||
    value === "csv" ||
    value === "compact" ||
    value === "table"
  );
}

export function isHelpToken(value: string): boolean {
  return value === "-h" || value === "--help" || value === "help";
}

export function jsonSchemaType(type: ManifestArg["type"]): string {
  switch (type) {
    case "int":
      return "integer";
    case "float":
      return "number";
    case "bool":
      return "boolean";
    default:
      return "string";
  }
}

export function argsToJsonSchema(args: ManifestArg[]): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];

  for (const arg of args) {
    const prop: Record<string, unknown> = {
      type: jsonSchemaType(arg.type),
    };
    if (arg.description) prop.description = arg.description;
    if (arg.default !== undefined) prop.default = arg.default;
    if (arg.choices && arg.choices.length > 0) prop.enum = arg.choices;
    if (arg.format) prop.format = arg.format;
    if (arg["x-unicli-kind"]) prop["x-unicli-kind"] = arg["x-unicli-kind"];
    if (arg["x-unicli-accepts"]) {
      prop["x-unicli-accepts"] = arg["x-unicli-accepts"];
    }
    properties[arg.name] = prop;
    if (arg.required) required.push(arg.name);
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function buildExample(args: ManifestArg[]): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  for (const arg of args) {
    if (arg.default !== undefined) {
      example[arg.name] = arg.default;
      continue;
    }
    if (arg.choices && arg.choices.length > 0) {
      example[arg.name] = arg.choices[0];
      continue;
    }
    switch (arg.type) {
      case "int":
        example[arg.name] = 10;
        break;
      case "float":
        example[arg.name] = 0.5;
        break;
      case "bool":
        example[arg.name] = false;
        break;
      default:
        example[arg.name] = `<${arg.name}>`;
    }
  }
  return example;
}

export function buildChannels(
  site: string,
  command: string,
  args: ManifestArg[],
): Record<string, string> {
  const positionals = args
    .filter((arg) => arg.positional)
    .map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name}]`))
    .join(" ");
  const options = args
    .filter((arg) => !arg.positional)
    .map((arg) => `[--${arg.name} <${arg.type ?? "value"}>]`)
    .join(" ");
  const shell =
    `unicli ${site} ${command}` +
    (positionals ? ` ${positionals}` : "") +
    (options ? ` ${options}` : "");

  return {
    shell: shell.trim(),
    args_file: `unicli ${site} ${command} --args-file <path.json>`,
    stdin: `echo '{...}' | unicli ${site} ${command}`,
  };
}

export function summarizeArgs(
  args: ManifestArg[] = [],
): Array<Record<string, unknown>> {
  return args.map((arg) => ({
    name: arg.name,
    type: arg.type ?? "str",
    required: arg.required === true,
    positional: arg.positional === true,
  }));
}

export function coerceArgValue(
  value: unknown,
  type: ManifestArg["type"],
): unknown {
  if (type === "int") {
    const parsed = parseInt(String(value), 10);
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (type === "float") {
    const parsed = parseFloat(String(value));
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (type === "bool") {
    if (typeof value === "boolean") return value;
    const text = String(value).toLowerCase();
    return text === "1" || text === "true" || text === "yes";
  }
  return value;
}

export function resolveDryRunArgs(
  schema: ManifestArg[] = [],
  tokens: string[],
): Record<string, unknown> | null {
  const values: Record<string, unknown> = {};
  for (const arg of schema) {
    if (arg.default !== undefined) values[arg.name] = arg.default;
  }

  const positionals = schema.filter((arg) => arg.positional);
  let positionalIndex = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const name =
        eqIdx === -1 ? token.slice(2) : token.slice(2, Math.max(2, eqIdx));
      const arg = schema.find((candidate) => candidate.name === name);
      if (!arg) {
        if (eqIdx === -1 && tokens[i + 1] && !tokens[i + 1].startsWith("-")) {
          i += 1;
        }
        continue;
      }

      let raw: unknown;
      if (arg.type === "bool" && eqIdx === -1) {
        raw = true;
      } else if (eqIdx !== -1) {
        raw = token.slice(eqIdx + 1);
      } else {
        raw = tokens[i + 1];
        i += 1;
      }
      values[arg.name] = coerceArgValue(raw, arg.type);
      continue;
    }

    const arg = positionals[positionalIndex];
    if (arg) {
      values[arg.name] = coerceArgValue(token, arg.type);
      positionalIndex += 1;
    }
  }

  for (const arg of schema) {
    if (arg.required && values[arg.name] === undefined) return null;
  }

  return values;
}

export function emit(
  io: Io,
  data: unknown[] | Record<string, unknown>,
  columns: string[] | undefined,
  fmt: OutputFormat | undefined,
  command: string,
  startedAt: number,
): void {
  io.stdout(
    format(data, columns, detectFormat(fmt), {
      command,
      duration_ms: Date.now() - startedAt,
      surface: "web",
    }),
  );
}
