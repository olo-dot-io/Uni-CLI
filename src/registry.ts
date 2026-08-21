/**
 * @owner src/registry.ts
 * @does Owns the in-process adapter registry and TypeScript adapter registration helper.
 * @needs src/types command execution context, src/discovery/aliases, src/core/auth-contract
 * @feeds src/discovery/loader.ts, src/commands/dispatch.ts, src/discovery/search.ts, MCP and ACP command surfaces
 * @breaks Propagates malformed adapter command metadata to command resolution and invocation callers.
 * @invariants Every registered command is keyed by stable site and command names; loader-provided source paths and explicit authentication/retrieval metadata are preserved unless the adapter sets them explicitly; TypeScript functions receive the kernel execution context.
 * @side-effects Mutates the process-local adapter registry map.
 * @perf O(1) registration and command lookup; O(commands) listing.
 * @concurrency Not thread-safe; Node module registry is process-local and loader imports TS adapters sequentially.
 * @test tests/unit/registry.test.ts, tests/unit/loader.test.ts
 * @stability stable
 * @since 2026-05-26
 */

import { AdapterType, Strategy } from "./types.js";
import { SITE_CATEGORIES } from "./discovery/aliases.js";
import {
  metadataAuthRequirement,
  metadataAuthSetupCommand,
  metadataHasOptionalAuth,
  metadataRequiresAuth,
} from "./core/auth-contract.js";
import { isCommandDiscoverable } from "./core/command-availability.js";
import {
  classifyPersonalization,
  type PersonalizationFamily,
} from "./discovery/personalization.js";
import type {
  AdapterManifest,
  AdapterCommand,
  AdapterArg,
  TargetSurface,
  SocialCapability,
  BrowserSessionPreference,
  CommandExecutionContext,
  RetrievalMetadata,
} from "./types.js";

export { Strategy };

const adapters = new Map<string, AdapterManifest>();
let activeAdapterSourcePath: string | undefined;
let registryVersion = 0;

function bumpRegistryVersion(): void {
  registryVersion += 1;
}

export function getRegistryVersion(): number {
  return registryVersion;
}

export async function withAdapterSourcePath<T>(
  sourcePath: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previousSourcePath = activeAdapterSourcePath;
  activeAdapterSourcePath = sourcePath;
  try {
    return await run();
  } finally {
    activeAdapterSourcePath = previousSourcePath;
  }
}

/** Register a full adapter manifest (typically from YAML) */
export function registerAdapter(manifest: AdapterManifest): void {
  const existing = adapters.get(manifest.name);
  if (!existing) {
    adapters.set(manifest.name, canonicalizeManifest(manifest));
    bumpRegistryVersion();
    return;
  }

  const commands = Object.assign(
    Object.create(null) as Record<string, AdapterCommand>,
    existing.commands,
  );
  for (const [name, incoming] of Object.entries(manifest.commands)) {
    const current = commands[name];
    if (!current) {
      commands[name] = canonicalizeCommand(incoming);
      continue;
    }
    const incomingTier = sourceTierRank(incoming.source_tier);
    const currentTier = sourceTierRank(current.source_tier);
    if (incomingTier < currentTier) continue;
    if (
      incomingTier === currentTier &&
      incoming.adapter_path &&
      current.adapter_path &&
      incoming.adapter_path !== current.adapter_path
    ) {
      throw new Error(
        `Duplicate ${incoming.source_tier ?? "runtime"} adapter command ${manifest.name}.${name}: ${current.adapter_path} and ${incoming.adapter_path}`,
      );
    }
    commands[name] = canonicalizeCommand({
      ...incoming,
      ...(incomingTier > currentTier && current.adapter_path
        ? { shadowed_adapter_path: current.adapter_path }
        : {}),
    });
  }
  adapters.set(manifest.name, canonicalizeManifest({ ...existing, commands }));
  bumpRegistryVersion();
}

/** Atomically replace one owned command family without exposing mutable registry state. */
export function replaceAdapterCommands(
  site: string,
  shouldRemove: (name: string, command: AdapterCommand) => boolean,
  additions: Readonly<Record<string, AdapterCommand>>,
  create?: Omit<AdapterManifest, "name" | "commands">,
): void {
  const current = adapters.get(site);
  if (!current && !create) {
    throw new Error(`Cannot replace commands for unknown adapter: ${site}`);
  }
  const commands = Object.create(null) as Record<string, AdapterCommand>;
  for (const [name, command] of Object.entries(current?.commands ?? {})) {
    if (!shouldRemove(name, command)) commands[name] = command;
  }
  for (const [name, command] of Object.entries(additions)) {
    commands[name] = command;
  }
  adapters.set(
    site,
    canonicalizeManifest(
      current ? { ...current, commands } : { name: site, ...create!, commands },
    ),
  );
  bumpRegistryVersion();
}

function canonicalizeManifest(manifest: AdapterManifest): AdapterManifest {
  const commands = Object.create(null) as Record<string, AdapterCommand>;
  for (const [name, command] of Object.entries(manifest.commands)) {
    commands[name] = canonicalizeCommand(command);
  }
  return deepFreeze({ ...manifest, commands });
}

function canonicalizeCommand(command: AdapterCommand): AdapterCommand {
  return deepFreeze({
    ...command,
    ...(command.adapterArgs
      ? { adapterArgs: command.adapterArgs.map((arg) => ({ ...arg })) }
      : {}),
    ...(command.pipeline
      ? { pipeline: command.pipeline.map((step) => ({ ...step })) }
      : {}),
    ...(command.capabilities
      ? { capabilities: [...command.capabilities] }
      : {}),
    ...(command.executables ? { executables: [...command.executables] } : {}),
    ...(command.columns ? { columns: [...command.columns] } : {}),
    ...(command.availability
      ? {
          availability: {
            ...command.availability,
            environment: [...command.availability.environment],
          },
        }
      : {}),
  });
}

function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function") ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child && (typeof child === "object" || typeof child === "function")) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}

function sourceTierRank(
  tier: AdapterCommand["source_tier"] | undefined,
): number {
  switch (tier) {
    case "packaged":
      return 0;
    case "runtime":
      return 1;
    case "user":
      return 2;
    default:
      return 1;
  }
}

/** Get an adapter by name */
export function getAdapter(name: string): AdapterManifest | undefined {
  return adapters.get(name);
}

/** Get all registered adapters */
export function getAllAdapters(): AdapterManifest[] {
  return Array.from(adapters.values());
}

/** Resolve a command from "unicli <site> <command>" */
export function resolveCommand(
  site: string,
  commandName: string,
): { adapter: AdapterManifest; command: AdapterCommand } | undefined {
  const adapter = adapters.get(site);
  if (!adapter) return undefined;

  const command = adapter.commands[commandName];
  if (!command) return undefined;

  return { adapter, command };
}

export function commandStrategy(
  adapter: AdapterManifest,
  command: AdapterCommand,
): Strategy | undefined {
  return command.strategy ?? adapter.strategy;
}

export function commandRequiresAuth(
  adapter: AdapterManifest,
  command: AdapterCommand,
): boolean {
  return metadataRequiresAuth(
    commandStrategy(adapter, command),
    command.capabilities,
    command.auth_requirement,
  );
}

export function commandHasOptionalAuth(command: AdapterCommand): boolean {
  return metadataHasOptionalAuth(command.auth_requirement);
}

export function commandAuthSetupCommand(
  adapter: AdapterManifest,
  command: AdapterCommand,
): string | undefined {
  if (command.availability?.environment.length) return undefined;
  return metadataAuthSetupCommand(
    adapter.name,
    commandStrategy(adapter, command),
    command.capabilities,
    command.auth_requirement,
  );
}

export function commandUsesBrowser(
  adapter: AdapterManifest,
  command: AdapterCommand,
): boolean {
  if (capabilityUsesBrowser(command.minimum_capability)) return true;
  if (command.browser !== undefined) return command.browser;
  if (command.capabilities?.some(capabilityUsesBrowser)) {
    return true;
  }
  const strategy = commandStrategy(adapter, command);
  if (command.strategy !== undefined) {
    return strategy === Strategy.INTERCEPT || strategy === Strategy.UI;
  }
  if (adapter.browser !== undefined) return adapter.browser;
  return (
    adapter.type === AdapterType.BROWSER ||
    strategy === Strategy.INTERCEPT ||
    strategy === Strategy.UI
  );
}

function capabilityUsesBrowser(capability: string | undefined): boolean {
  if (!capability) return false;
  const normalized = capability.toLowerCase();
  return (
    normalized.startsWith("browser.") || normalized.startsWith("cdp-browser.")
  );
}

function adapterCategory(adapter: AdapterManifest): string {
  return adapter.category ?? SITE_CATEGORIES.get(adapter.name) ?? "other";
}

/** List all available commands across all adapters */
export function listCommands(
  options: { includeUnavailable?: boolean } = {},
): Array<{
  site: string;
  command: string;
  description: string;
  category: string;
  type: string;
  auth: boolean;
  authRequirement: "required" | "optional" | "none";
  authSetup?: string;
  personalization?: PersonalizationFamily;
  args: readonly AdapterArg[];
  quarantined: boolean;
  quarantineReason?: string;
  availability?: AdapterCommand["availability"];
}> {
  const result: Array<{
    site: string;
    command: string;
    description: string;
    category: string;
    type: string;
    auth: boolean;
    authRequirement: "required" | "optional" | "none";
    authSetup?: string;
    personalization?: PersonalizationFamily;
    args: readonly AdapterArg[];
    quarantined: boolean;
    quarantineReason?: string;
    availability?: AdapterCommand["availability"];
  }> = [];

  for (const adapter of adapters.values()) {
    for (const [name, cmd] of Object.entries(adapter.commands)) {
      if (!options.includeUnavailable && !isCommandDiscoverable(cmd)) continue;
      const category = adapterCategory(adapter);
      const strategy = commandStrategy(adapter, cmd);
      const authRequirement = metadataAuthRequirement(
        strategy,
        cmd.capabilities,
        cmd.auth_requirement,
      );
      const authSetup = commandAuthSetupCommand(adapter, cmd);
      const personalization = classifyPersonalization({
        command: name,
        description: cmd.description,
        category,
        auth: authRequirement,
      });
      result.push({
        site: adapter.name,
        command: name,
        description: cmd.description ?? "",
        category,
        type: adapter.type,
        auth: authRequirement === "required",
        authRequirement,
        ...(authSetup ? { authSetup } : {}),
        ...(personalization ? { personalization } : {}),
        args: cmd.adapterArgs ?? [],
        quarantined: cmd.quarantine === true,
        quarantineReason: cmd.quarantineReason,
        ...(cmd.availability ? { availability: cmd.availability } : {}),
      });
    }
  }

  return result.sort(
    (a, b) =>
      a.site.localeCompare(b.site) || a.command.localeCompare(b.command),
  );
}

/** TypeScript adapter registration helper */
export interface CliRegistration {
  site: string;
  name: string;
  description?: string;
  domain?: string;
  base?: string;
  strategy?: Strategy;
  browser?: boolean;
  browserSession?: BrowserSessionPreference;
  adapter_path?: string;
  target_surface?: TargetSurface;
  operation_effect?: AdapterCommand["operation_effect"];
  execution_operator?: AdapterCommand["execution_operator"];
  operation_family?: AdapterCommand["operation_family"];
  idempotency?: AdapterCommand["idempotency"];
  args?: AdapterArg[];
  columns?: string[];
  socialCapabilities?: SocialCapability[];
  defaultFormat?: AdapterCommand["defaultFormat"];
  /**
   * Capability tokens this command can execute. Carries both pipeline-step
   * names (e.g. `cdp-browser.evaluate`) and vertical capability tags
   * (e.g. `patent.search`). Vertical tags let meta-commands like
   * `unicli patent` discover the adapter without hard-coding a site list.
   *
   * Typed `readonly` so it stays compatible with the v2 registration
   * helper at src/core/registry.ts which can pass a richer `Capability`
   * shape; the legacy registry copies the array into a mutable field on
   * the underlying AdapterCommand at call time.
   */
  capabilities?: readonly string[];
  /** Required, optional-by-route, or absent authentication contract. */
  auth_requirement?: AdapterCommand["auth_requirement"];
  /** Configuration prerequisites and catalog visibility policy. */
  availability?: AdapterCommand["availability"];
  /** Domain-neutral evidence discovery metadata; never used for permission. */
  retrieval?: RetrievalMetadata;
  /** Local executable names used by commands that declare subprocess.*. */
  executables?: readonly string[];
  /** Schema-v2 minimum-capability token; defaults to `http.fetch`. */
  minimum_capability?: string;
  func: (
    page: unknown,
    kwargs: Record<string, unknown>,
    context: CommandExecutionContext,
  ) => Promise<unknown>;
}

export function cli(config: CliRegistration): void {
  if (config.retrieval?.arguments) {
    const declaredArguments = new Set(
      (config.args ?? []).map((argument) => argument.name),
    );
    for (const [role, target] of Object.entries(config.retrieval.arguments)) {
      if (!declaredArguments.has(target)) {
        throw new TypeError(
          `${config.site}.${config.name} retrieval role ${role} maps to undeclared argument ${target}.`,
        );
      }
    }
  }
  const currentAdapter = adapters.get(config.site);
  const existing = currentAdapter?.commands[config.name];
  const sourceTier = adapterSourceTier(activeAdapterSourcePath);
  if (
    existing &&
    sourceTierRank(sourceTier) < sourceTierRank(existing.source_tier)
  ) {
    return;
  }
  const incomingPath = config.adapter_path ?? activeAdapterSourcePath;
  if (
    existing &&
    sourceTierRank(sourceTier) === sourceTierRank(existing.source_tier) &&
    incomingPath &&
    existing.adapter_path &&
    incomingPath !== existing.adapter_path
  ) {
    throw new Error(
      `Duplicate ${sourceTier} adapter command ${config.site}.${config.name}: ${existing.adapter_path} and ${incomingPath}`,
    );
  }

  // Decide command precedence before publishing any site mutation. A rejected
  // or duplicate registration must not leave an empty adapter or partially
  // updated site metadata in the process registry.
  const command: AdapterCommand = {
    name: config.name,
    description: config.description,
    adapter_path:
      config.adapter_path ?? existing?.adapter_path ?? activeAdapterSourcePath,
    source_tier: sourceTier,
    ...(sourceTierRank(sourceTier) > sourceTierRank(existing?.source_tier) &&
    existing?.adapter_path
      ? { shadowed_adapter_path: existing.adapter_path }
      : {}),
    target_surface: config.target_surface,
    operation_effect: config.operation_effect,
    execution_operator: config.execution_operator,
    operation_family: config.operation_family,
    idempotency: config.idempotency,
    adapterArgs: config.args,
    strategy: config.strategy,
    browser: config.browser,
    browserSession: config.browserSession,
    domain: config.domain,
    base: config.base,
    columns: config.columns,
    socialCapabilities: config.socialCapabilities,
    defaultFormat: config.defaultFormat,
    capabilities: config.capabilities ? [...config.capabilities] : undefined,
    auth_requirement: config.auth_requirement,
    availability: config.availability,
    retrieval: config.retrieval,
    executables: config.executables ? [...config.executables] : undefined,
    minimum_capability: config.minimum_capability,
    func: config.func as AdapterCommand["func"],
  };
  const adapter: AdapterManifest = currentAdapter
    ? {
        ...currentAdapter,
        ...(config.domain ? { domain: config.domain } : {}),
        ...(config.base ? { base: config.base } : {}),
        ...(config.strategy ? { strategy: config.strategy } : {}),
        ...(config.browser !== undefined ? { browser: config.browser } : {}),
        commands: {
          ...currentAdapter.commands,
          [config.name]: command,
        },
      }
    : {
        name: config.site,
        type: AdapterType.WEB_API,
        domain: config.domain,
        base: config.base,
        strategy: config.strategy,
        browser: config.browser,
        commands: { [config.name]: command },
      };
  adapters.set(config.site, canonicalizeManifest(adapter));
  bumpRegistryVersion();
}

function adapterSourceTier(
  sourcePath: string | undefined,
): AdapterCommand["source_tier"] {
  if (sourcePath?.includes("/.unicli/adapters/")) return "user";
  if (
    sourcePath?.startsWith("src/adapters/") ||
    sourcePath?.startsWith("dist/adapters/")
  ) {
    return "packaged";
  }
  return "runtime";
}
