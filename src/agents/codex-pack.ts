/**
 * @owner Uni-CLI Agents
 * @does Builds the compact Codex install pack from CommandContract metadata.
 * @needs Adapter registry snapshots and command-contract projection.
 * @feeds `unicli agents generate --for codex`, docs, and F4 release gates.
 * @breaks Codex onboarding when it enumerates the catalog or exposes expanded MCP by default.
 */

import { buildCommandContract } from "../core/command-contract.js";
import type { AdapterManifest } from "../types.js";

export interface CodexPackInput {
  version: string;
  date: string;
  adapters: AdapterManifest[];
}

export interface CodexSmokeTask {
  name: string;
  command: string;
  proves: string;
}

export interface CodexPack {
  schema_version: "codex-pack.v1";
  package: string;
  version: string;
  date: string;
  default_surface: "native_cli_plus_deferred_mcp";
  counts: {
    sites: number;
    commands: number;
  };
  mcp_config: {
    command: "npx";
    args: string[];
  };
  tool_exposure: {
    default_tools: number;
    deferred_stubs: number;
    expanded_tools: number;
    expanded_opt_in: true;
  };
  contract_summary: {
    schema_version: "command-contract.v1";
    read_only: number;
    write_or_destructive: number;
    auth_required: number;
    browser_backed: number;
    artifact_producers: number;
  };
  deferred_toolsearch: {
    source: "CommandContract";
    tool_name_pattern: "unicli_<site>_<command>";
    loaded_fields: string[];
    full_schema_resolution: "tools/call via expandedRegistry";
  };
  smoke_tasks: CodexSmokeTask[];
  token_budget: {
    method: "heuristic-o200k";
    estimated_tokens: number;
    chars: number;
  };
}

function estimateTokens(input: string): CodexPack["token_budget"] {
  const chars = input.length;
  const words =
    input.trim().length === 0 ? 0 : input.trim().split(/\s+/).length;
  return {
    method: "heuristic-o200k",
    estimated_tokens: Math.max(Math.ceil(chars / 3.6), Math.ceil(words / 0.75)),
    chars,
  };
}

function commandEntries(adapters: AdapterManifest[]): Array<{
  adapter: AdapterManifest;
  commandName: string;
}> {
  return adapters.flatMap((adapter) => {
    return Object.keys(adapter.commands).map((commandName) => ({
      adapter,
      commandName,
    }));
  });
}

function buildContractSummary(
  adapters: AdapterManifest[],
): CodexPack["contract_summary"] {
  const summary: CodexPack["contract_summary"] = {
    schema_version: "command-contract.v1",
    read_only: 0,
    write_or_destructive: 0,
    auth_required: 0,
    browser_backed: 0,
    artifact_producers: 0,
  };

  for (const { adapter, commandName } of commandEntries(adapters)) {
    const command = adapter.commands[commandName];
    if (!command) continue;
    const contract = buildCommandContract({ adapter, commandName, command });
    if (contract.effect.read_only) summary.read_only++;
    else summary.write_or_destructive++;
    if (contract.auth.required) summary.auth_required++;
    if (contract.effect.browser) summary.browser_backed++;
    if (contract.artifacts.produces_files) summary.artifact_producers++;
  }

  return summary;
}

function codexPackWithoutBudget(
  input: CodexPackInput,
): Omit<CodexPack, "token_budget"> {
  const commands = commandEntries(input.adapters).length;
  return {
    schema_version: "codex-pack.v1",
    package: "@zenalexa/unicli",
    version: input.version,
    date: input.date,
    default_surface: "native_cli_plus_deferred_mcp",
    counts: {
      sites: input.adapters.length,
      commands,
    },
    mcp_config: {
      command: "npx",
      args: ["-y", "@zenalexa/unicli", "mcp", "serve", "--profile", "deferred"],
    },
    tool_exposure: {
      default_tools: 4,
      deferred_stubs: commands,
      expanded_tools: commands + 4,
      expanded_opt_in: true,
    },
    contract_summary: buildContractSummary(input.adapters),
    deferred_toolsearch: {
      source: "CommandContract",
      tool_name_pattern: "unicli_<site>_<command>",
      loaded_fields: [
        "identity.site",
        "identity.command",
        "description",
        "schemas.input",
        "effect",
        "auth",
        "repair",
      ],
      full_schema_resolution: "tools/call via expandedRegistry",
    },
    smoke_tasks: [
      {
        name: "catalog discovery",
        command: 'unicli search "hackernews top stories"',
        proves: "native CLI remains the primary low-context entry point",
      },
      {
        name: "mcp health",
        command: "unicli mcp health --json",
        proves: "local registry loads before Codex attaches MCP",
      },
      {
        name: "deferred MCP",
        command: "npx -y @zenalexa/unicli mcp serve --profile deferred",
        proves: "Codex sees ToolSearch-ready stubs instead of expanded schemas",
      },
    ],
  };
}

export function formatCodexPack(pack: CodexPack): string {
  const tomlArgs = `[${pack.mcp_config.args
    .map((arg) => JSON.stringify(arg))
    .join(", ")}]`;
  const lines = [
    "# Codex Uni-CLI Pack",
    "",
    "Use native CLI first for command execution; attach deferred MCP for ToolSearch discovery.",
    "",
    "```toml",
    "[mcp_servers.unicli]",
    `command = ${JSON.stringify(pack.mcp_config.command)}`,
    `args = ${tomlArgs}`,
    "```",
    "",
    "## Contract",
    "",
    `- Source: CommandContract (${pack.contract_summary.schema_version})`,
    `- Sites: ${pack.counts.sites}`,
    `- Commands: ${pack.counts.commands}`,
    `- Read-only: ${pack.contract_summary.read_only}`,
    `- Write/destructive: ${pack.contract_summary.write_or_destructive}`,
    `- Auth required: ${pack.contract_summary.auth_required}`,
    `- Browser-backed: ${pack.contract_summary.browser_backed}`,
    "",
    "## Tool Exposure",
    "",
    `- Default tools: ${pack.tool_exposure.default_tools}`,
    `- Deferred stubs: ${pack.tool_exposure.deferred_stubs}`,
    `- Expanded tools: ${pack.tool_exposure.expanded_tools} (explicit opt-in only)`,
    `- Tool pattern: ${pack.deferred_toolsearch.tool_name_pattern}`,
    "",
    "## Smoke",
    "",
    ...pack.smoke_tasks.map((task) => {
      return `- ${task.command} — ${task.proves}`;
    }),
    "",
    "## Budget",
    "",
    `- Estimated pack tokens: ${pack.token_budget.estimated_tokens}`,
    `- Method: ${pack.token_budget.method}`,
    "",
  ];
  return lines.join("\n");
}

export function buildCodexPack(input: CodexPackInput): CodexPack {
  const base = codexPackWithoutBudget(input);
  const content = formatCodexPack({
    ...base,
    token_budget: { method: "heuristic-o200k", estimated_tokens: 0, chars: 0 },
  });
  return { ...base, token_budget: estimateTokens(content) };
}
