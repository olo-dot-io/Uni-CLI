import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  CapabilityAccess,
  CapabilityDimensionName,
  CapabilityResourceScope,
} from "./capability-policy.js";
import type { OperationEffect, OperationPolicy } from "./operation-policy.js";
import { userHome } from "./user-home.js";

export interface PermissionRuleMatchResult {
  decision: "deny";
  id: string;
  reason: string;
}

export class PermissionRulesConfigError extends Error {
  readonly code = "invalid_input";
  readonly suggestion = "fix or remove the permission rules file";

  constructor(message: string) {
    super(message);
    this.name = "PermissionRulesConfigError";
  }
}

interface PermissionRulesStore {
  path: string;
}

type ResourceBucketName = keyof CapabilityResourceScope;

interface ParsedPermissionRule {
  id: string;
  decision: "deny";
  match: {
    site?: string;
    command?: string;
    effect?: OperationEffect;
    dimensions?: Partial<Record<CapabilityDimensionName, CapabilityAccess>>;
    resources?: Partial<Record<ResourceBucketName, string[]>>;
    resource_summary?: string[];
  };
  reason: string;
}

const ROOT_KEYS = new Set(["schema_version", "rules"]);
const RULE_KEYS = new Set(["id", "decision", "match", "reason"]);
const MATCH_KEYS = new Set([
  "site",
  "command",
  "effect",
  "dimensions",
  "resources",
  "resource_summary",
]);
const DIMENSION_KEYS = new Set<CapabilityDimensionName>([
  "network",
  "browser",
  "desktop",
  "file",
  "process",
  "account",
]);
const ACCESS_VALUES = new Set<CapabilityAccess>(["none", "read", "write"]);
const EFFECT_VALUES = new Set<OperationEffect>([
  "read",
  "send_message",
  "publish_content",
  "account_state",
  "remote_transform",
  "remote_resource",
  "service_state",
  "local_app",
  "local_file",
  "destructive",
  "unknown_write",
]);
const RESOURCE_KEYS = new Set<ResourceBucketName>([
  "domains",
  "paths",
  "executables",
  "apps",
  "accounts",
]);

export function createPermissionRulesStore(options?: {
  path?: string;
  homeDir?: string;
}): PermissionRulesStore {
  const envPath = process.env.UNICLI_PERMISSION_RULES_PATH?.trim();
  return {
    path:
      options?.path ??
      (envPath && envPath.length > 0
        ? envPath
        : join(
            options?.homeDir ?? userHome(),
            ".unicli",
            "permission-rules.json",
          )),
  };
}

export async function findDenyRuleForPolicy(
  policy: OperationPolicy,
  options?: { path?: string; homeDir?: string },
): Promise<PermissionRuleMatchResult | undefined> {
  return findDenyRuleForPolicySync(policy, options);
}

export function applyDenyRuleToPolicy(
  policy: OperationPolicy,
  rule: PermissionRuleMatchResult,
): OperationPolicy {
  return {
    ...policy,
    approval_required: true,
    approved: false,
    enforcement: "deny",
    reason: `blocked by permission rule "${rule.id}": ${rule.reason}`,
    approval_hint: "edit or remove the matching permission rule",
    deny_rule: {
      id: rule.id,
      reason: rule.reason,
    },
    deny_reason: rule.reason,
  };
}

export function findDenyRuleForPolicySync(
  policy: OperationPolicy,
  options?: { path?: string; homeDir?: string },
): PermissionRuleMatchResult | undefined {
  const store = createPermissionRulesStore(options);
  const rules = readRules(store.path);
  const matched = rules.find((rule) => ruleMatchesPolicy(rule, policy));
  if (!matched) return undefined;
  return {
    decision: "deny",
    id: matched.id,
    reason: matched.reason,
  };
}

function readRules(path: string): ParsedPermissionRule[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw new PermissionRulesConfigError(
      `failed to read permission rules file at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PermissionRulesConfigError(
      `invalid permission rules JSON at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseRulesDocument(parsed, path);
}

function parseRulesDocument(
  value: unknown,
  path: string,
): ParsedPermissionRule[] {
  const root = expectRecord(value, path, "root");
  rejectUnknownKeys(root, ROOT_KEYS, path, "root");
  expectLiteral(root.schema_version, "1", path, "schema_version");
  if (!Array.isArray(root.rules)) {
    throw invalid(path, "rules must be an array");
  }
  return root.rules.map((rule, index) => parseRule(rule, path, index));
}

function parseRule(
  value: unknown,
  path: string,
  index: number,
): ParsedPermissionRule {
  const label = `rules[${index}]`;
  const rule = expectRecord(value, path, label);
  rejectUnknownKeys(rule, RULE_KEYS, path, label);
  const id = expectString(rule.id, path, `${label}.id`);
  if (id.length === 0) throw invalid(path, `${label}.id cannot be empty`);
  expectLiteral(rule.decision, "deny", path, `${label}.decision`);
  const match = parseMatch(rule.match, path, `${label}.match`);
  const reason =
    rule.reason === undefined
      ? `blocked by permission rule ${id}`
      : expectString(rule.reason, path, `${label}.reason`);
  return { id, decision: "deny", match, reason };
}

function parseMatch(
  value: unknown,
  path: string,
  label: string,
): ParsedPermissionRule["match"] {
  const match = expectRecord(value, path, label);
  rejectUnknownKeys(match, MATCH_KEYS, path, label);
  const out: ParsedPermissionRule["match"] = {};

  if (match.site !== undefined)
    out.site = expectString(match.site, path, `${label}.site`);
  if (match.command !== undefined) {
    out.command = expectString(match.command, path, `${label}.command`);
  }
  if (match.effect !== undefined) {
    const effect = expectString(match.effect, path, `${label}.effect`);
    if (!EFFECT_VALUES.has(effect as OperationEffect)) {
      throw invalid(path, `${label}.effect is not a known operation effect`);
    }
    out.effect = effect as OperationEffect;
  }
  if (match.dimensions !== undefined) {
    out.dimensions = parseDimensions(
      match.dimensions,
      path,
      `${label}.dimensions`,
    );
  }
  if (match.resources !== undefined) {
    out.resources = parseResources(match.resources, path, `${label}.resources`);
  }
  if (match.resource_summary !== undefined) {
    out.resource_summary = expectStringArray(
      match.resource_summary,
      path,
      `${label}.resource_summary`,
    );
  }

  return out;
}

function parseDimensions(
  value: unknown,
  path: string,
  label: string,
): Partial<Record<CapabilityDimensionName, CapabilityAccess>> {
  const dimensions = expectRecord(value, path, label);
  const out: Partial<Record<CapabilityDimensionName, CapabilityAccess>> = {};
  for (const [key, raw] of Object.entries(dimensions)) {
    if (!DIMENSION_KEYS.has(key as CapabilityDimensionName)) {
      throw invalid(
        path,
        `${label}.${key} is not a known capability dimension`,
      );
    }
    const access = expectString(raw, path, `${label}.${key}`);
    if (!ACCESS_VALUES.has(access as CapabilityAccess)) {
      throw invalid(path, `${label}.${key} is not a known access value`);
    }
    out[key as CapabilityDimensionName] = access as CapabilityAccess;
  }
  return out;
}

function parseResources(
  value: unknown,
  path: string,
  label: string,
): Partial<Record<ResourceBucketName, string[]>> {
  const resources = expectRecord(value, path, label);
  const out: Partial<Record<ResourceBucketName, string[]>> = {};
  for (const [key, raw] of Object.entries(resources)) {
    if (!RESOURCE_KEYS.has(key as ResourceBucketName)) {
      throw invalid(path, `${label}.${key} is not a known resource bucket`);
    }
    out[key as ResourceBucketName] = expectStringArray(
      raw,
      path,
      `${label}.${key}`,
    );
  }
  return out;
}

function ruleMatchesPolicy(
  rule: ParsedPermissionRule,
  policy: OperationPolicy,
): boolean {
  const match = rule.match;
  const commandRef = commandRefFromPolicy(policy);
  if (match.site !== undefined && match.site !== commandRef.site) return false;
  const command = commandRef.command;
  if (match.command !== undefined && match.command !== command) return false;
  if (match.effect !== undefined && match.effect !== policy.effect)
    return false;

  if (match.dimensions) {
    for (const [name, access] of Object.entries(match.dimensions)) {
      if (
        policy.capability_scope.dimensions[name as CapabilityDimensionName]
          ?.access !== access
      ) {
        return false;
      }
    }
  }

  if (match.resources) {
    for (const [name, values] of Object.entries(match.resources)) {
      const bucket =
        policy.capability_scope.resources[name as ResourceBucketName] ?? [];
      if (
        !values.some((value) => bucket.includes(normalizeComparable(value)))
      ) {
        return false;
      }
    }
  }

  if (match.resource_summary) {
    const summary = policy.capability_scope.resource_summary;
    if (
      !match.resource_summary.some((value) =>
        summary.includes(normalizeComparable(value)),
      )
    ) {
      return false;
    }
  }

  return true;
}

function commandRefFromPolicy(policy: OperationPolicy): {
  site: string;
  command: string;
} {
  const commandRef =
    policy.approval_memory.key.split(":")[2] ?? "unknown.unknown";
  const lastDot = commandRef.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === commandRef.length - 1) {
    return { site: "unknown", command: "unknown" };
  }
  return {
    site: commandRef.slice(0, lastDot),
    command: commandRef.slice(lastDot + 1),
  };
}

function expectRecord(
  value: unknown,
  path: string,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(path, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw invalid(path, `${label}.${key} is not allowed`);
  }
}

function expectLiteral(
  value: unknown,
  expected: string,
  path: string,
  label: string,
): void {
  if (value !== expected) {
    throw invalid(path, `${label} must be ${JSON.stringify(expected)}`);
  }
}

function expectString(value: unknown, path: string, label: string): string {
  if (typeof value !== "string")
    throw invalid(path, `${label} must be a string`);
  return value.trim();
}

function expectStringArray(
  value: unknown,
  path: string,
  label: string,
): string[] {
  if (!Array.isArray(value)) throw invalid(path, `${label} must be an array`);
  const out = value.map((item, index) =>
    expectString(item, path, `${label}[${index}]`),
  );
  if (out.length === 0) throw invalid(path, `${label} cannot be empty`);
  return out;
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

function invalid(path: string, message: string): PermissionRulesConfigError {
  return new PermissionRulesConfigError(
    `invalid permission rules at ${path}: ${message}`,
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
