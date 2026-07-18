import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildIdentityDocument,
  computeWorktreeSourceIdentity,
} from "../../src/runtime/source-identity.js";

describe("source identity", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fingerprints tracked and untracked dirty source deterministically", () => {
    const root = mkdtempSync(join(tmpdir(), "unicli-source-identity-"));
    roots.push(root);
    git(root, ["init", "--quiet"]);
    writeFileSync(join(root, "tracked.txt"), "baseline\n");
    git(root, ["add", "tracked.txt"]);
    git(root, [
      "-c",
      "user.name=Uni CLI Test",
      "-c",
      "user.email=unicli@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "baseline",
    ]);

    const clean = computeWorktreeSourceIdentity(root);
    expect(clean).toMatchObject({ state: "clean" });
    expect(clean.revision).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(join(root, "tracked.txt"), "changed\n");
    writeFileSync(join(root, "untracked.bin"), Buffer.from([0, 1, 2, 255]));
    const first = computeWorktreeSourceIdentity(root);
    const second = computeWorktreeSourceIdentity(root);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      revision: clean.revision,
      state: "dirty",
    });
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);

    writeFileSync(join(root, "untracked.bin"), Buffer.from([0, 1, 3, 255]));
    expect(computeWorktreeSourceIdentity(root).digest).not.toBe(first.digest);
  });

  it("serializes only valid packaged source identity fields", () => {
    expect(
      buildIdentityDocument({
        revision: "ABCDEF1234567",
        state: "packaged",
        digest: "x".repeat(64),
      }),
    ).toEqual({
      schema_version: 1,
      revision: "abcdef1234567",
      state: "unknown",
    });
  });
});

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}
