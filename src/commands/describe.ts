/**
 * `unicli describe [site] [command]` — runtime schema introspection so
 * agents can learn what a command accepts without blowing context budget
 * on stale markdown docs. Mirrors Poehnelt's `gws schema` pattern (Google
 * Workspace CLI, 2026-03) and joelclaw's self-documenting root command.
 *
 * Output shapes:
 *   unicli describe                → {sites: [{name, commands_count, ...}]}
 *   unicli describe <site>         → {site, commands: [{name, ...}]}
 *   unicli describe <site> <cmd>   → concise executable contract
 *   unicli describe <site> <cmd> --full → full policy + command contract
 *
 * Every wire format is derived from the same payload. The concise command
 * view is sufficient to invoke and recover; --full exposes audit detail.
 */

import { Command } from "commander";
import {
  commandRequiresAuth,
  commandStrategy,
  commandUsesBrowser,
  getAdapter,
  getAllAdapters,
  resolveCommand,
} from "../registry.js";
import {
  evaluateOperationPolicy,
  resolveOperationAdapterPath,
  resolveOperationTargetSurface,
} from "../engine/operation-policy.js";
import {
  buildCommandContract,
  buildCoreCommandContract,
} from "../core/command-contract.js";
import {
  getCoreDiscoveryCommand,
  listCoreDiscoverySites,
  type CoreDiscoveryArg,
  type CoreDiscoveryCommand,
} from "../discovery/core-catalog.js";
import { ExitCode } from "../types.js";
import { detectFormat } from "../output/formatter.js";
import { makeCtx, type AgentError } from "../output/envelope.js";
import {
  formatDescribeError,
  formatDescribePayload,
  nearestDescribeNames,
  summarizeDescribePayload,
} from "../output/describe.js";
import type {
  AdapterArg,
  AdapterCommand,
  AdapterManifest,
  OutputFormat,
  OutputSchema,
} from "../types.js";

interface JsonSchemaProperty {
  type: string | string[];
  items?: { type: string };
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  format?: AdapterArg["format"];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  "x-unicli-kind"?: AdapterArg["x-unicli-kind"];
  "x-unicli-accepts"?: AdapterArg["x-unicli-accepts"];
  "x-unicli-uri-origins"?: AdapterArg["x-unicli-uri-origins"];
  "x-unicli-uri-path-pattern"?: AdapterArg["x-unicli-uri-path-pattern"];
}

interface JsonSchema {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: boolean;
}

type DescribeArg = AdapterArg | CoreDiscoveryArg;

export interface DescribeResult {
  payload: Record<string, unknown>;
  exit: number;
  error?: AgentError;
}

/** Map command-arg type tokens to JSON Schema `type` strings. */
function jsonSchemaType(t: DescribeArg["type"]): string | string[] {
  switch (t) {
    case "int":
      return "integer";
    case "float":
      return "number";
    case "bool":
      return "boolean";
    case "str[]":
      return "array";
    case "nullable-float":
      return ["number", "null"];
    case "str-or-int":
      return ["string", "integer"];
    default:
      return "string";
  }
}

/** Build a JSON Schema draft-2020-12 document from adapter args. */
function argsToJsonSchema(args: DescribeArg[]): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const a of args) {
    const prop: JsonSchemaProperty = { type: jsonSchemaType(a.type) };
    if (a.type === "str[]") prop.items = { type: "string" };
    if (a.description) prop.description = a.description;
    if (a.default !== undefined) prop.default = a.default;
    if (a.choices && a.choices.length > 0) prop.enum = a.choices;
    // v0.213.3 Phase 4 — surface schema-v2 hardening tokens to agents. The
    // kernel's ajv validator keys off `format:`; `x-unicli-kind` /
    // `x-unicli-accepts` are annotations adapters declare and describe
    // surfaces so agents see the full contract before invocation.
    if (a.format) prop.format = a.format;
    if (a.minLength !== undefined) prop.minLength = a.minLength;
    if (a.maxLength !== undefined) prop.maxLength = a.maxLength;
    if (a.minimum !== undefined) prop.minimum = a.minimum;
    if (a.maximum !== undefined) prop.maximum = a.maximum;
    if (a.pattern !== undefined) prop.pattern = a.pattern;
    if (a["x-unicli-kind"]) prop["x-unicli-kind"] = a["x-unicli-kind"];
    if (a["x-unicli-accepts"]) prop["x-unicli-accepts"] = a["x-unicli-accepts"];
    if (a["x-unicli-uri-origins"])
      prop["x-unicli-uri-origins"] = a["x-unicli-uri-origins"];
    if (a["x-unicli-uri-path-pattern"])
      prop["x-unicli-uri-path-pattern"] = a["x-unicli-uri-path-pattern"];
    properties[a.name] = prop;
    if (a.required) required.push(a.name);
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

/** Produce a realistic example payload agents can copy / modify. */
function buildExample(args: DescribeArg[]): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  for (const a of args) {
    if (a.default !== undefined) {
      example[a.name] = a.default;
    } else if (a.choices && a.choices.length > 0) {
      example[a.name] = a.choices[0];
    } else {
      switch (a.type) {
        case "int":
          example[a.name] = 10;
          break;
        case "float":
          example[a.name] = 0.5;
          break;
        case "bool":
          example[a.name] = false;
          break;
        case "str[]":
          example[a.name] = [];
          break;
        case "nullable-float":
          example[a.name] = null;
          break;
        case "str-or-int":
          example[a.name] = `<${a.name}>`;
          break;
        default:
          example[a.name] = `<${a.name}>`;
      }
    }
  }
  return example;
}

/** Synthesize the three invocation-channel templates. */
function buildChannels(
  site: string,
  cmdName: string,
  args: DescribeArg[],
): Record<string, string> {
  const positionals = args
    .filter((a) => a.positional)
    .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
    .join(" ");
  const options = args
    .filter((a) => !a.positional)
    .map((a) => `[--${a.name} <${a.type ?? "value"}>]`)
    .join(" ");
  const shell =
    `unicli ${site} ${cmdName}` +
    (positionals ? " " + positionals : "") +
    (options ? " " + options : "");
  return {
    shell: shell.trim(),
    args_file: `unicli ${site} ${cmdName} --args-file <path.json>`,
    stdin: `echo '{...}' | unicli ${site} ${cmdName}`,
  };
}

/** Normalize OutputSchema into a plain JSON-serializable object. */
function serializeOutputSchema(
  output?: string | OutputSchema,
): Record<string, unknown> | string | undefined {
  if (output === undefined) return undefined;
  if (typeof output === "string") return output;
  return { ...output };
}

/** Default next_actions shown to the agent when they land on a command. */
function defaultNextActions(
  site: string,
  cmdName: string,
): Array<Record<string, unknown>> {
  return [
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
  ];
}

function coreCommandUsesBrowser(command: CoreDiscoveryCommand): boolean {
  return command.type === "browser";
}

function describeCoreCommand(
  command: CoreDiscoveryCommand,
): Record<string, unknown> {
  const args = [...(command.args ?? [])];
  const contract = buildCoreCommandContract({ command });
  return {
    command: `unicli ${command.site} ${command.command}`,
    description: command.description,
    quarantined: false,
    strategy: "public",
    auth: false,
    browser: coreCommandUsesBrowser(command),
    target_surface: contract.effect.target_surface,
    ...(contract.identity.source_path
      ? { source_path: contract.identity.source_path }
      : {}),
    args_schema: argsToJsonSchema(args),
    example_stdin: buildExample(args),
    channels:
      command.channels ?? buildChannels(command.site, command.command, args),
    next_actions: [
      {
        command: `unicli ${command.site} ${command.command} --help`,
        description: "Inspect the Commander help for exact shell flags",
      },
      {
        command: `unicli ${command.site} ${command.command}`,
        description: "Run the core command",
      },
    ],
    contract,
  };
}

function describeCoreSite(site: string): Record<string, unknown> | undefined {
  const coreSite = listCoreDiscoverySites().find(
    (candidate) => candidate.site === site,
  );
  if (!coreSite) return undefined;
  return {
    site,
    display_name: site,
    type: coreSite.type,
    strategy: "public",
    commands: coreSite.commands.map((command) => ({
      name: command.command,
      description: command.description,
      quarantined: false,
      strategy: "public",
      auth: false,
      browser: coreCommandUsesBrowser(command),
      args: (command.args ?? []).map((arg) => ({
        name: arg.name,
        type: arg.type ?? "str",
        required: arg.required === true,
        positional: arg.positional === true,
      })),
    })),
  };
}

/** Full describe payload for a single command. */
export function describeCommand(
  site: string,
  cmdName: string,
  cmd: AdapterCommand,
  adapter?: AdapterManifest,
): Record<string, unknown> {
  const args = cmd.adapterArgs ?? [];
  const contract = adapter
    ? buildCommandContract({ adapter, commandName: cmdName, command: cmd })
    : undefined;
  const strategy = adapter ? commandStrategy(adapter, cmd) : undefined;
  const targetSurface = resolveOperationTargetSurface({
    adapterType: adapter?.type,
    targetSurface: cmd.target_surface,
  });
  const metadata = adapter
    ? {
        strategy: strategy ?? "public",
        auth: commandRequiresAuth(adapter, cmd),
        browser: commandUsesBrowser(adapter, cmd),
        target_surface: targetSurface,
        adapter_path: resolveOperationAdapterPath(
          site,
          cmdName,
          cmd.adapter_path,
        ),
      }
    : {};
  const operationPolicy = evaluateOperationPolicy({
    site,
    command: cmdName,
    description: cmd.description,
    adapterType: adapter?.type,
    targetSurface,
    strategy,
    browser: adapter ? commandUsesBrowser(adapter, cmd) : cmd.browser === true,
    args,
    effect: cmd.operation_effect,
  });
  return {
    command: `unicli ${site} ${cmdName}`,
    description: cmd.description ?? "",
    quarantined: cmd.quarantine === true,
    ...metadata,
    operation_policy: operationPolicy,
    args_schema: argsToJsonSchema(args),
    example_stdin: buildExample(args),
    output_schema: serializeOutputSchema(cmd.output),
    channels: buildChannels(site, cmdName, args),
    next_actions: defaultNextActions(site, cmdName),
    ...(contract ? { contract } : {}),
  };
}

function commandNamesForSite(site: string): string[] {
  const adapterNames = Object.keys(getAdapter(site)?.commands ?? {});
  const coreNames =
    listCoreDiscoverySites()
      .find((candidate) => candidate.site === site)
      ?.commands.map((command) => command.command) ?? [];
  return [...new Set([...adapterNames, ...coreNames])];
}

function allSiteNames(): string[] {
  return [
    ...new Set([
      ...getAllAdapters().map((adapter) => adapter.name),
      ...listCoreDiscoverySites().map((site) => site.site),
    ]),
  ];
}

function unknownSiteResult(site: string, cmdName?: string): DescribeResult {
  const sites = nearestDescribeNames(site, allSiteNames());
  const alternatives = sites.map((candidate) => {
    const hasCommand = cmdName
      ? commandNamesForSite(candidate).includes(cmdName)
      : false;
    return `unicli describe ${candidate}${hasCommand ? ` ${cmdName}` : ""}`;
  });
  const message = `unknown site: ${site}`;
  return {
    payload: { error: message, alternatives },
    exit: ExitCode.USAGE_ERROR,
    error: {
      code: "not_found",
      message,
      suggestion:
        alternatives.length > 0
          ? "Use the closest registered site below."
          : "Run `unicli search <intent>` to resolve a registered command.",
      retryable: false,
      alternatives:
        alternatives.length > 0 ? alternatives : ["unicli search <intent>"],
    },
  };
}

function unknownCommandResult(site: string, cmdName: string): DescribeResult {
  const alternatives = nearestDescribeNames(
    cmdName,
    commandNamesForSite(site),
  ).map((candidate) => `unicli describe ${site} ${candidate}`);
  const message = `unknown command: ${site} ${cmdName}`;
  return {
    payload: { error: message, alternatives },
    exit: ExitCode.USAGE_ERROR,
    error: {
      code: "not_found",
      message,
      suggestion:
        alternatives.length > 0
          ? "Use the closest command below."
          : `Run \`unicli describe ${site}\` to inspect this site's commands.`,
      retryable: false,
      alternatives:
        alternatives.length > 0 ? alternatives : [`unicli describe ${site}`],
    },
  };
}

/** Top-level describe payload: root / site / command, driven by arg count. */
export function describe(
  site: string | undefined,
  cmdName: string | undefined,
): DescribeResult {
  if (!site) {
    const adapters = getAllAdapters();
    const adapterNames = new Set(adapters.map((adapter) => adapter.name));
    const sites: Array<{
      name: string;
      display_name: string;
      type: string;
      strategy: string;
      commands_count: number;
      description: string;
    }> = [
      ...adapters.map((a) => ({
        name: a.name,
        display_name: a.displayName ?? a.name,
        type: a.type,
        strategy: a.strategy ?? "public",
        commands_count: Object.keys(a.commands).length,
        description: a.description ?? "",
      })),
      ...listCoreDiscoverySites()
        .filter((coreSite) => !adapterNames.has(coreSite.site))
        .map((coreSite) => ({
          name: coreSite.site,
          display_name: coreSite.site,
          type: coreSite.type,
          strategy: "public",
          commands_count: coreSite.commands.length,
          description: "Core Uni-CLI commands",
        })),
    ];
    return {
      payload: { sites, total: sites.length },
      exit: ExitCode.SUCCESS,
    };
  }

  const adapter = getAdapter(site);
  if (!adapter) {
    if (!cmdName) {
      const corePayload = describeCoreSite(site);
      if (corePayload) {
        return { payload: corePayload, exit: ExitCode.SUCCESS };
      }
    }
    if (cmdName) {
      const coreCommand = getCoreDiscoveryCommand(site, cmdName);
      if (coreCommand) {
        return {
          payload: describeCoreCommand(coreCommand),
          exit: ExitCode.SUCCESS,
        };
      }
    }
    return unknownSiteResult(site, cmdName);
  }

  if (!cmdName) {
    const commands = Object.entries(adapter.commands).map(([name, cmd]) => ({
      name,
      description: cmd.description ?? "",
      quarantined: cmd.quarantine === true,
      strategy: commandStrategy(adapter, cmd) ?? "public",
      auth: commandRequiresAuth(adapter, cmd),
      browser: commandUsesBrowser(adapter, cmd),
      args: (cmd.adapterArgs ?? []).map((a) => ({
        name: a.name,
        type: a.type ?? "str",
        required: a.required === true,
        positional: a.positional === true,
      })),
    }));
    return {
      payload: {
        site,
        display_name: adapter.displayName ?? adapter.name,
        type: adapter.type,
        strategy: adapter.strategy ?? "public",
        commands,
      },
      exit: ExitCode.SUCCESS,
    };
  }

  const resolved = resolveCommand(site, cmdName);
  if (!resolved) {
    const coreCommand = getCoreDiscoveryCommand(site, cmdName);
    if (coreCommand) {
      return {
        payload: describeCoreCommand(coreCommand),
        exit: ExitCode.SUCCESS,
      };
    }
    return unknownCommandResult(site, cmdName);
  }

  return {
    payload: describeCommand(site, cmdName, resolved.command, resolved.adapter),
    exit: ExitCode.SUCCESS,
  };
}

/** Commander wiring. */
export function registerDescribeCommand(program: Command): void {
  program
    .command("describe [site] [command]")
    .description(
      "Print JSON Schema + example payload for a command (agents: read this instead of --help)",
    )
    .option(
      "--full",
      "include full governance, approval, evaluation, and repair contract detail",
      false,
    )
    .action(
      (
        site: string | undefined,
        cmdName: string | undefined,
        opts: { full?: boolean },
      ) => {
        const startedAt = Date.now();
        const result = describe(site, cmdName);
        const fmt = detectFormat(
          program.opts().format as OutputFormat | undefined,
        );
        const ctx = makeCtx("core.describe", startedAt);
        ctx.duration_ms = Date.now() - startedAt;

        if (result.error) {
          ctx.error = result.error;
          ctx.next_actions = (result.error.alternatives ?? []).map(
            (command) => ({
              command,
              description: "Inspect the closest registered describe target",
            }),
          );
          process.exitCode = result.exit;
          process.stderr.write(
            `${formatDescribeError(result.error, fmt, ctx)}\n`,
          );
          return;
        }

        const payload = opts.full
          ? result.payload
          : summarizeDescribePayload(result.payload);
        if (fmt === "table") {
          process.stderr.write(
            "[deprecated] `-f table` → `md`. Migrate before v0.215.\n",
          );
        }
        process.stdout.write(`${formatDescribePayload(payload, fmt, ctx)}\n`);
      },
    );
}
