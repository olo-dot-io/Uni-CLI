import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createApprovalStore,
  clearStoredApprovals,
  findStoredApproval,
  listActiveStoredApprovals,
  listStoredApprovals,
  rememberApproval,
  revokeStoredApproval,
} from "../../src/engine/approval-store.js";
import { evaluateOperationPolicyWithApprovals } from "../../src/engine/permission-runtime.js";
import { evaluateOperationPolicy } from "../../src/engine/operation-policy.js";

describe("persistent approval store", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "unicli-approval-store-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes private approval entries without raw runtime args", async () => {
    const store = createApprovalStore({ homeDir: tmp });
    const policy = evaluateOperationPolicy({
      site: "slack",
      command: "send",
      args: [{ name: "text", required: true }],
      profile: "confirm",
      approved: true,
    });

    await rememberApproval(store, {
      policy,
      now: () => new Date("2026-04-29T00:00:00.000Z"),
    });

    expect(existsSync(store.path)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(tmp, ".unicli")).mode & 0o777).toBe(0o700);
      expect(statSync(store.path).mode & 0o777).toBe(0o600);
    }

    const raw = readFileSync(store.path, "utf-8");
    expect(raw).toContain("slack.send");
    expect(raw).not.toContain("hello");
    expect(raw).not.toContain("secret text");

    const entries = await listStoredApprovals(store);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      schema_version: "1",
      key: policy.approval_memory.key,
      decision: "allow",
      command: {
        site: "slack",
        command: "send",
        effect: "send_message",
      },
    });
  });

  it("uses stored approvals to allow strict profiles without --yes", async () => {
    const store = createApprovalStore({ homeDir: tmp });
    const input = {
      site: "twitter",
      command: "post",
      args: [{ name: "text", required: true }],
      profile: "confirm",
    };

    const before = await evaluateOperationPolicyWithApprovals(input, { store });
    expect(before.enforcement).toBe("needs_approval");

    await rememberApproval(store, {
      policy: evaluateOperationPolicy({ ...input, approved: true }),
      now: () => new Date("2026-04-29T00:00:00.000Z"),
    });

    const after = await evaluateOperationPolicyWithApprovals(input, { store });
    expect(after).toMatchObject({
      enforcement: "allow",
      approved: true,
      approval_memory: {
        persistence: "persisted",
        decision: "approved_by_memory",
      },
    });

    const stored = await findStoredApproval(store, after.approval_memory.key);
    expect(stored?.key).toBe(after.approval_memory.key);
  });

  it("treats unreadable approval stores as empty", async () => {
    const store = createApprovalStore({ path: join(tmp, "approvals.jsonl") });
    mkdirSync(store.path);

    await expect(listStoredApprovals(store)).resolves.toEqual([]);
    await expect(findStoredApproval(store, "any-key")).resolves.toBeUndefined();
  });

  it("skips malformed approval entries with missing scope dimensions", async () => {
    const store = createApprovalStore({ path: join(tmp, "approvals.jsonl") });
    writeFileSync(
      store.path,
      `${JSON.stringify({
        schema_version: "1",
        key: "cap:1:slack.send:confirm:send_message:network:write",
        decision: "allow",
        profile: "confirm",
        created_at: "2026-04-29T00:00:00.000Z",
        command: { site: "slack", command: "send", effect: "send_message" },
        scope: {},
      })}\n`,
      "utf-8",
    );

    await expect(listStoredApprovals(store)).resolves.toEqual([]);
  });

  it("revokes an active approval with an append-only tombstone", async () => {
    const store = createApprovalStore({ homeDir: tmp });
    const input = {
      site: "twitter",
      command: "post",
      args: [{ name: "text", required: true }],
      profile: "confirm",
    };
    const approved = await rememberApproval(store, {
      policy: evaluateOperationPolicy({ ...input, approved: true }),
      now: () => new Date("2026-04-29T00:00:00.000Z"),
    });
    expect(approved).toBeDefined();

    const revoked = await revokeStoredApproval(store, approved!.key, {
      now: () => new Date("2026-04-29T01:00:00.000Z"),
    });

    expect(revoked).toMatchObject({
      schema_version: "1",
      key: approved!.key,
      decision: "revoke",
      created_at: "2026-04-29T01:00:00.000Z",
    });
    await expect(
      findStoredApproval(store, approved!.key),
    ).resolves.toBeUndefined();
    await expect(listActiveStoredApprovals(store)).resolves.toEqual([]);

    const entries = await listStoredApprovals(store);
    expect(entries.map((entry) => entry.decision)).toEqual(["allow", "revoke"]);
  });

  it("clears active approvals by appending revoke tombstones", async () => {
    const store = createApprovalStore({ homeDir: tmp });
    const first = await rememberApproval(store, {
      policy: evaluateOperationPolicy({
        site: "slack",
        command: "send",
        args: [{ name: "text", required: true }],
        profile: "confirm",
        approved: true,
      }),
      now: () => new Date("2026-04-29T00:00:00.000Z"),
    });
    const second = await rememberApproval(store, {
      policy: evaluateOperationPolicy({
        site: "word",
        command: "set-font",
        adapterType: "desktop",
        targetSurface: "desktop",
        profile: "locked",
        approved: true,
      }),
      now: () => new Date("2026-04-29T00:01:00.000Z"),
    });

    const cleared = await clearStoredApprovals(store, {
      now: () => new Date("2026-04-29T02:00:00.000Z"),
    });

    expect(cleared).toBe(2);
    await expect(listActiveStoredApprovals(store)).resolves.toEqual([]);
    await expect(
      findStoredApproval(store, first!.key),
    ).resolves.toBeUndefined();
    await expect(
      findStoredApproval(store, second!.key),
    ).resolves.toBeUndefined();

    const entries = await listStoredApprovals(store);
    expect(entries.map((entry) => entry.decision)).toEqual([
      "allow",
      "allow",
      "revoke",
      "revoke",
    ]);
  });
});
