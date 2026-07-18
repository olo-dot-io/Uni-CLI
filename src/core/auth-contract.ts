/**
 * @owner src/core/auth-contract.ts
 * @does Resolves authentication requirements and setup commands from portable command metadata.
 * @needs Command strategy strings and capability tokens.
 * @feeds In-process registry contracts and generated-manifest fast-path discovery.
 * @breaks Incorrect metadata sends agents to the wrong authentication boundary.
 * @invariants Explicit required, optional, or none metadata overrides strategy inference; executable-native setup takes precedence over browser-cookie setup.
 * @side-effects None.
 * @perf O(capabilities) per command.
 * @concurrency Safe; module state is immutable.
 * @test tests/unit/fast-path.test.ts, tests/unit/adapters/ai-intelligence.test.ts
 * @stability stable
 * @since 2026-07-17
 */

import type { AuthRequirement } from "../types.js";

const EXECUTABLE_AUTH_SETUP: ReadonlyMap<string, string> = new Map([
  ["auth.executable.gh", "gh auth login"],
]);

export function executableAuthSetupCommand(
  capabilities: readonly string[] | undefined,
): string | undefined {
  const capability = capabilities?.find((candidate) =>
    EXECUTABLE_AUTH_SETUP.has(candidate),
  );
  return capability ? EXECUTABLE_AUTH_SETUP.get(capability) : undefined;
}

export function metadataRequiresAuth(
  strategy: string | undefined,
  capabilities: readonly string[] | undefined,
  requirement?: AuthRequirement,
): boolean {
  if (requirement !== undefined) return requirement === "required";
  return (
    executableAuthSetupCommand(capabilities) !== undefined ||
    (strategy !== undefined && strategy !== "public")
  );
}

export function metadataAuthSetupCommand(
  site: string,
  strategy: string | undefined,
  capabilities: readonly string[] | undefined,
  requirement?: AuthRequirement,
): string | undefined {
  if (requirement === "none") return undefined;
  return (
    executableAuthSetupCommand(capabilities) ??
    (requirement === "optional" ||
    metadataRequiresAuth(strategy, capabilities, requirement)
      ? `unicli auth setup ${site}`
      : undefined)
  );
}

export function metadataHasOptionalAuth(
  requirement: AuthRequirement | undefined,
): boolean {
  return requirement === "optional";
}
