import { VERSION } from "../../constants.js";
import type { RunTraceMetadata } from "./types.js";

function truthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return !["", "0", "false", "no", "off"].includes(normalized);
}

export function isCiEnvironment(): boolean {
  return (
    truthyEnvFlag(process.env.CI) || truthyEnvFlag(process.env.GITHUB_ACTIONS)
  );
}

export function environmentSnapshotData(
  metadata: RunTraceMetadata,
): Record<string, unknown> {
  return {
    schema_version: "1",
    unicli_version: VERSION,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    ci: isCiEnvironment(),
    permission_profile: metadata.permission_profile,
    transport_surface: metadata.transport_surface,
    target_surface: metadata.target_surface,
    pipeline_steps: metadata.pipeline_steps,
  };
}
