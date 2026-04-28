import { resolve } from "node:path";

import { PipelineError, type PipelineContext } from "./executor.js";
import type { CapabilityAccess } from "./capability-policy.js";
import type { OperationEffect } from "./operation-policy.js";
import {
  findDenyRuleForRuntimeResourceSync,
  type RuntimeResourceCheckInput,
} from "./permission-rules.js";

interface RuntimeResourceGuardOptions {
  action: string;
  step: number;
  config: unknown;
}

export function assertRuntimeNetworkAllowed(
  ctx: PipelineContext,
  options: RuntimeResourceGuardOptions & {
    url: string;
    access?: Extract<CapabilityAccess, "read" | "write">;
    effect?: OperationEffect;
  },
): void {
  const domain = domainFromUrl(options.url);
  if (!domain) return;
  const access = options.access ?? "read";
  assertRuntimeResourceAllowed(
    ctx,
    {
      effect:
        options.effect ?? (access === "read" ? "read" : "remote_resource"),
      dimensions: { network: access },
      resources: { domains: [domain] },
      resource_summary: [`domain:${domain}`],
    },
    options,
  );
}

export function assertRuntimePathAllowed(
  ctx: PipelineContext,
  options: RuntimeResourceGuardOptions & {
    path: string;
    access?: Extract<CapabilityAccess, "read" | "write">;
    effect?: OperationEffect;
  },
): void {
  const path = normalizePath(options.path);
  assertRuntimeResourceAllowed(
    ctx,
    {
      effect: options.effect ?? "local_file",
      dimensions: { file: options.access ?? "write" },
      resources: { paths: [path] },
      resource_summary: [`path:${path}`],
    },
    options,
  );
}

export function assertRuntimeExecutableAllowed(
  ctx: PipelineContext,
  options: RuntimeResourceGuardOptions & {
    command: string;
  },
): void {
  assertRuntimeResourceAllowed(
    ctx,
    {
      effect: "local_app",
      dimensions: { process: "write" },
      resources: { executables: [options.command] },
      resource_summary: [`executable:${options.command}`],
    },
    options,
  );
}

function assertRuntimeResourceAllowed(
  ctx: PipelineContext,
  input: RuntimeResourceCheckInput,
  options: RuntimeResourceGuardOptions,
): void {
  const rule = findDenyRuleForRuntimeResourceSync({
    site: ctx.site,
    command: ctx.command,
    ...input,
  });
  if (!rule) return;

  throw new PipelineError(
    `permission rule "${rule.id}" denies runtime resource: ${rule.reason}`,
    {
      step: options.step,
      action: options.action,
      config: {
        rule_id: rule.id,
        resources: input.resources,
      },
      errorType: "permission_denied",
      suggestion: `Edit or remove permission rule "${rule.id}" in ~/.unicli/permission-rules.json.`,
      retryable: false,
      alternatives: ["unicli --dry-run <site> <command>"],
    },
  );
}

function domainFromUrl(raw: string): string | undefined {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizePath(path: string): string {
  return resolve(path);
}
