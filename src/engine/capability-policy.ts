/**
 * Capability-scoped permission classification.
 *
 * This is deliberately deterministic and metadata-only: it classifies the
 * command contract, not user-provided runtime values.
 */

import { createHash } from "node:crypto";
import { AdapterType, type TargetSurface } from "../types.js";
import type {
  OperationEffect,
  OperationPolicyInput,
  PermissionProfile,
} from "./operation-policy.js";

export type CapabilityAccess = "none" | "read" | "write";
export type CapabilityDimensionName =
  | "network"
  | "browser"
  | "desktop"
  | "file"
  | "process"
  | "account";

export interface CapabilityDimension {
  access: CapabilityAccess;
  reason?: string;
}

export type CapabilityDimensionMap = Record<
  CapabilityDimensionName,
  CapabilityDimension
>;

export interface CapabilityResourceScope {
  domains: string[];
  paths: string[];
  executables: string[];
  apps: string[];
  accounts: string[];
}

export interface CapabilityScope {
  schema_version: "1";
  dimensions: CapabilityDimensionMap;
  summary: string[];
  resources: CapabilityResourceScope;
  resource_summary: string[];
}

export interface CapabilityApprovalMemory {
  schema_version: "1";
  key: string;
  persistence: "not_persisted" | "persisted";
  profile: PermissionProfile;
  decision: "not_approved" | "approved_for_invocation" | "approved_by_memory";
  scope: {
    dimensions: Record<CapabilityDimensionName, CapabilityAccess>;
    resources: CapabilityResourceScope;
  };
}

const DIMENSION_ORDER: CapabilityDimensionName[] = [
  "network",
  "browser",
  "desktop",
  "file",
  "process",
  "account",
];

const WEB_STRATEGIES = new Set([
  "public",
  "cookie",
  "header",
  "intercept",
  "ui",
]);

const PATH_ARG_NAMES = new Set([
  "dir",
  "directory",
  "file",
  "filename",
  "folder",
  "input",
  "out",
  "output",
  "path",
  "source",
  "destination",
]);

function emptyDimensions(): CapabilityDimensionMap {
  return {
    network: { access: "none" },
    browser: { access: "none" },
    desktop: { access: "none" },
    file: { access: "none" },
    process: { access: "none" },
    account: { access: "none" },
  };
}

function emptyResources(): CapabilityResourceScope {
  return {
    domains: [],
    paths: [],
    executables: [],
    apps: [],
    accounts: [],
  };
}

function accessRank(access: CapabilityAccess): number {
  switch (access) {
    case "write":
      return 2;
    case "read":
      return 1;
    case "none":
      return 0;
  }
}

function promoteAccess(
  dimensions: CapabilityDimensionMap,
  name: CapabilityDimensionName,
  access: Exclude<CapabilityAccess, "none">,
  reason: string,
): void {
  const current = dimensions[name];
  if (accessRank(access) >= accessRank(current.access)) {
    dimensions[name] = { access, reason };
  }
}

function normalizedUnique(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  ).sort();
}

function normalizeDomain(value?: string): string | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (raw.length === 0) return undefined;

  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.host.toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      ?.trim()
      .toLowerCase();
  }
}

function pathArgSlots(input: OperationPolicyInput): string[] {
  return normalizedUnique(
    (input.args ?? []).flatMap((arg) => {
      const name = arg.name.trim().toLowerCase();
      return PATH_ARG_NAMES.has(name) ? [`arg:${name}`] : [];
    }),
  );
}

function deriveResourceScope(
  input: OperationPolicyInput,
  dimensions: CapabilityDimensionMap,
): CapabilityResourceScope {
  const resources = emptyResources();

  if (
    dimensions.network.access !== "none" ||
    dimensions.browser.access !== "none"
  ) {
    const domain = normalizeDomain(input.domain ?? input.base);
    resources.domains = domain ? [domain] : [];
  }

  if (dimensions.account.access !== "none") {
    resources.accounts = [input.site];
  }

  if (dimensions.desktop.access !== "none") {
    resources.apps = [input.site];
  }

  if (dimensions.process.access !== "none") {
    resources.executables = [input.site];
  }

  if (dimensions.file.access !== "none") {
    resources.paths = pathArgSlots(input);
  }

  return {
    domains: normalizedUnique(resources.domains),
    paths: normalizedUnique(resources.paths),
    executables: normalizedUnique(resources.executables),
    apps: normalizedUnique(resources.apps),
    accounts: normalizedUnique(resources.accounts),
  };
}

function effectAccess(
  effect: OperationEffect,
): Exclude<CapabilityAccess, "none"> {
  return effect === "read" ? "read" : "write";
}

function isExplicitLocalSurface(surface?: TargetSurface): boolean {
  return surface === "desktop" || surface === "system";
}

function isNetworkCapable(input: OperationPolicyInput): boolean {
  if (input.adapterType === AdapterType.SERVICE) return true;
  if (isExplicitLocalSurface(input.targetSurface)) return false;
  return (
    (input.targetSurface === undefined && input.adapterType === undefined) ||
    input.targetSurface === "web" ||
    input.targetSurface === "mobile" ||
    input.adapterType === AdapterType.WEB_API ||
    input.adapterType === AdapterType.BROWSER ||
    (input.strategy !== undefined && WEB_STRATEGIES.has(input.strategy))
  );
}

function isBrowserCapable(input: OperationPolicyInput): boolean {
  return (
    input.browser === true ||
    input.adapterType === AdapterType.BROWSER ||
    input.strategy === "intercept" ||
    input.strategy === "ui"
  );
}

function isDesktopCapable(input: OperationPolicyInput): boolean {
  return (
    input.targetSurface === "desktop" ||
    input.adapterType === AdapterType.DESKTOP
  );
}

function isProcessCapable(input: OperationPolicyInput): boolean {
  if (input.adapterType === AdapterType.SERVICE) return false;
  return (
    input.adapterType === AdapterType.BRIDGE ||
    input.adapterType === AdapterType.DESKTOP ||
    input.targetSurface === "desktop" ||
    input.targetSurface === "system"
  );
}

function isRemoteAccountSurface(input: OperationPolicyInput): boolean {
  if (
    input.adapterType === AdapterType.BRIDGE ||
    input.adapterType === AdapterType.DESKTOP ||
    input.adapterType === AdapterType.SERVICE ||
    isExplicitLocalSurface(input.targetSurface)
  ) {
    return false;
  }
  return isNetworkCapable(input) || isBrowserCapable(input);
}

function summaryFor(dimensions: CapabilityDimensionMap): string[] {
  return DIMENSION_ORDER.flatMap((name) => {
    const access = dimensions[name].access;
    return access === "none" ? [] : [`${name}:${access}`];
  });
}

function resourceSummaryFor(resources: CapabilityResourceScope): string[] {
  return [
    ...resources.domains.map((value) => `domain:${value}`),
    ...resources.accounts.map((value) => `account:${value}`),
    ...resources.apps.map((value) => `app:${value}`),
    ...resources.executables.map((value) => `process:${value}`),
    ...resources.paths.map((value) => `path:${value}`),
  ];
}

function accessMapFor(
  dimensions: CapabilityDimensionMap,
): Record<CapabilityDimensionName, CapabilityAccess> {
  return {
    network: dimensions.network.access,
    browser: dimensions.browser.access,
    desktop: dimensions.desktop.access,
    file: dimensions.file.access,
    process: dimensions.process.access,
    account: dimensions.account.access,
  };
}

export function deriveCapabilityScope(
  input: OperationPolicyInput,
  effect: OperationEffect,
): CapabilityScope {
  const dimensions = emptyDimensions();
  const access = effectAccess(effect);
  const networkCapable = isNetworkCapable(input);
  const browserCapable = isBrowserCapable(input);
  const desktopCapable = isDesktopCapable(input);
  const processCapable = isProcessCapable(input);

  if (networkCapable) {
    promoteAccess(
      dimensions,
      "network",
      access,
      access === "read"
        ? "reads remote web or API data"
        : "may write through a remote web or API surface",
    );
  }

  if (browserCapable) {
    promoteAccess(
      dimensions,
      "browser",
      access,
      access === "read"
        ? "reads through browser automation"
        : "may interact with browser automation",
    );
  }

  if (effect === "send_message" || effect === "publish_content") {
    promoteAccess(
      dimensions,
      "account",
      "write",
      "may send or publish as user",
    );
    promoteAccess(
      dimensions,
      "network",
      "write",
      "may submit content to a remote account surface",
    );
  }

  if (effect === "account_state" || effect === "remote_resource") {
    promoteAccess(
      dimensions,
      "account",
      "write",
      effect === "account_state"
        ? "may mutate user account state"
        : "may mutate remote account resources",
    );
    promoteAccess(
      dimensions,
      "network",
      "write",
      effect === "account_state"
        ? "may submit account-state changes remotely"
        : "may submit remote resource changes",
    );
  }

  if (effect === "service_state") {
    promoteAccess(
      dimensions,
      "network",
      "write",
      "may mutate service state through an HTTP API",
    );
  }

  if (effect === "destructive" && isRemoteAccountSurface(input)) {
    promoteAccess(
      dimensions,
      "account",
      "write",
      "may delete or reset remote account state",
    );
    promoteAccess(
      dimensions,
      "network",
      "write",
      "may submit destructive changes remotely",
    );
  }

  if (effect === "destructive" && isExplicitLocalSurface(input.targetSurface)) {
    promoteAccess(
      dimensions,
      "file",
      "write",
      "may delete or reset local files",
    );
    promoteAccess(
      dimensions,
      "process",
      "write",
      "may run a destructive local process",
    );
  }

  if (effect === "local_app") {
    promoteAccess(
      dimensions,
      "desktop",
      "write",
      "may control local application state",
    );
    promoteAccess(
      dimensions,
      "process",
      "write",
      "may drive local automation process",
    );
  }

  if (effect === "local_file") {
    promoteAccess(
      dimensions,
      "file",
      "write",
      "may create or modify local files",
    );
    promoteAccess(
      dimensions,
      "process",
      "write",
      "may run a local process that touches files",
    );
  }

  if (desktopCapable && effect === "read") {
    promoteAccess(dimensions, "desktop", "read", "reads local desktop state");
  } else if (desktopCapable) {
    promoteAccess(
      dimensions,
      "desktop",
      "write",
      "may interact with local desktop state",
    );
  }

  if (processCapable && effect === "read") {
    promoteAccess(
      dimensions,
      "process",
      "read",
      "reads through a local process",
    );
  } else if (processCapable) {
    promoteAccess(
      dimensions,
      "process",
      "write",
      "may run or control a process",
    );
  }

  if (input.adapterType === AdapterType.BRIDGE) {
    promoteAccess(
      dimensions,
      "process",
      access,
      access === "read"
        ? "reads through an external CLI"
        : "may write through an external CLI",
    );
  }

  const resources = deriveResourceScope(input, dimensions);

  return {
    schema_version: "1",
    dimensions,
    summary: summaryFor(dimensions),
    resources,
    resource_summary: resourceSummaryFor(resources),
  };
}

function resourceFingerprintFor(resources: CapabilityResourceScope): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        accounts: normalizedUnique(resources.accounts),
        apps: normalizedUnique(resources.apps),
        domains: normalizedUnique(resources.domains),
        executables: normalizedUnique(resources.executables),
        paths: normalizedUnique(resources.paths),
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

export function buildCapabilityApprovalMemory(input: {
  site: string;
  command: string;
  profile: PermissionProfile;
  effect: OperationEffect;
  approved: boolean;
  approvalSource?: "none" | "invocation" | "env" | "memory";
  scope: CapabilityScope;
}): CapabilityApprovalMemory {
  const dimensionAccess = accessMapFor(input.scope.dimensions);
  const dimensionKey = DIMENSION_ORDER.map(
    (name) => `${name}:${dimensionAccess[name]}`,
  ).join(",");
  const resourceKey = resourceFingerprintFor(input.scope.resources);
  const approvalSource =
    input.approvalSource ?? (input.approved ? "invocation" : "none");

  return {
    schema_version: "1",
    key: `cap:1:${input.site}.${input.command}:${input.profile}:${input.effect}:${dimensionKey}:res:${resourceKey}`,
    persistence: approvalSource === "memory" ? "persisted" : "not_persisted",
    profile: input.profile,
    decision:
      approvalSource === "memory"
        ? "approved_by_memory"
        : input.approved
          ? "approved_for_invocation"
          : "not_approved",
    scope: {
      dimensions: dimensionAccess,
      resources: input.scope.resources,
    },
  };
}
