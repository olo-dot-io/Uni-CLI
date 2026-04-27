/**
 * Fast-path handlers for discovery-only commands.
 *
 * The full Commander tree loads every adapter before it can dispatch. That is
 * correct for execution commands, but wasteful for discovery surfaces that can
 * be answered from the generated manifest and search index.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { search } from "./discovery/search.js";
import { buildDefaultConfig } from "./engine/repair/config.js";
import {
  evaluateOperationPolicy,
  resolveOperationAdapterPath,
  resolveOperationTargetSurface,
} from "./engine/operation-policy.js";
import { format, detectFormat } from "./output/formatter.js";
import type { OutputFormat, TargetSurface } from "./types.js";

type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

type ParsedArgv = {
  command?: string;
  rest: string[];
  format?: OutputFormat;
  dryRun: boolean;
  permissionProfile?: string;
  yes: boolean;
  record: boolean;
};

type ManifestCommand = {
  name: string;
  description?: string;
  strategy?: string;
  type?: string;
  browser?: boolean;
  quarantined?: boolean;
  args?: ManifestArg[];
  columns?: string[];
  pipeline_steps?: number;
  adapter_path?: string;
  target_surface?: TargetSurface;
};

type ManifestArg = {
  name: string;
  type?: "str" | "int" | "float" | "bool";
  default?: unknown;
  required?: boolean;
  positional?: boolean;
  choices?: string[];
  description?: string;
  format?: string;
  "x-unicli-kind"?: string;
  "x-unicli-accepts"?: string[];
};

type Manifest = {
  version: string;
  sites: Record<
    string,
    {
      category?: string;
      commands: ManifestCommand[];
    }
  >;
};

const DEFAULT_IO: Io = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
};

function isOutputFormat(value: string): value is OutputFormat {
  return (
    value === "json" ||
    value === "yaml" ||
    value === "md" ||
    value === "csv" ||
    value === "compact" ||
    value === "table"
  );
}

function jsonSchemaType(type: ManifestArg["type"]): string {
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

function argsToJsonSchema(args: ManifestArg[]): Record<string, unknown> {
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
    additionalProperties: true,
  };
}

function buildExample(args: ManifestArg[]): Record<string, unknown> {
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

function buildChannels(
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

function summarizeArgs(
  args: ManifestArg[] = [],
): Array<Record<string, unknown>> {
  return args.map((arg) => ({
    name: arg.name,
    type: arg.type ?? "str",
    required: arg.required === true,
    positional: arg.positional === true,
  }));
}

function coerceArgValue(value: unknown, type: ManifestArg["type"]): unknown {
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

function resolveDryRunArgs(
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

function parseArgv(argv: string[]): ParsedArgv {
  const args = argv.slice(2);
  let formatValue: OutputFormat | undefined;
  let dryRun = false;
  let permissionProfile: string | undefined;
  let yes = false;
  let record = false;
  let command: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (!command) {
      if (arg === "-f" || arg === "--format") {
        const next = args[i + 1];
        if (next && isOutputFormat(next)) {
          formatValue = next;
          i += 1;
          continue;
        }
      }
      if (arg.startsWith("--format=")) {
        const next = arg.slice("--format=".length);
        if (isOutputFormat(next)) {
          formatValue = next;
          continue;
        }
      }
      if (arg === "--dry-run") {
        dryRun = true;
        continue;
      }
      if (arg === "--permission-profile") {
        permissionProfile = args[i + 1];
        i += 1;
        continue;
      }
      if (arg.startsWith("--permission-profile=")) {
        permissionProfile = arg.slice("--permission-profile=".length);
        continue;
      }
      if (arg === "--yes") {
        yes = true;
        continue;
      }
      if (arg === "--record") {
        record = true;
        continue;
      }
      if (!arg.startsWith("-")) {
        command = arg;
        continue;
      }
      rest.push(arg);
      continue;
    }

    if (arg === "-f" || arg === "--format") {
      const next = args[i + 1];
      if (next && isOutputFormat(next)) {
        formatValue = next;
        i += 1;
        continue;
      }
    }
    if (arg.startsWith("--format=")) {
      const next = arg.slice("--format=".length);
      if (isOutputFormat(next)) {
        formatValue = next;
        continue;
      }
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--permission-profile") {
      permissionProfile = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--permission-profile=")) {
      permissionProfile = arg.slice("--permission-profile=".length);
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--record") {
      record = true;
      continue;
    }
    rest.push(arg);
  }

  return {
    command,
    rest,
    format: formatValue,
    dryRun,
    permissionProfile,
    yes,
    record,
  };
}

function manifestPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "manifest.json"),
    join(here, "..", "dist", "manifest.json"),
    join(here, "..", "..", "dist", "manifest.json"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("Missing dist/manifest.json. Run: npm run build:manifest");
  }
  return found;
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(manifestPath(), "utf8")) as Manifest;
}

function isMissingManifestError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Missing dist/manifest.json")
  );
}

function emit(
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

function handleList(parsed: ParsedArgv, io: Io): boolean {
  const startedAt = Date.now();
  let siteFilter: string | undefined;
  let typeFilter: string | undefined;

  for (let i = 0; i < parsed.rest.length; i += 1) {
    const arg = parsed.rest[i];
    if (arg === "--site") {
      siteFilter = parsed.rest[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--site=")) {
      siteFilter = arg.slice("--site=".length);
      continue;
    }
    if (arg === "--type") {
      typeFilter = parsed.rest[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--type=")) {
      typeFilter = arg.slice("--type=".length);
      continue;
    }
    return false;
  }

  const manifest = readManifest();
  const rows = Object.entries(manifest.sites)
    .flatMap(([site, info]) =>
      info.commands.map((command) => {
        const strategy = command.strategy ?? "public";
        const tags: string[] = [];
        if (strategy !== "public") tags.push("[auth]");
        if (command.quarantined === true) tags.push("[quarantined]");
        return {
          site,
          command: command.name,
          description: command.description ?? "",
          type: command.type ?? "web-api",
          auth: tags.join(" "),
        };
      }),
    )
    .filter((row) => !siteFilter || row.site.includes(siteFilter))
    .filter((row) => !typeFilter || row.type === typeFilter)
    .sort(
      (a, b) =>
        a.site.localeCompare(b.site) || a.command.localeCompare(b.command),
    );

  emit(
    io,
    rows,
    ["site", "command", "description", "type", "auth"],
    parsed.format,
    "core.list",
    startedAt,
  );
  return true;
}

function handleSearch(parsed: ParsedArgv, io: Io): boolean {
  const startedAt = Date.now();
  let limit = 8;
  let category: string | undefined;
  const queryParts: string[] = [];

  for (let i = 0; i < parsed.rest.length; i += 1) {
    const arg = parsed.rest[i];
    if (arg === "-n" || arg === "--limit") {
      limit = parseInt(parsed.rest[i + 1] ?? "", 10) || 8;
      i += 1;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.slice("--limit=".length), 10) || 8;
      continue;
    }
    if (arg === "--category") {
      category = parsed.rest[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--category=")) {
      category = arg.slice("--category=".length);
      continue;
    }
    queryParts.push(arg);
  }

  const query = queryParts.join(" ");
  if (!query && !category) {
    io.stderr(
      "Usage: unicli search <query>  or  unicli search --category <cat>",
    );
    process.exitCode = 2;
    return true;
  }

  const effectiveQuery = category ? `${category} ${query}`.trim() : query;
  const results = search(effectiveQuery, limit);
  if (results.length === 0) {
    io.stderr(`No commands found for: ${effectiveQuery}`);
    process.exitCode = 66;
    return true;
  }

  const rows = results.map((result) => ({
    command: `${result.site} ${result.command}`,
    description: result.description || `${result.command} for ${result.site}`,
    score: result.score,
    category: result.category,
    usage: result.usage,
  }));

  emit(
    io,
    rows,
    ["command", "description", "score", "usage"],
    parsed.format,
    "core.search",
    startedAt,
  );
  return true;
}

function handleDescribe(parsed: ParsedArgv, io: Io): boolean {
  const manifest = readManifest();
  const [site, cmdName] = parsed.rest;

  if (!site) {
    const sites = Object.entries(manifest.sites).map(([name, info]) => ({
      name,
      display_name: name,
      type: info.commands[0]?.type ?? "web-api",
      strategy: info.commands[0]?.strategy ?? "public",
      commands_count: info.commands.length,
      description: "",
    }));
    io.stdout(JSON.stringify({ sites, total: sites.length }, null, 2));
    return true;
  }

  const info = manifest.sites[site];
  if (!info) {
    io.stdout(JSON.stringify({ error: `unknown site: ${site}` }, null, 2));
    process.exitCode = 64;
    return true;
  }

  if (!cmdName) {
    const commands = info.commands.map((command) => ({
      name: command.name,
      description: command.description ?? "",
      quarantined: command.quarantined === true,
      strategy: command.strategy ?? "public",
      auth: (command.strategy ?? "public") !== "public",
      browser: command.browser === true,
      args: summarizeArgs(command.args),
    }));
    io.stdout(
      JSON.stringify(
        {
          site,
          display_name: site,
          type: info.commands[0]?.type ?? "web-api",
          strategy: info.commands[0]?.strategy ?? "public",
          commands,
        },
        null,
        2,
      ),
    );
    return true;
  }

  const command = info.commands.find((candidate) => candidate.name === cmdName);
  if (!command) {
    io.stdout(
      JSON.stringify({ error: `unknown command: ${site} ${cmdName}` }, null, 2),
    );
    process.exitCode = 64;
    return true;
  }
  const targetSurface = resolveOperationTargetSurface({
    adapterType: command.type,
    targetSurface: command.target_surface,
  });

  io.stdout(
    JSON.stringify(
      {
        command: `unicli ${site} ${cmdName}`,
        description: command.description ?? "",
        quarantined: command.quarantined === true,
        strategy: command.strategy ?? "public",
        auth: (command.strategy ?? "public") !== "public",
        browser: command.browser === true,
        target_surface: targetSurface,
        adapter_path: resolveOperationAdapterPath(
          site,
          cmdName,
          command.adapter_path,
        ),
        operation_policy: evaluateOperationPolicy({
          site,
          command: cmdName,
          description: command.description,
          adapterType: command.type,
          targetSurface: command.target_surface,
          strategy: command.strategy,
          browser: command.browser === true,
          args: command.args,
          profile: parsed.permissionProfile,
          approved: parsed.yes,
        }),
        args_schema: argsToJsonSchema(command.args ?? []),
        example_stdin: buildExample(command.args ?? []),
        channels: buildChannels(site, cmdName, command.args ?? []),
        next_actions: [
          {
            command: `unicli ${site} ${cmdName} --dry-run`,
            description: "Preview the resolved argument bag and pipeline plan",
          },
          {
            command: `unicli ${site} ${cmdName}`,
            description: "Run the command (shell channel)",
            params: {
              note: {
                description:
                  "For payloads with quotes/emoji/JSON, pipe stdin-JSON instead.",
              },
            },
          },
          {
            command: `unicli repair ${site} ${cmdName}`,
            description: "If the command fails due to upstream drift",
          },
        ],
      },
      null,
      2,
    ),
  );
  return true;
}

function handleRepair(parsed: ParsedArgv, io: Io): boolean {
  const startedAt = Date.now();
  let dryRun = parsed.dryRun;
  let max = 20;
  let timeout = 90;
  const positionals: string[] = [];

  for (let i = 0; i < parsed.rest.length; i += 1) {
    const arg = parsed.rest[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--max") {
      max = parseInt(parsed.rest[i + 1] ?? "", 10) || 20;
      i += 1;
      continue;
    }
    if (arg.startsWith("--max=")) {
      max = parseInt(arg.slice("--max=".length), 10) || 20;
      continue;
    }
    if (arg === "--timeout") {
      timeout = parseInt(parsed.rest[i + 1] ?? "", 10) || 90;
      i += 1;
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      timeout = parseInt(arg.slice("--timeout=".length), 10) || 90;
      continue;
    }
    if (arg.startsWith("-")) return false;
    positionals.push(arg);
  }

  if (!dryRun) return false;

  const [site, command] = positionals;
  if (!site) return false;
  const config = buildDefaultConfig(site, command);
  config.maxIterations = max;
  config.timeout = timeout * 1000;

  emit(
    io,
    {
      mode: "dry-run",
      site,
      command: command ?? null,
      config: {
        ...config,
        metricPattern: config.metricPattern.source,
      },
    },
    undefined,
    parsed.format,
    "repair.run",
    startedAt,
  );
  return true;
}

function handleAdapterDryRun(parsed: ParsedArgv, io: Io): boolean {
  if (!parsed.command || !parsed.dryRun || parsed.rest.length === 0) {
    return false;
  }

  const manifest = readManifest();
  const info = manifest.sites[parsed.command];
  if (!info) return false;

  const [cmdName, ...tokens] = parsed.rest;
  if (!cmdName || cmdName === "help" || cmdName.startsWith("-")) return false;

  const command = info.commands.find((candidate) => candidate.name === cmdName);
  if (!command) return false;

  const args = resolveDryRunArgs(command.args, tokens);
  if (!args) return false;
  const adapterType = command.type ?? info.commands[0]?.type ?? "web-api";
  const targetSurface = resolveOperationTargetSurface({
    adapterType,
    targetSurface: command.target_surface,
  });
  const adapterPath = resolveOperationAdapterPath(
    parsed.command,
    cmdName,
    command.adapter_path,
  );

  io.stdout(
    JSON.stringify(
      {
        command: `${parsed.command}.${cmdName}`,
        adapter_type: adapterType,
        strategy: command.strategy ?? "public",
        args,
        args_source: tokens.length > 0 ? "shell" : "defaults",
        operation_policy: evaluateOperationPolicy({
          site: parsed.command,
          command: cmdName,
          description: command.description,
          adapterType,
          targetSurface,
          strategy: command.strategy,
          browser: command.browser === true,
          args: command.args,
          profile: parsed.permissionProfile,
          approved: parsed.yes,
        }),
        trace_id: `fast-${Date.now().toString(36)}`,
        surface: "cli",
        target_surface: targetSurface,
        pipeline_steps: command.pipeline_steps ?? 0,
        adapter_path: adapterPath,
      },
      null,
      2,
    ),
  );
  return true;
}

function handleSiteHelp(parsed: ParsedArgv, io: Io): boolean {
  const wantsHelp =
    parsed.rest.length === 0 ||
    parsed.rest.every(
      (arg) => arg === "-h" || arg === "--help" || arg === "help",
    );
  if (!parsed.command || !wantsHelp) return false;

  const manifest = readManifest();
  const info = manifest.sites[parsed.command];
  if (!info) return false;

  const commandWidth = Math.max(
    7,
    ...info.commands.map((command) => command.name.length),
  );
  const lines = [
    `Usage: unicli ${parsed.command} [options] [command]`,
    "",
    `Commands for ${parsed.command}`,
    "",
    "Options:",
    "  -h, --help".padEnd(commandWidth + 6) + "display help for command",
    "",
    "Commands:",
  ];
  for (const command of info.commands) {
    lines.push(
      `  ${command.name.padEnd(commandWidth)}  ${command.description ?? ""}`.trimEnd(),
    );
  }
  lines.push(
    `  ${"help [command]".padEnd(commandWidth)}  display help for command`,
  );
  io.stdout(lines.join("\n"));
  return true;
}

export function tryRunFastPath(
  argv = process.argv,
  io: Io = DEFAULT_IO,
): boolean {
  const parsed = parseArgv(argv);
  try {
    switch (parsed.command) {
      case "list":
        return handleList(parsed, io);
      case "search":
        return handleSearch(parsed, io);
      case "describe":
        return handleDescribe(parsed, io);
      case "repair":
        return handleRepair(parsed, io);
      default:
        return handleAdapterDryRun(parsed, io) || handleSiteHelp(parsed, io);
    }
  } catch (error) {
    if (isMissingManifestError(error)) return false;
    throw error;
  }
}
