/**
 * Fast-path discovery handlers — list / search / describe / repair.
 *
 * These respond to the agent surface from the manifest alone, with no
 * Commander tree or adapter loader involvement. Each returns true if the
 * fast path took ownership of the call, false to fall through.
 */

import { search } from "../../discovery/search.js";
import {
  buildMacosDynamicCommands,
  discoverMacosDynamicData,
  dynamicMacosDiscoveryEnabled,
} from "../../discovery/macos-dynamic.js";
import { buildDefaultConfig } from "../../engine/repair/config.js";
import {
  resolveOperationAdapterPath,
  resolveOperationTargetSurface,
} from "../../engine/operation-policy.js";
import { readManifest } from "../manifest.js";
import type { ParsedArgv } from "../parsed-argv.js";
import { evaluateManifestOperationPolicy } from "../policy.js";
import {
  argsToJsonSchema,
  buildChannels,
  buildExample,
  emit,
  type Io,
  summarizeArgs,
} from "../render.js";

export function handleList(parsed: ParsedArgv, io: Io): boolean {
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
    .concat(dynamicListRows())
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

function dynamicListRows(): Array<{
  site: string;
  command: string;
  description: string;
  type: string;
  auth: string;
}> {
  if (!dynamicMacosDiscoveryEnabled()) return [];

  return Object.values(
    buildMacosDynamicCommands(discoverMacosDynamicData()),
  ).map((command) => ({
    site: "macos",
    command: command.name,
    description: command.description ?? "",
    type: "desktop",
    auth: "",
  }));
}

export function handleSearch(parsed: ParsedArgv, io: Io): boolean {
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

export function handleDescribe(parsed: ParsedArgv, io: Io): boolean {
  const startedAt = Date.now();
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
  const adapterType = command.type ?? info.commands[0]?.type ?? "web-api";
  const targetSurface = resolveOperationTargetSurface({
    adapterType,
    targetSurface: command.target_surface,
  });
  const adapterPath = resolveOperationAdapterPath(
    site,
    cmdName,
    command.adapter_path,
  );
  const operationPolicy = evaluateManifestOperationPolicy({
    parsed,
    io,
    site,
    commandName: cmdName,
    command,
    adapterType,
    targetSurface,
    adapterPath,
    startedAt,
  });
  if (!operationPolicy) return true;

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
        adapter_path: adapterPath,
        operation_policy: operationPolicy,
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

export function handleRepair(parsed: ParsedArgv, io: Io): boolean {
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
