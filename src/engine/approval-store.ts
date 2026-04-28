import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CapabilityApprovalMemory } from "./capability-policy.js";
import type { OperationEffect, OperationPolicy } from "./operation-policy.js";
import { userHome } from "./user-home.js";

const APPROVAL_DIMENSIONS = [
  "network",
  "browser",
  "desktop",
  "file",
  "process",
  "account",
] as const;

const APPROVAL_ACCESS = new Set(["none", "read", "write"]);

export interface ApprovalStore {
  path: string;
}

export type ApprovalDecision = "allow" | "revoke";

export interface StoredApproval {
  schema_version: "1";
  key: string;
  decision: ApprovalDecision;
  profile: string;
  created_at: string;
  command: {
    site: string;
    command: string;
    effect: OperationEffect;
  };
  scope: CapabilityApprovalMemory["scope"];
}

export interface RememberApprovalOptions {
  policy: OperationPolicy;
  now?: () => Date;
}

export interface ApprovalMutationOptions {
  now?: () => Date;
}

export function createApprovalStore(
  options: {
    path?: string;
    homeDir?: string;
  } = {},
): ApprovalStore {
  const path =
    options.path ??
    (options.homeDir !== undefined
      ? join(options.homeDir, ".unicli", "approvals.jsonl")
      : (process.env.UNICLI_APPROVALS_PATH ??
        join(userHome(), ".unicli", "approvals.jsonl")));
  return { path };
}

export async function rememberApproval(
  store: ApprovalStore,
  options: RememberApprovalOptions,
): Promise<StoredApproval | undefined> {
  const policy = options.policy;
  if (!policy.approved || !policy.approval_required) return undefined;
  if (policy.approval_memory.decision === "approved_by_memory") {
    return undefined;
  }

  const entry: StoredApproval = {
    schema_version: "1",
    key: policy.approval_memory.key,
    decision: "allow",
    profile: policy.profile,
    created_at: (options.now ?? (() => new Date()))().toISOString(),
    command: {
      ...commandFromApprovalKey(policy.approval_memory.key),
      effect: policy.effect,
    },
    scope: policy.approval_memory.scope,
  };

  await appendApprovalEntry(store, entry);
  return entry;
}

export async function findStoredApproval(
  store: ApprovalStore,
  key: string,
): Promise<StoredApproval | undefined> {
  const entries = await listStoredApprovals(store);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.key !== key) continue;
    if (entry.decision === "revoke") return undefined;
    return entry;
  }
  return undefined;
}

export async function listActiveStoredApprovals(
  store: ApprovalStore,
): Promise<StoredApproval[]> {
  const byKey = new Map<string, StoredApproval>();
  for (const entry of await listStoredApprovals(store)) {
    if (entry.decision === "allow") {
      byKey.set(entry.key, entry);
    } else {
      byKey.delete(entry.key);
    }
  }
  return Array.from(byKey.values());
}

export async function revokeStoredApproval(
  store: ApprovalStore,
  key: string,
  options: ApprovalMutationOptions = {},
): Promise<StoredApproval | undefined> {
  const active = await findStoredApproval(store, key);
  if (!active) return undefined;

  const entry: StoredApproval = {
    ...active,
    decision: "revoke",
    created_at: (options.now ?? (() => new Date()))().toISOString(),
  };
  await appendApprovalEntry(store, entry);
  return entry;
}

export async function clearStoredApprovals(
  store: ApprovalStore,
  options: ApprovalMutationOptions = {},
): Promise<number> {
  const active = await listActiveStoredApprovals(store);
  const now = (options.now ?? (() => new Date()))().toISOString();
  for (const entry of active) {
    await appendApprovalEntry(store, {
      ...entry,
      decision: "revoke",
      created_at: now,
    });
  }
  return active.length;
}

export async function listStoredApprovals(
  store: ApprovalStore,
): Promise<StoredApproval[]> {
  if (!existsSync(store.path)) return [];

  let raw: string;
  try {
    raw = await readFile(store.path, "utf-8");
  } catch (error) {
    if (process.env.UNICLI_DEBUG === "1") {
      console.error(
        `Failed to read approval store at ${store.path}; treating as empty.`,
        error,
      );
    }
    return [];
  }

  const entries: StoredApproval[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as StoredApproval;
      if (isStoredApproval(parsed)) entries.push(parsed);
    } catch {
      // User-local approval memory should be best-effort; one bad line must
      // not silently widen permissions, so malformed entries are ignored.
    }
  }
  return entries;
}

async function appendApprovalEntry(
  store: ApprovalStore,
  entry: StoredApproval,
): Promise<void> {
  const dir = dirname(store.path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(dir, 0o700);
  }
  await appendFile(store.path, `${JSON.stringify(entry)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  if (process.platform !== "win32") {
    await chmod(store.path, 0o600);
  }
}

function commandFromApprovalKey(key: string): {
  site: string;
  command: string;
} {
  const commandRef = key.split(":")[2] ?? "unknown.unknown";
  const lastDot = commandRef.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === commandRef.length - 1) {
    return { site: "unknown", command: "unknown" };
  }
  return {
    site: commandRef.slice(0, lastDot),
    command: commandRef.slice(lastDot + 1),
  };
}

export function isStoredApproval(value: unknown): value is StoredApproval {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  const command = rec.command as Record<string, unknown> | null;
  return (
    rec.schema_version === "1" &&
    typeof rec.key === "string" &&
    (rec.decision === "allow" || rec.decision === "revoke") &&
    typeof rec.profile === "string" &&
    typeof rec.created_at === "string" &&
    typeof rec.command === "object" &&
    command !== null &&
    typeof command.site === "string" &&
    typeof command.command === "string" &&
    typeof command.effect === "string" &&
    isApprovalScope(rec.scope)
  );
}

function isApprovalScope(value: unknown): value is StoredApproval["scope"] {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  if (!scope.dimensions || typeof scope.dimensions !== "object") return false;
  const dimensions = scope.dimensions as Record<string, unknown>;
  return APPROVAL_DIMENSIONS.every((name) =>
    APPROVAL_ACCESS.has(String(dimensions[name])),
  );
}
