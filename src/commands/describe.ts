/**
 * `unicli describe [site] [command]` — runtime schema introspection so
 * agents can learn what a command accepts without blowing context budget
 * on stale markdown docs. Mirrors Poehnelt's `gws schema` pattern (Google
 * Workspace CLI, 2026-03) and joelclaw's self-documenting root command.
 *
 * Output shapes:
 *   unicli describe                → {sites: [{name, commands_count, ...}]}
 *   unicli describe <site>         → {site, commands: [{name, ...}]}
 *   unicli describe <site> <cmd>   → full Command schema + channels + example
 *
 * The per-command JSON blob IS the contract. If the agent can read this,
 * it can craft a correct invocation without any out-of-band docs.
 */

import { Command } from "commander";
import { getAdapter, getAllAdapters, resolveCommand } from "../registry.js";
import { ExitCode } from "../types.js";
import type { AdapterArg, AdapterCommand, OutputSchema } from "../types.js";

interface JsonSchemaProperty {
  type: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: AdapterArg["format"];
  "x-unicli-kind"?: AdapterArg["x-unicli-kind"];
  "x-unicli-accepts"?: AdapterArg["x-unicli-accepts"];
}

interface JsonSchema {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: boolean;
}

/** Map adapter-arg type tokens to JSON Schema `type` strings. */
function jsonSchemaType(t: AdapterArg["type"]): string {
  switch (t) {
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

/** Build a JSON Schema draft-2020-12 document from adapter args. */
function argsToJsonSchema(args: AdapterArg[]): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const a of args) {
    const prop: JsonSchemaProperty = { type: jsonSchemaType(a.type) };
    if (a.description) prop.description = a.description;
    if (a.default !== undefined) prop.default = a.default;
    if (a.choices && a.choices.length > 0) prop.enum = a.choices;
    // v0.213.3 Phase 4 — surface schema-v2 hardening tokens to agents. The
    // kernel's ajv validator keys off `format:`; `x-unicli-kind` /
    // `x-unicli-accepts` are annotations adapters declare and describe
    // surfaces so agents see the full contract before invocation.
    if (a.format) prop.format = a.format;
    if (a["x-unicli-kind"]) prop["x-unicli-kind"] = a["x-unicli-kind"];
    if (a["x-unicli-accepts"]) prop["x-unicli-accepts"] = a["x-unicli-accepts"];
    properties[a.name] = prop;
    if (a.required) required.push(a.name);
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    required,
    additionalProperties: true, // agents should be allowed to pass new fields
  };
}

/** Produce a realistic example payload agents can copy / modify. */
function buildExample(args: AdapterArg[]): Record<string, unknown> {
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
  args: AdapterArg[],
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

/** Full describe payload for a single command. */
export function describeCommand(
  site: string,
  cmdName: string,
  cmd: AdapterCommand,
): Record<string, unknown> {
  const args = cmd.adapterArgs ?? [];
  return {
    command: `unicli ${site} ${cmdName}`,
    description: cmd.description ?? "",
    quarantined: cmd.quarantine === true,
    args_schema: argsToJsonSchema(args),
    example_stdin: buildExample(args),
    output_schema: serializeOutputSchema(cmd.output),
    channels: buildChannels(site, cmdName, args),
    next_actions: defaultNextActions(site, cmdName),
  };
}

/** Top-level describe payload: root / site / command, driven by arg count. */
export function describe(
  site: string | undefined,
  cmdName: string | undefined,
): { payload: Record<string, unknown>; exit: number } {
  if (!site) {
    const sites = getAllAdapters().map((a) => ({
      name: a.name,
      display_name: a.displayName ?? a.name,
      type: a.type,
      strategy: a.strategy ?? "public",
      commands_count: Object.keys(a.commands).length,
      description: a.description ?? "",
    }));
    return {
      payload: { sites, total: sites.length },
      exit: ExitCode.SUCCESS,
    };
  }

  const adapter = getAdapter(site);
  if (!adapter) {
    return {
      payload: { error: `unknown site: ${site}` },
      exit: ExitCode.USAGE_ERROR,
    };
  }

  if (!cmdName) {
    const commands = Object.entries(adapter.commands).map(([name, cmd]) => ({
      name,
      description: cmd.description ?? "",
      quarantined: cmd.quarantine === true,
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
    return {
      payload: { error: `unknown command: ${site} ${cmdName}` },
      exit: ExitCode.USAGE_ERROR,
    };
  }

  return {
    payload: describeCommand(site, cmdName, resolved.command),
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
    .action((site: string | undefined, cmdName: string | undefined) => {
      const { payload, exit } = describe(site, cmdName);
      console.log(JSON.stringify(payload, null, 2));
      process.exit(exit);
    });
}
