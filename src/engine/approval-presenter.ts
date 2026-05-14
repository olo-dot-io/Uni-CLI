/**
 * @owner   src/engine/approval-presenter.ts
 * @does    Projects stored approval entries into CLI-safe response objects.
 * @needs   approval-store StoredApproval entries and capability-policy dimension names.
 * @feeds   approvals Commander command and approvals fast path.
 * @breaks  StoredApproval schema changes require projection updates here.
 */

import type { CapabilityDimensionName } from "./capability-policy.js";
import type { StoredApproval } from "./approval-store.js";

export function projectApproval(
  entry: StoredApproval,
): Record<string, unknown> {
  return {
    key: entry.key,
    profile: entry.profile,
    created_at: entry.created_at,
    command: entry.command,
    scope_summary: scopeSummary(entry),
    resource_summary: resourceSummary(entry),
    scope: entry.scope,
  };
}

function scopeSummary(entry: StoredApproval): string[] {
  const order: CapabilityDimensionName[] = [
    "network",
    "browser",
    "desktop",
    "file",
    "process",
    "account",
  ];
  return order.flatMap((name) => {
    const access = entry.scope.dimensions[name];
    return access === "none" ? [] : [`${name}:${access}`];
  });
}

function resourceSummary(entry: StoredApproval): string[] {
  const resources = entry.scope.resources;
  if (!resources) return [];
  return [
    ...resources.domains.map((value) => `domain:${value}`),
    ...resources.accounts.map((value) => `account:${value}`),
    ...resources.apps.map((value) => `app:${value}`),
    ...resources.executables.map((value) => `process:${value}`),
    ...resources.paths.map((value) => `path:${value}`),
  ];
}
