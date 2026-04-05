/**
 * Community Fix Level 3 — query the adapter registry for updates.
 *
 * When an adapter fails and auto-fix can't resolve it, this module
 * checks if a newer version exists in the community registry.
 *
 * Registry: https://registry.unicli.dev/api/adapters/<site>/<cmd>/latest
 * Status: STUB — returns null until registry is deployed.
 */

const REGISTRY_BASE = "https://registry.unicli.dev/api";

interface RegistryEntry {
  site: string;
  command: string;
  version: number;
  hash: string;
  yaml: string;
  updated: string;
}

/**
 * Query the community registry for a newer adapter version.
 * Returns the YAML content if a newer version exists, null otherwise.
 */
export async function fetchCommunityFix(
  site: string,
  command: string,
  _currentHash?: string,
): Promise<string | null> {
  // STUB: Registry not yet deployed
  void REGISTRY_BASE;
  void site;
  void command;
  return null;
}

/**
 * Check if the community registry is reachable.
 */
export async function isRegistryAvailable(): Promise<boolean> {
  // STUB: Always returns false until registry is deployed
  return false;
}

// Re-export for type consumers
export type { RegistryEntry };
