/**
 * @owner   src/fast-path/handlers/discovery.ts
 * @does    Serve list/search/describe/repair from the generated manifest without booting Commander or adapters.
 * @needs   ../../discovery/search, ../../discovery/core-catalog, ../../discovery/macos-dynamic, ../manifest, ../render
 * @feeds   src/fast-path.ts
 * @breaks  Sets process.exitCode for invalid args or empty searches; propagates unreadable manifest errors.
 * @invariants Fast-path search shares the canonical scorer and owns only manifest-to-document projection.
 * @side-effects Writes CLI output through Io and may set process.exitCode.
 * @perf    Keeps startup bounded by reading compact manifest data instead of loading adapters.
 * @concurrency No shared mutable state beyond process.exitCode.
 * @test    tests/unit/fast-path.test.ts, tests/unit/search.test.ts
 * @stability Public CLI fast-path discovery behavior.
 * @since   0.223.4
 */

import {
  searchDocuments,
  type CommandSearchDocument,
} from "../../discovery/search.js";
import {
  getCoreDiscoveryCommand,
  listCoreDiscoveryCommands,
  listCoreDiscoverySites,
  type CoreDiscoveryArg,
  type CoreDiscoveryCommand,
} from "../../discovery/core-catalog.js";
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
import { readManifest, type Manifest } from "../manifest.js";
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
  let categoryFilter: string | undefined;

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
    if (arg === "--category") {
      categoryFilter = parsed.rest[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--category=")) {
      categoryFilter = arg.slice("--category=".length);
      continue;
    }
    return false;
  }

  const manifest = readManifest();
  const rows = Object.entries(manifest.sites)
    .flatMap(([site, info]) =>
      info.commands.map((command) => {
        const category = info.category ?? "other";
        const strategy = command.strategy ?? "public";
        const tags: string[] = [];
        if (strategy !== "public") tags.push("[auth]");
        if (command.quarantined === true) tags.push("[quarantined]");
        return {
          site,
          command: command.name,
          description: command.description ?? "",
          category,
          type: command.type ?? "web-api",
          auth: tags.join(" "),
        };
      }),
    )
    .concat(coreListRows())
    .concat(dynamicListRows())
    .filter((row) => !siteFilter || row.site.includes(siteFilter))
    .filter((row) => !categoryFilter || row.category === categoryFilter)
    .filter((row) => !typeFilter || row.type === typeFilter)
    .sort(
      (a, b) =>
        a.site.localeCompare(b.site) || a.command.localeCompare(b.command),
    );

  emit(
    io,
    rows,
    ["site", "command", "description", "category", "type", "auth"],
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
  category: string;
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
    category: "desktop",
    type: "desktop",
    auth: "",
  }));
}

function coreListRows(): Array<{
  site: string;
  command: string;
  description: string;
  category: string;
  type: string;
  auth: string;
}> {
  return listCoreDiscoveryCommands().map((command) => ({
    site: command.site,
    command: command.command,
    description: command.description,
    category: command.category,
    type: command.type,
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

  const effectiveQuery = [category, query].filter(Boolean).join(" ");
  const results = searchDocuments(
    manifestSearchDocuments(readManifest()),
    query,
    limit,
    { category },
  );
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

function manifestSearchDocuments(manifest: Manifest): CommandSearchDocument[] {
  const documents: CommandSearchDocument[] = [];
  const seen = new Set<string>();

  for (const [site, info] of Object.entries(manifest.sites)) {
    for (const command of info.commands) {
      const id = `${site}/${command.name}`;
      seen.add(id);
      documents.push({
        site,
        command: command.name,
        description: command.description ?? "",
        category: info.category,
      });
    }
  }

  for (const command of listCoreDiscoveryCommands()) {
    const id = `${command.site}/${command.command}`;
    if (seen.has(id)) continue;
    documents.push({
      site: command.site,
      command: command.command,
      description: command.description,
      category: command.category,
    });
  }

  return documents;
}

export function handleDescribe(parsed: ParsedArgv, io: Io): boolean {
  const startedAt = Date.now();
  const manifest = readManifest();
  const [site, cmdName] = parsed.rest;

  if (!site) {
    const adapterSites = Object.entries(manifest.sites).map(([name, info]) => ({
      name,
      display_name: name,
      type: info.commands[0]?.type ?? "web-api",
      strategy: info.commands[0]?.strategy ?? "public",
      commands_count: info.commands.length,
      description: "",
    }));
    const sites = adapterSites
      .concat(
        listCoreDiscoverySites().map((coreSite) => ({
          name: coreSite.site,
          display_name: coreSite.site,
          type: coreSite.type,
          strategy: "public",
          commands_count: coreSite.commands.length,
          description: "Core Uni-CLI command group",
        })),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    io.stdout(JSON.stringify({ sites, total: sites.length }, null, 2));
    return true;
  }

  const info = manifest.sites[site];
  if (!info) {
    const coreSite = listCoreDiscoverySites().find(
      (candidate) => candidate.site === site,
    );
    if (coreSite && !cmdName) {
      io.stdout(
        JSON.stringify(
          {
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
              browser: command.type === "browser",
              args: summarizeArgs([...(command.args ?? [])]),
            })),
          },
          null,
          2,
        ),
      );
      return true;
    }
    if (cmdName) {
      const coreCommand = getCoreDiscoveryCommand(site, cmdName);
      if (coreCommand) {
        io.stdout(JSON.stringify(describeCoreCommand(coreCommand), null, 2));
        return true;
      }
    }
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

function describeCoreCommand(
  command: CoreDiscoveryCommand,
): Record<string, unknown> {
  const args = [...(command.args ?? [])] as CoreDiscoveryArg[];
  return {
    command: `unicli ${command.site} ${command.command}`,
    description: command.description,
    quarantined: false,
    strategy: "public",
    auth: false,
    browser: command.type === "browser",
    target_surface: command.target_surface,
    adapter_path: coreCommandSourcePath(command.site),
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
  };
}

function coreCommandSourcePath(site: string): string {
  if (site === "browser") return "src/commands/browser/index.ts";
  return `src/commands/${site}.ts`;
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
