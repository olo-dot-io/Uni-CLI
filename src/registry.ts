/**
 * Adapter registry — the central hub for all registered adapters.
 *
 * Supports two registration paths:
 *   1. YAML adapters — loaded from src/adapters/<site>/<command>.yaml
 *   2. TS adapters   — registered via cli() function call
 */

import { AdapterType, Strategy } from "./types.js";
import type {
  AdapterManifest,
  AdapterCommand,
  AdapterArg,
  TargetSurface,
  SocialCapability,
  BrowserSessionPreference,
} from "./types.js";

export { Strategy };

const adapters = new Map<string, AdapterManifest>();

/** Register a full adapter manifest (typically from YAML) */
export function registerAdapter(manifest: AdapterManifest): void {
  adapters.set(manifest.name, manifest);
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
  const strategy = commandStrategy(adapter, command);
  return strategy !== undefined && strategy !== Strategy.PUBLIC;
}

export function commandUsesBrowser(
  adapter: AdapterManifest,
  command: AdapterCommand,
): boolean {
  if (command.browser !== undefined) return command.browser;
  const strategy = commandStrategy(adapter, command);
  if (command.strategy !== undefined) {
    return (
      adapter.type === AdapterType.BROWSER ||
      strategy === Strategy.INTERCEPT ||
      strategy === Strategy.UI
    );
  }
  if (adapter.browser !== undefined) return adapter.browser;
  return (
    adapter.type === AdapterType.BROWSER ||
    strategy === Strategy.INTERCEPT ||
    strategy === Strategy.UI
  );
}

/** List all available commands across all adapters */
export function listCommands(): Array<{
  site: string;
  command: string;
  description: string;
  type: string;
  auth: boolean;
  quarantined: boolean;
  quarantineReason?: string;
}> {
  const result: Array<{
    site: string;
    command: string;
    description: string;
    type: string;
    auth: boolean;
    quarantined: boolean;
    quarantineReason?: string;
  }> = [];

  for (const adapter of adapters.values()) {
    for (const [name, cmd] of Object.entries(adapter.commands)) {
      result.push({
        site: adapter.name,
        command: name,
        description: cmd.description ?? "",
        type: adapter.type,
        auth: commandRequiresAuth(adapter, cmd),
        quarantined: cmd.quarantine === true,
        quarantineReason: cmd.quarantineReason,
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
  args?: AdapterArg[];
  columns?: string[];
  socialCapabilities?: SocialCapability[];
  defaultFormat?: AdapterCommand["defaultFormat"];
  /**
   * Capability tokens this command can execute. Carries both pipeline-step
   * names (e.g. `mcp-browser.evaluate`) and vertical capability tags
   * (e.g. `patent.search`). Vertical tags let meta-commands like
   * `unicli patent` discover the adapter without hard-coding a site list.
   *
   * Typed `readonly` so it stays compatible with the v2 registration
   * helper at src/core/registry.ts which can pass a richer `Capability`
   * shape; the legacy registry copies the array into a mutable field on
   * the underlying AdapterCommand at call time.
   */
  capabilities?: readonly string[];
  /** Schema-v2 minimum-capability token; defaults to `http.fetch`. */
  minimum_capability?: string;
  func: (page: unknown, kwargs: Record<string, unknown>) => Promise<unknown>;
}

export function cli(config: CliRegistration): void {
  let adapter = adapters.get(config.site);
  if (!adapter) {
    adapter = {
      name: config.site,
      type: AdapterType.WEB_API,
      domain: config.domain,
      base: config.base,
      strategy: config.strategy,
      browser: config.browser,
      commands: {},
    };
    adapters.set(config.site, adapter);
  } else {
    if (config.domain) adapter.domain = config.domain;
    if (config.base) adapter.base = config.base;
    if (config.strategy) adapter.strategy = config.strategy;
    if (config.browser !== undefined) adapter.browser = config.browser;
  }

  const existing = adapter!.commands[config.name];
  adapter!.commands[config.name] = {
    name: config.name,
    description: config.description,
    adapter_path: config.adapter_path ?? existing?.adapter_path,
    target_surface: config.target_surface,
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
    minimum_capability: config.minimum_capability,
    func: config.func as AdapterCommand["func"],
  };
}
