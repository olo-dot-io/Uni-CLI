/**
 * @owner       src::engine::permission-rules
 * @does        Parse strict JSON/YAML permission policies and evaluate deny-first semantic, resource, and argument constraints.
 * @needs       filesystem metadata, capability policy types, operation policy, RE2JS, YAML parser
 * @feeds       invocation authorization, fast-path policy gates, runtime resource guards, direct computer-use authorization
 * @breaks      Invalid or explicitly configured missing policies fail closed; default-deny policies never authorize without a matching allow rule.
 * @invariants  Deny rules outrank allow rules; regex matching is RE2-linear; runtime resource checks apply the same default decision and actual-argument constraints before side effects.
 * @side-effects Reads and caches local policy files.
 * @perf        Stable file metadata avoids reparsing; policy evaluation is linear in rules and bounded constraint input.
 * @concurrency Cache entries publish only after a stable before/after file read.
 * @test        tests/unit/permission-rules.test.ts, tests/unit/permission-surfaces.test.ts
 * @stability   stable
 * @since       2026-07-15
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  join,
  resolve as pathResolve,
} from "node:path";

import { RE2JS } from "re2js";
import { parseDocument } from "yaml";

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

export interface PermissionRuleEvaluationOptions {
  path?: string;
  homeDir?: string;
  argumentValues?: Record<string, unknown>;
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
  required: boolean;
}

type ResourceBucketName = keyof CapabilityResourceScope;
type RuleDecision = "allow" | "deny";

export interface RuntimeResourceCheckInput {
  site?: string;
  command?: string;
  effect?: OperationEffect;
  dimensions?: Partial<Record<CapabilityDimensionName, CapabilityAccess>>;
  resources?: Partial<Record<ResourceBucketName, string[]>>;
  resource_summary?: string[];
  argumentValues?: Record<string, unknown>;
}

interface ParsedArgumentConstraint {
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: {
    source: string;
    compiled: RE2JS;
  };
  allowed?: unknown[];
}

interface ParsedPermissionRule {
  id: string;
  decision: RuleDecision;
  match: {
    site?: string;
    command?: string;
    effect?: OperationEffect;
    dimensions?: Partial<Record<CapabilityDimensionName, CapabilityAccess>>;
    resources?: Partial<Record<ResourceBucketName, string[]>>;
    resource_summary?: string[];
    arguments?: Record<string, ParsedArgumentConstraint>;
  };
  reason: string;
}

interface ParsedPermissionDocument {
  schemaVersion: "1" | "2";
  defaultDecision: RuleDecision;
  rules: ParsedPermissionRule[];
}

interface RulesCacheEntry {
  fingerprint: string;
  document: ParsedPermissionDocument;
}

const ROOT_KEYS_V1 = new Set(["schema_version", "rules"]);
const ROOT_KEYS_V2 = new Set(["schema_version", "default", "rules"]);
const RULE_KEYS = new Set(["id", "decision", "match", "reason"]);
const MATCH_KEYS_V1 = new Set([
  "site",
  "command",
  "effect",
  "dimensions",
  "resources",
  "resource_summary",
]);
const MATCH_KEYS_V2 = new Set([...MATCH_KEYS_V1, "arguments"]);
const ARGUMENT_CONSTRAINT_KEYS = new Set([
  "min",
  "max",
  "max_length",
  "pattern",
  "allowed",
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
  "download_file",
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
const DECISION_VALUES = new Set<RuleDecision>(["allow", "deny"]);
const MAX_PERMISSION_FILE_BYTES = 1024 * 1024;
const MAX_PERMISSION_RULES = 10_000;
const MAX_ARGUMENTS_PER_RULE = 256;
const MAX_ALLOWED_VALUES = 1_024;
const MAX_PATTERN_LENGTH = 4_096;
const STABLE_READ_ATTEMPTS = 3;
const DEFAULT_DOCUMENT: ParsedPermissionDocument = {
  schemaVersion: "1",
  defaultDecision: "allow",
  rules: [],
};
const rulesCache = new Map<string, RulesCacheEntry>();

export function createPermissionRulesStore(
  options: { path?: string; homeDir?: string } = {},
): PermissionRulesStore {
  if (options.path !== undefined) {
    return { path: options.path, required: true };
  }
  const envPath = process.env.UNICLI_PERMISSION_RULES_PATH?.trim();
  if (envPath) return { path: envPath, required: true };
  return {
    path: join(
      options.homeDir ?? userHome(),
      ".unicli",
      "permission-rules.json",
    ),
    required: false,
  };
}

export async function findDenyRuleForPolicy(
  policy: OperationPolicy,
  options?: PermissionRuleEvaluationOptions,
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
  options?: PermissionRuleEvaluationOptions,
): PermissionRuleMatchResult | undefined {
  const document = readRules(createPermissionRulesStore(options));
  const matchingDeny = document.rules.find(
    (rule) =>
      rule.decision === "deny" &&
      ruleMatchesPolicy(rule, policy, options?.argumentValues),
  );
  if (matchingDeny) return denialForRule(matchingDeny);

  const matchingAllow = document.rules.some(
    (rule) =>
      rule.decision === "allow" &&
      ruleMatchesPolicy(rule, policy, options?.argumentValues),
  );
  if (matchingAllow || document.defaultDecision === "allow") return undefined;

  return {
    decision: "deny",
    id: "policy-default-deny",
    reason: "no allow rule matched and the permission policy defaults to deny",
  };
}

export function findDenyRuleForRuntimeResourceSync(
  input: RuntimeResourceCheckInput,
  options?: { path?: string; homeDir?: string },
): PermissionRuleMatchResult | undefined {
  const document = readRules(createPermissionRulesStore(options));
  const matchingDeny = document.rules.find(
    (rule) =>
      rule.decision === "deny" && ruleMatchesRuntimeResource(rule, input),
  );
  if (matchingDeny) return denialForRule(matchingDeny);

  const matchingAllow = document.rules.some(
    (rule) =>
      rule.decision === "allow" && ruleMatchesRuntimeResource(rule, input),
  );
  if (matchingAllow || document.defaultDecision === "allow") return undefined;

  return {
    decision: "deny",
    id: "policy-default-deny",
    reason: "no allow rule matched and the permission policy defaults to deny",
  };
}

function denialForRule(rule: ParsedPermissionRule): PermissionRuleMatchResult {
  return { decision: "deny", id: rule.id, reason: rule.reason };
}

function readRules(store: PermissionRulesStore): ParsedPermissionDocument {
  for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
    const before = readPolicyStats(store);
    if (!before) return DEFAULT_DOCUMENT;

    const cached = rulesCache.get(store.path);
    if (cached?.fingerprint === before.fingerprint) return cached.document;

    let raw: string;
    try {
      raw = readFileSync(store.path, "utf-8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw configReadError(store.path, error);
    }
    if (Buffer.byteLength(raw, "utf-8") > MAX_PERMISSION_FILE_BYTES) {
      throw invalid(
        store.path,
        `file exceeds ${String(MAX_PERMISSION_FILE_BYTES)} bytes`,
      );
    }

    const after = readPolicyStats(store);
    if (!after || before.fingerprint !== after.fingerprint) continue;

    const document = parseRulesDocument(
      parsePolicySource(raw, store.path),
      store.path,
    );
    rulesCache.set(store.path, {
      fingerprint: after.fingerprint,
      document,
    });
    return document;
  }
  throw new PermissionRulesConfigError(
    `permission rules file changed during ${String(STABLE_READ_ATTEMPTS)} consecutive reads at ${store.path}`,
  );
}

function readPolicyStats(
  store: PermissionRulesStore,
): { fingerprint: string } | undefined {
  try {
    const stats = statSync(store.path, { bigint: true });
    if (!stats.isFile()) {
      throw invalid(store.path, "configured path is not a regular file");
    }
    if (stats.size > BigInt(MAX_PERMISSION_FILE_BYTES)) {
      throw invalid(
        store.path,
        `file exceeds ${String(MAX_PERMISSION_FILE_BYTES)} bytes`,
      );
    }
    return {
      fingerprint: [
        stats.dev,
        stats.ino,
        stats.size,
        stats.mtimeNs,
        stats.ctimeNs,
      ].join(":"),
    };
  } catch (error) {
    if (error instanceof PermissionRulesConfigError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") {
      rulesCache.delete(store.path);
      if (!store.required) return undefined;
      throw new PermissionRulesConfigError(
        `configured permission rules file does not exist at ${store.path}`,
      );
    }
    throw configReadError(store.path, error);
  }
}

function configReadError(
  path: string,
  error: unknown,
): PermissionRulesConfigError {
  return new PermissionRulesConfigError(
    `failed to read permission rules file at ${path}: ${errorMessage(error)}`,
  );
}

function parsePolicySource(raw: string, path: string): unknown {
  const extension = extname(path).toLowerCase();
  if (extension === ".yaml" || extension === ".yml") {
    const document = parseDocument(raw, {
      uniqueKeys: true,
      strict: true,
      prettyErrors: false,
    });
    const diagnostics = [...document.errors, ...document.warnings];
    if (diagnostics.length > 0) {
      throw new PermissionRulesConfigError(
        `invalid permission rules YAML at ${path}: ${diagnostics[0]?.message ?? "unknown parse error"}`,
      );
    }
    try {
      return document.toJS({ maxAliasCount: 0, mapAsMap: false });
    } catch (error) {
      throw new PermissionRulesConfigError(
        `invalid permission rules YAML at ${path}: ${errorMessage(error)}`,
      );
    }
  }

  if (extension !== "" && extension !== ".json") {
    throw new PermissionRulesConfigError(
      `unsupported permission rules format at ${path}; expected .json, .yaml, or .yml`,
    );
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new PermissionRulesConfigError(
      `invalid permission rules JSON at ${path}: ${errorMessage(error)}`,
    );
  }
}

function parseRulesDocument(
  value: unknown,
  path: string,
): ParsedPermissionDocument {
  const root = expectRecord(value, path, "root");
  const schemaVersion = expectString(
    root.schema_version,
    path,
    "schema_version",
  );
  if (schemaVersion !== "1" && schemaVersion !== "2") {
    throw invalid(path, 'schema_version must be "1" or "2"');
  }
  rejectUnknownKeys(
    root,
    schemaVersion === "1" ? ROOT_KEYS_V1 : ROOT_KEYS_V2,
    path,
    "root",
  );
  const defaultDecision =
    schemaVersion === "1"
      ? "allow"
      : expectDecision(root.default, path, "default");
  if (!Array.isArray(root.rules)) {
    throw invalid(path, "rules must be an array");
  }
  if (root.rules.length > MAX_PERMISSION_RULES) {
    throw invalid(
      path,
      `rules cannot contain more than ${String(MAX_PERMISSION_RULES)} entries`,
    );
  }
  const rules = root.rules.map((rule, index) =>
    parseRule(rule, path, index, schemaVersion),
  );
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw invalid(path, `duplicate rule id ${rule.id}`);
    ids.add(rule.id);
  }
  return { schemaVersion, defaultDecision, rules };
}

function parseRule(
  value: unknown,
  path: string,
  index: number,
  schemaVersion: "1" | "2",
): ParsedPermissionRule {
  const label = `rules[${index}]`;
  const rule = expectRecord(value, path, label);
  rejectUnknownKeys(rule, RULE_KEYS, path, label);
  const id = expectString(rule.id, path, `${label}.id`);
  if (id.length === 0) throw invalid(path, `${label}.id cannot be empty`);
  const decision =
    schemaVersion === "1"
      ? expectLiteralDecision(rule.decision, "deny", path, `${label}.decision`)
      : expectDecision(rule.decision, path, `${label}.decision`);
  const match = parseMatch(rule.match, path, `${label}.match`, schemaVersion);
  const reason =
    rule.reason === undefined
      ? `${decision === "deny" ? "blocked" : "allowed"} by permission rule ${id}`
      : expectString(rule.reason, path, `${label}.reason`);
  if (reason.length === 0)
    throw invalid(path, `${label}.reason cannot be empty`);
  return { id, decision, match, reason };
}

function parseMatch(
  value: unknown,
  path: string,
  label: string,
  schemaVersion: "1" | "2",
): ParsedPermissionRule["match"] {
  const match = expectRecord(value, path, label);
  rejectUnknownKeys(
    match,
    schemaVersion === "1" ? MATCH_KEYS_V1 : MATCH_KEYS_V2,
    path,
    label,
  );
  const out: ParsedPermissionRule["match"] = {};

  if (match.site !== undefined) {
    out.site = expectNonEmptyString(match.site, path, `${label}.site`);
  }
  if (match.command !== undefined) {
    out.command = expectNonEmptyString(match.command, path, `${label}.command`);
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
  if (match.arguments !== undefined) {
    out.arguments = parseArgumentConstraints(
      match.arguments,
      path,
      `${label}.arguments`,
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

function parseArgumentConstraints(
  value: unknown,
  path: string,
  label: string,
): Record<string, ParsedArgumentConstraint> {
  const rawConstraints = expectRecord(value, path, label);
  const entries = Object.entries(rawConstraints);
  if (entries.length === 0) throw invalid(path, `${label} cannot be empty`);
  if (entries.length > MAX_ARGUMENTS_PER_RULE) {
    throw invalid(
      path,
      `${label} cannot contain more than ${String(MAX_ARGUMENTS_PER_RULE)} arguments`,
    );
  }
  const out: Record<string, ParsedArgumentConstraint> = {};
  for (const [name, rawConstraint] of entries) {
    if (name.trim().length === 0) {
      throw invalid(path, `${label} argument names cannot be empty`);
    }
    out[name] = parseArgumentConstraint(
      rawConstraint,
      path,
      `${label}.${name}`,
    );
  }
  return out;
}

function parseArgumentConstraint(
  value: unknown,
  path: string,
  label: string,
): ParsedArgumentConstraint {
  const constraint = expectRecord(value, path, label);
  rejectUnknownKeys(constraint, ARGUMENT_CONSTRAINT_KEYS, path, label);
  if (Object.keys(constraint).length === 0) {
    throw invalid(path, `${label} must define at least one constraint`);
  }
  const out: ParsedArgumentConstraint = {};
  if (constraint.min !== undefined) {
    out.min = expectFiniteNumber(constraint.min, path, `${label}.min`);
  }
  if (constraint.max !== undefined) {
    out.max = expectFiniteNumber(constraint.max, path, `${label}.max`);
  }
  if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
    throw invalid(path, `${label}.min cannot exceed ${label}.max`);
  }
  if (constraint.max_length !== undefined) {
    const maxLength = expectFiniteNumber(
      constraint.max_length,
      path,
      `${label}.max_length`,
    );
    if (!Number.isSafeInteger(maxLength) || maxLength < 0) {
      throw invalid(
        path,
        `${label}.max_length must be a non-negative safe integer`,
      );
    }
    out.maxLength = maxLength;
  }
  if (constraint.pattern !== undefined) {
    const source = expectRawString(
      constraint.pattern,
      path,
      `${label}.pattern`,
    );
    if (source.length === 0)
      throw invalid(path, `${label}.pattern cannot be empty`);
    if (source.length > MAX_PATTERN_LENGTH) {
      throw invalid(
        path,
        `${label}.pattern cannot exceed ${String(MAX_PATTERN_LENGTH)} UTF-16 code units`,
      );
    }
    try {
      out.pattern = { source, compiled: RE2JS.compile(source) };
    } catch (error) {
      throw invalid(
        path,
        `${label}.pattern is invalid RE2 syntax: ${errorMessage(error)}`,
      );
    }
  }
  if (constraint.allowed !== undefined) {
    if (!Array.isArray(constraint.allowed)) {
      throw invalid(path, `${label}.allowed must be an array`);
    }
    if (constraint.allowed.length === 0) {
      throw invalid(path, `${label}.allowed cannot be empty`);
    }
    if (constraint.allowed.length > MAX_ALLOWED_VALUES) {
      throw invalid(
        path,
        `${label}.allowed cannot contain more than ${String(MAX_ALLOWED_VALUES)} values`,
      );
    }
    constraint.allowed.forEach((item, index) =>
      assertJsonValue(item, path, `${label}.allowed[${index}]`),
    );
    out.allowed = constraint.allowed;
  }
  return out;
}

function ruleMatchesPolicy(
  rule: ParsedPermissionRule,
  policy: OperationPolicy,
  argumentValues?: Record<string, unknown>,
): boolean {
  const match = rule.match;
  const commandRef = commandRefFromPolicy(policy);
  if (match.site !== undefined && match.site !== commandRef.site) return false;
  if (match.command !== undefined && match.command !== commandRef.command) {
    return false;
  }
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
        !values.some((value) =>
          bucket.some((actual) =>
            resourceValueMatches(name as ResourceBucketName, value, actual),
          ),
        )
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

  return argumentConstraintsMatch(match.arguments, argumentValues);
}

function argumentConstraintsMatch(
  constraints: Record<string, ParsedArgumentConstraint> | undefined,
  argumentValues: Record<string, unknown> | undefined,
): boolean {
  if (!constraints) return true;
  if (!argumentValues) return false;
  for (const [name, constraint] of Object.entries(constraints)) {
    if (!Object.hasOwn(argumentValues, name)) return false;
    if (!argumentMatchesConstraint(argumentValues[name], constraint)) {
      return false;
    }
  }
  return true;
}

function argumentMatchesConstraint(
  actual: unknown,
  constraint: ParsedArgumentConstraint,
): boolean {
  if (constraint.min !== undefined) {
    if (
      typeof actual !== "number" ||
      !Number.isFinite(actual) ||
      actual < constraint.min
    ) {
      return false;
    }
  }
  if (constraint.max !== undefined) {
    if (
      typeof actual !== "number" ||
      !Number.isFinite(actual) ||
      actual > constraint.max
    ) {
      return false;
    }
  }
  if (constraint.maxLength !== undefined) {
    if (
      typeof actual !== "string" ||
      [...actual].length > constraint.maxLength
    ) {
      return false;
    }
  }
  if (
    constraint.pattern &&
    (typeof actual !== "string" || !constraint.pattern.compiled.test(actual))
  ) {
    return false;
  }
  if (
    constraint.allowed &&
    !constraint.allowed.some((allowed) => jsonValueEquals(actual, allowed))
  ) {
    return false;
  }
  return true;
}

function ruleMatchesRuntimeResource(
  rule: ParsedPermissionRule,
  input: RuntimeResourceCheckInput,
): boolean {
  const match = rule.match;
  if (match.site !== undefined && match.site !== input.site) return false;
  if (match.command !== undefined && match.command !== input.command)
    return false;
  if (match.effect !== undefined && match.effect !== input.effect) return false;

  if (match.dimensions) {
    for (const [name, access] of Object.entries(match.dimensions)) {
      if (input.dimensions?.[name as CapabilityDimensionName] !== access) {
        return false;
      }
    }
  }

  if (match.resources) {
    for (const [name, values] of Object.entries(match.resources)) {
      const bucket = input.resources?.[name as ResourceBucketName] ?? [];
      if (
        !values.some((value) =>
          bucket.some((actual) =>
            resourceValueMatches(name as ResourceBucketName, value, actual),
          ),
        )
      ) {
        return false;
      }
    }
  }

  if (match.resource_summary) {
    const summary = input.resource_summary ?? [];
    if (
      !match.resource_summary.some((value) =>
        summary.includes(normalizeComparable(value)),
      )
    ) {
      return false;
    }
  }

  return argumentConstraintsMatch(match.arguments, input.argumentValues);
}

function resourceValueMatches(
  bucket: ResourceBucketName,
  ruleValue: string,
  actualValue: string,
): boolean {
  if (bucket === "domains") {
    const ruleDomain = normalizeDomainComparable(ruleValue);
    const actualDomain = normalizeDomainComparable(actualValue);
    return (
      actualDomain === ruleDomain || actualDomain.endsWith(`.${ruleDomain}`)
    );
  }
  if (bucket === "paths") {
    const rulePath = normalizePathComparable(ruleValue);
    const actualPath = normalizePathComparable(actualValue);
    return actualPath === rulePath || actualPath.startsWith(`${rulePath}/`);
  }
  if (bucket === "executables") {
    const ruleExecutable = normalizeComparable(ruleValue);
    if (ruleValue.includes("/") || ruleValue.includes("\\")) {
      return normalizeComparable(actualValue) === ruleExecutable;
    }
    return normalizeExecutableComparable(actualValue) === ruleExecutable;
  }
  return normalizeComparable(actualValue) === normalizeComparable(ruleValue);
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

function assertJsonValue(value: unknown, path: string, label: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(path, `${label} must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertJsonValue(item, path, `${label}[${index}]`),
    );
    return;
  }
  if (isPlainRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, path, `${label}.${key}`);
    }
    return;
  }
  throw invalid(path, `${label} must be a JSON value`);
}

function jsonValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => jsonValueEquals(item, right[index]))
    );
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && jsonValueEquals(left[key], right[key]),
      )
    );
  }
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function expectRecord(
  value: unknown,
  path: string,
  label: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw invalid(path, `${label} must be an object`);
  return value;
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

function expectDecision(
  value: unknown,
  path: string,
  label: string,
): RuleDecision {
  const decision = expectString(value, path, label);
  if (!DECISION_VALUES.has(decision as RuleDecision)) {
    throw invalid(path, `${label} must be "allow" or "deny"`);
  }
  return decision as RuleDecision;
}

function expectLiteralDecision(
  value: unknown,
  expected: RuleDecision,
  path: string,
  label: string,
): RuleDecision {
  if (value !== expected) {
    throw invalid(path, `${label} must be ${JSON.stringify(expected)}`);
  }
  return expected;
}

function expectRawString(value: unknown, path: string, label: string): string {
  if (typeof value !== "string")
    throw invalid(path, `${label} must be a string`);
  return value;
}

function expectString(value: unknown, path: string, label: string): string {
  return expectRawString(value, path, label).trim();
}

function expectNonEmptyString(
  value: unknown,
  path: string,
  label: string,
): string {
  const result = expectString(value, path, label);
  if (result.length === 0) throw invalid(path, `${label} cannot be empty`);
  return result;
}

function expectFiniteNumber(
  value: unknown,
  path: string,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(path, `${label} must be a finite number`);
  }
  return value;
}

function expectStringArray(
  value: unknown,
  path: string,
  label: string,
): string[] {
  if (!Array.isArray(value)) throw invalid(path, `${label} must be an array`);
  const out = value.map((item, index) =>
    expectNonEmptyString(item, path, `${label}[${index}]`),
  );
  if (out.length === 0) throw invalid(path, `${label} cannot be empty`);
  return out;
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDomainComparable(value: string): string {
  const raw = normalizeComparable(value);
  try {
    return stripTrailingDomainDot(
      new URL(raw.includes("://") ? raw : `https://${raw}`).hostname,
    );
  } catch {
    return stripTrailingDomainDot(
      raw.replace(/^https?:\/\//, "").split("/")[0] ?? raw,
    );
  }
}

function stripTrailingDomainDot(value: string): string {
  return value.replace(/\.+$/, "");
}

function normalizePathComparable(value: string): string {
  const raw = value.trim().replace(/\\/g, "/");
  if (raw === "/") return raw;
  const comparable = isWindowsDrivePath(raw) ? raw : realpathAwarePath(raw);
  return normalizeComparable(
    comparable.replace(/\\/g, "/").replace(/\/+$/, ""),
  );
}

function realpathAwarePath(path: string): string {
  if (!path.startsWith("/")) return path;
  const resolved = pathResolve(path);
  const missing: string[] = [];
  let current = resolved;

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolved;
    missing.unshift(basename(current));
    current = parent;
  }

  try {
    const real = realpathSync(current);
    return missing.length > 0 ? join(real, ...missing) : real;
  } catch {
    return resolved;
  }
}

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value);
}

function normalizeExecutableComparable(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return normalizeComparable(parts.at(-1) ?? normalized);
}

function invalid(path: string, message: string): PermissionRulesConfigError {
  return new PermissionRulesConfigError(
    `invalid permission rules at ${path}: ${message}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
