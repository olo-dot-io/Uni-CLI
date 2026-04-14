/**
 * Registry v2 — enhanced `cli()` helper that accepts the v0.212
 * schema-v2 fields (capabilities, minimum_capability, trust,
 * confidentiality, quarantine) and delegates to the legacy registry
 * for the underlying adapter map.
 *
 * Backward-compat: existing callers that import { cli } from
 * "../../registry.js" keep working unchanged. New callers can import
 * from "../../core/registry.js" to pass the expanded metadata.
 */

import {
  cli as legacyCli,
  getAdapter,
  getAllAdapters,
  listCommands,
  registerAdapter,
  resolveCommand,
  type CliRegistration,
} from "../registry.js";
import type { Capability } from "../transport/types.js";
import type { AdapterTrust, AdapterConfidentiality } from "./schema-v2.js";

/**
 * v2 registration shape. All legacy fields are forwarded to
 * {@link legacyCli}; the v2 fields are stored in a side table so the
 * schema-v2 validators + the upcoming migration tool can introspect
 * them without touching the `AdapterManifest` runtime shape.
 */
export interface CliRegistrationV2 extends CliRegistration {
  /** Pipeline step names this command may invoke at runtime. */
  capabilities?: Capability | readonly string[];
  /** The single step the dispatcher MUST support to run this command. */
  minimum_capability?: string;
  /** Provenance trust level. Defaults to "public". */
  trust?: AdapterTrust;
  /** Data sensitivity label. Defaults to "public". */
  confidentiality?: AdapterConfidentiality;
  /** If true, CI quarantines the command until repaired. */
  quarantine?: boolean;
}

/**
 * Metadata captured at registration time for v2 callers. Keyed by
 * `"<site>/<command>"` so the same adapter can host multiple commands
 * with different trust levels (e.g. read-only vs write).
 */
export interface CommandMetadataV2 {
  site: string;
  name: string;
  capabilities: readonly string[];
  minimum_capability: string;
  trust: AdapterTrust;
  confidentiality: AdapterConfidentiality;
  quarantine: boolean;
}

const metadata = new Map<string, CommandMetadataV2>();

function metadataKey(site: string, name: string): string {
  return `${site}/${name}`;
}

function normalizeCapabilities(
  input: Capability | readonly string[] | undefined,
): readonly string[] {
  if (!input) return [];
  if (Array.isArray(input)) return [...(input as readonly string[])];
  if (typeof input === "object" && "steps" in input) {
    return [...(input as Capability).steps];
  }
  return [];
}

/**
 * Register a TypeScript adapter with v2 metadata. Writes the legacy
 * manifest via {@link legacyCli} so existing code paths (help, listing,
 * dispatcher) continue to work unchanged.
 */
export function cli(config: CliRegistrationV2): void {
  const {
    capabilities,
    minimum_capability,
    trust,
    confidentiality,
    quarantine,
    ...legacy
  } = config;

  legacyCli(legacy);

  metadata.set(metadataKey(config.site, config.name), {
    site: config.site,
    name: config.name,
    capabilities: normalizeCapabilities(capabilities),
    minimum_capability: minimum_capability ?? "http.fetch",
    trust: trust ?? "public",
    confidentiality: confidentiality ?? "public",
    quarantine: quarantine ?? false,
  });
}

/** Lookup v2 metadata for a command previously registered via {@link cli}. */
export function getCommandMetadataV2(
  site: string,
  name: string,
): CommandMetadataV2 | undefined {
  return metadata.get(metadataKey(site, name));
}

/** Enumerate all v2 metadata records. */
export function listCommandMetadataV2(): CommandMetadataV2[] {
  return Array.from(metadata.values());
}

/**
 * Test-only: clear the v2 metadata map. Kept internal by convention —
 * agents should not rely on it outside tests.
 */
export function __resetCommandMetadataV2(): void {
  metadata.clear();
}

// Re-export the legacy registry surface so downstream callers need only
// one import.
export {
  getAdapter,
  getAllAdapters,
  listCommands,
  registerAdapter,
  resolveCommand,
};
export type { CliRegistration };
