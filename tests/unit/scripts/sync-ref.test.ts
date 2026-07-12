import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve("scripts/sync-ref.sh");
const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

function createNestedReference(): {
  root: string;
  checkout: string;
  publisher: string;
} {
  const root = mkdtempSync(join(tmpdir(), "unicli-sync-ref-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  const publisher = join(root, "publisher");
  const checkout = join(root, "refs", "group", "project");

  git(root, "init", "--bare", remote);
  git(root, "clone", remote, publisher);
  git(publisher, "config", "user.name", "Sync Ref Test");
  git(publisher, "config", "user.email", "sync-ref@example.invalid");
  writeFileSync(join(publisher, "version.txt"), "one\n");
  git(publisher, "add", "version.txt");
  git(publisher, "commit", "-m", "initial");
  git(publisher, "push", "origin", "HEAD");
  git(root, "clone", remote, checkout);
  git(checkout, "config", "core.autocrlf", "false");

  return { root, checkout, publisher };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("sync-ref.sh", () => {
  it("fast-forwards a repository nested below the reference root", () => {
    const { root, checkout, publisher } = createNestedReference();
    writeFileSync(join(publisher, "version.txt"), "two\n");
    git(publisher, "add", "version.txt");
    git(publisher, "commit", "-m", "update");
    git(publisher, "push", "origin", "HEAD");

    const output = execFileSync("bash", [SCRIPT], {
      cwd: root,
      env: { ...process.env, UNICLI_REF_DIR: join(root, "refs") },
      encoding: "utf8",
    });

    expect(output).toContain("group/project");
    expect(output).toContain("synced: 1 | failed: 0");
    expect(readFileSync(join(checkout, "version.txt"), "utf8")).toBe("two\n");
  });

  it("refuses to overwrite a dirty reference checkout", () => {
    const { root, checkout } = createNestedReference();
    writeFileSync(join(checkout, "version.txt"), "local\n");

    const run = spawnSync("bash", [SCRIPT], {
      cwd: root,
      env: { ...process.env, UNICLI_REF_DIR: join(root, "refs") },
      encoding: "utf8",
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("DIRTY");
    expect(readFileSync(join(checkout, "version.txt"), "utf8")).toBe("local\n");
  });
});
