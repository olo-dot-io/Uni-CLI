/**
 * @owner       src::fast-path::manifest
 * @does        Loads and types the compact generated manifest used by discovery without booting Commander.
 * @needs       node fs/path/url, generated dist/manifest.json, and shared target-surface types
 * @feeds       fast-path list, search, describe, repair, and command-contract projection
 * @breaks      Omitting authentication or retrieval metadata makes fast-path discovery disagree with the live adapter registry.
 * @invariants  Loading is side-effect free; absence returns undefined for caller-controlled fallback; declared command metadata is preserved verbatim.
 * @side-effects Reads one generated JSON file when present.
 * @perf        One bounded synchronous manifest read and parse per process cache fill.
 * @concurrency Module state contains only the parsed immutable manifest cache.
 * @test        tests/unit/fast-path.test.ts
 * @stability   stable
 * @since       2026-04-01
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { normalizeYamlAdapterDocument } from "../core/yaml-adapter.js";
import type {
  AdapterArg,
  AdapterCommand,
  BrowserSessionPreference,
  ExecutionOperator,
  OperationEffect,
  PipelineStep,
  RetrievalMetadata,
  TargetSurface,
} from "../types.js";

export type ManifestArg = AdapterArg;

export type ManifestCommand = {
  name: string;
  description?: string;
  strategy?: string;
  type?: string;
  domain?: string;
  base?: string;
  browser?: boolean;
  browserSession?: BrowserSessionPreference;
  quarantined?: boolean;
  args?: ManifestArg[];
  columns?: string[];
  defaultFormat?: string;
  capabilities?: string[];
  auth_requirement?: "required" | "optional" | "none";
  executables?: string[];
  minimum_capability?: string;
  pipeline_steps?: number;
  paginated?: boolean;
  retrieval?: RetrievalMetadata;
  output?: AdapterCommand["output"];
  stream?: boolean;
  adapter_path?: string;
  target_surface?: TargetSurface;
  operation_effect?: OperationEffect;
  execution_operator?: ExecutionOperator;
  operation_family?: AdapterCommand["operation_family"];
  idempotency?: AdapterCommand["idempotency"];
  /**
   * Canonical effect decision produced from the complete live command. The
   * generated read model keeps this compact decision instead of copying
   * executable pipelines into dist/manifest.json.
   */
  effect_projection?: {
    operation_effect: OperationEffect;
    effect_source: "declared" | "heuristic" | "default";
    effect_confidence: "high" | "medium" | "low";
  };
  /** User overlays retain policy-only source inputs because they are parsed at runtime. */
  method?: AdapterCommand["method"];
  pipeline?: PipelineStep[];
  source_tier?: "packaged" | "user";
  shadowed_adapter_path?: string;
};

export type Manifest = {
  version: string;
  sites: Record<
    string,
    {
      category?: string;
      commands: ManifestCommand[];
    }
  >;
};

export class UserAdapterManifestError extends Error {
  constructor(
    readonly code: "adapter_schema_invalid" | "adapter_metadata_invalid",
    message: string,
    readonly adapter_path: string,
  ) {
    super(message);
    this.name = "UserAdapterManifestError";
  }
}

export function isUserAdapterManifestError(
  error: unknown,
): error is UserAdapterManifestError {
  return error instanceof UserAdapterManifestError;
}

export function manifestPath(): string {
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

export function readManifest(): Manifest {
  const packaged = JSON.parse(readFileSync(manifestPath(), "utf8")) as Manifest;
  return overlayUserAdapters(packaged);
}

function overlayUserAdapters(packaged: Manifest): Manifest {
  const sites = Object.create(null) as Manifest["sites"];
  for (const [site, info] of Object.entries(packaged.sites)) {
    sites[site] = {
      ...info,
      commands: info.commands.map((command) => ({
        ...command,
        source_tier: command.source_tier ?? ("packaged" as const),
      })),
    };
  }
  const userDirectory = join(
    process.env.HOME ?? homedir(),
    ".unicli",
    "adapters",
  );
  if (!existsSync(userDirectory)) return { ...packaged, sites };

  for (const site of readdirSync(userDirectory).sort()) {
    if (site.startsWith(".") || site.startsWith("_")) continue;
    const siteDirectory = join(userDirectory, site);
    if (!statSync(siteDirectory).isDirectory()) continue;
    for (const file of readdirSync(siteDirectory).sort()) {
      if (
        file.startsWith("_") ||
        (!file.endsWith(".yaml") && !file.endsWith(".yml"))
      ) {
        continue;
      }
      const path = join(siteDirectory, file);
      if (statSync(path).size > 256 * 1024) {
        throw new UserAdapterManifestError(
          "adapter_metadata_invalid",
          `User adapter exceeds the 256 KiB YAML limit: ${path}`,
          path,
        );
      }
      let parsed: unknown;
      try {
        parsed = yaml.load(readFileSync(path, "utf8"), {
          schema: yaml.CORE_SCHEMA,
          filename: path,
        });
      } catch (error) {
        throw new UserAdapterManifestError(
          "adapter_schema_invalid",
          `Failed to parse user adapter ${path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          path,
        );
      }
      const command = userManifestCommand(
        parsed,
        basename(file, extname(file)),
        path,
      );
      if (!command) continue;
      const current = Object.hasOwn(sites, site)
        ? sites[site]
        : { category: "other", commands: [] };
      const shadowed = current.commands.find(
        (candidate) => candidate.name === command.name,
      );
      current.commands = [
        ...current.commands.filter(
          (candidate) => candidate.name !== command.name,
        ),
        {
          ...command,
          ...(shadowed?.adapter_path
            ? { shadowed_adapter_path: shadowed.adapter_path }
            : {}),
        },
      ].sort((left, right) => left.name.localeCompare(right.name));
      sites[site] = current;
    }
  }
  return { ...packaged, sites };
}

function userManifestCommand(
  value: unknown,
  commandName: string,
  path: string,
): ManifestCommand | undefined {
  if (!commandName || commandName.startsWith("_")) return undefined;
  const normalized = normalizeYamlAdapterDocument(
    value,
    commandName,
    path,
    "user",
  );
  if (!normalized.ok) {
    throw new UserAdapterManifestError(
      "adapter_schema_invalid",
      `Invalid user adapter ${path}: ${normalized.error}`,
      path,
    );
  }
  const { command, document } = normalized;
  return {
    name: commandName,
    source_tier: "user",
    adapter_path: path,
    description: command.description,
    strategy: document.strategy,
    type: document.type,
    domain: command.domain,
    base: command.base,
    browser: command.browser,
    browserSession: command.browserSession,
    args: command.adapterArgs,
    columns: command.columns,
    defaultFormat: command.defaultFormat,
    capabilities: command.capabilities,
    auth_requirement: command.auth_requirement,
    executables: command.executables,
    minimum_capability: command.minimum_capability,
    pipeline_steps: command.pipeline?.length ?? 0,
    paginated: command.paginated,
    retrieval: command.retrieval,
    output: command.output,
    stream: command.stream,
    target_surface: command.target_surface,
    operation_effect: command.operation_effect,
    execution_operator: command.execution_operator,
    operation_family: command.operation_family,
    idempotency: command.idempotency,
    method: command.method,
    pipeline: command.pipeline,
    quarantined: command.quarantine,
  };
}

export function manifestCommandUsesBrowser(
  command: ManifestCommand,
  adapterType: string,
): boolean {
  if (capabilityUsesBrowser(command.minimum_capability)) return true;
  if (command.browser !== undefined) return command.browser;
  if (command.capabilities?.some(capabilityUsesBrowser)) {
    return true;
  }
  const strategy = command.strategy?.toLowerCase();
  return (
    adapterType === "browser" || strategy === "intercept" || strategy === "ui"
  );
}

function capabilityUsesBrowser(capability: string | undefined): boolean {
  if (!capability) return false;
  const normalized = capability.toLowerCase();
  return (
    normalized.startsWith("browser.") || normalized.startsWith("cdp-browser.")
  );
}

export function isMissingManifestError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Missing dist/manifest.json")
  );
}
