/**
 * Adapter registry — the central hub for all registered adapters.
 *
 * Supports two registration paths:
 *   1. YAML adapters — loaded from src/adapters/<site>/<command>.yaml
 *   2. TS adapters   — registered via cli() function call
 */

import { AdapterType } from './types.js';
import type { AdapterManifest, AdapterCommand, AdapterArg, Strategy } from './types.js';

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
  commandName: string
): { adapter: AdapterManifest; command: AdapterCommand } | undefined {
  const adapter = adapters.get(site);
  if (!adapter) return undefined;

  const command = adapter.commands[commandName];
  if (!command) return undefined;

  return { adapter, command };
}

/** List all available commands across all adapters */
export function listCommands(): Array<{
  site: string;
  command: string;
  description: string;
  type: string;
  auth: boolean;
}> {
  const result: Array<{
    site: string;
    command: string;
    description: string;
    type: string;
    auth: boolean;
  }> = [];

  for (const adapter of adapters.values()) {
    for (const [name, cmd] of Object.entries(adapter.commands)) {
      result.push({
        site: adapter.name,
        command: name,
        description: cmd.description ?? '',
        type: adapter.type,
        auth: adapter.strategy !== 'public' && adapter.strategy !== undefined,
      });
    }
  }

  return result.sort((a, b) => a.site.localeCompare(b.site) || a.command.localeCompare(b.command));
}

/** TypeScript adapter registration helper (OpenCLI-compatible pattern) */
export interface CliRegistration {
  site: string;
  name: string;
  description?: string;
  domain?: string;
  strategy?: Strategy;
  browser?: boolean;
  args?: AdapterArg[];
  columns?: string[];
  func: (page: unknown, kwargs: Record<string, unknown>) => Promise<unknown>;
}

export function cli(config: CliRegistration): void {
  let adapter = adapters.get(config.site);
  if (!adapter) {
    adapter = {
      name: config.site,
      type: AdapterType.WEB_API,
      domain: config.domain,
      strategy: config.strategy,
      browser: config.browser,
      commands: {},
    };
    adapters.set(config.site, adapter);
  }

  adapter!.commands[config.name] = {
    name: config.name,
    description: config.description,
    columns: config.columns,
    func: config.func as AdapterCommand['func'],
  };
}
