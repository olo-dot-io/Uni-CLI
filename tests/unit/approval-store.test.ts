import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createApprovalStore,
  findStoredApproval,
  listStoredApprovals,
  rememberApproval,
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
});
