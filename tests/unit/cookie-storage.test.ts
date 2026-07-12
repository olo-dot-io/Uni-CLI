import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COOKIE_DIRECTORY_MODE,
  COOKIE_FILE_MODE,
  readDiskCookies,
  saveCookies,
} from "../../src/engine/cookie-storage.js";

let root = "";
let directory = "";
let previousDirectory: string | undefined;
let previousUmask = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "unicli-cookie-storage-"));
  directory = join(root, "cookies");
  previousDirectory = process.env.UNICLI_COOKIE_DIR;
  process.env.UNICLI_COOKIE_DIR = directory;
  previousUmask = process.umask(0o022);
});

afterEach(() => {
  process.umask(previousUmask);
  if (previousDirectory === undefined) delete process.env.UNICLI_COOKIE_DIR;
  else process.env.UNICLI_COOKIE_DIR = previousDirectory;
  rmSync(root, { recursive: true, force: true });
});

describe("explicit cookie persistence", () => {
  it.skipIf(process.platform === "win32")(
    "creates owner-only storage even under umask 022",
    () => {
      const filePath = saveCookies("bilibili", {
        SESSDATA: "abc123",
        bili_jct: "def456",
      });

      expect(lstatSync(directory).mode & 0o777).toBe(COOKIE_DIRECTORY_MODE);
      expect(lstatSync(filePath).mode & 0o777).toBe(COOKIE_FILE_MODE);
      expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual({
        SESSDATA: "abc123",
        bili_jct: "def456",
      });
      expect(readdirSync(directory)).toEqual(["bilibili.json"]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "tightens broad historical paths before replacing secrets",
    () => {
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      const filePath = join(directory, "legacy.json");
      writeFileSync(filePath, JSON.stringify({ stale: "secret" }), {
        mode: 0o644,
      });
      chmodSync(directory, 0o755);
      chmodSync(filePath, 0o644);

      saveCookies("legacy", { fresh: "secret" });

      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
      expect(lstatSync(filePath).mode & 0o777).toBe(0o600);
      expect(readDiskCookies("legacy")).toEqual({
        kind: "ok",
        cookies: { fresh: "secret" },
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "hardens a broad legacy file before reading it",
    () => {
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      const filePath = join(directory, "legacy.json");
      writeFileSync(filePath, JSON.stringify({ sid: "secret" }), {
        mode: 0o644,
      });
      chmodSync(directory, 0o755);
      chmodSync(filePath, 0o644);

      expect(readDiskCookies("legacy")).toEqual({
        kind: "ok",
        cookies: { sid: "secret" },
      });
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
      expect(lstatSync(filePath).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symlink reads and atomically replaces the link on explicit save",
    () => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const target = join(root, "outside.json");
      const link = join(directory, "linked.json");
      writeFileSync(target, JSON.stringify({ outside: "unchanged" }));
      symlinkSync(target, link);

      expect(readDiskCookies("linked")).toMatchObject({ kind: "corrupt" });
      saveCookies("linked", { inside: "new" });

      expect(lstatSync(link).isSymbolicLink()).toBe(false);
      expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({
        outside: "unchanged",
      });
      expect(readDiskCookies("linked")).toEqual({
        kind: "ok",
        cookies: { inside: "new" },
      });
    },
  );

  it("rejects unsafe names and non-string values", () => {
    expect(() => saveCookies("../escape", { sid: "x" })).toThrow(
      "Invalid site name",
    );
    expect(() =>
      saveCookies("site", { sid: 1 } as unknown as Record<string, string>),
    ).toThrow("must all be strings");
    expect(existsSync(directory)).toBe(false);
  });

  it("reports invalid persisted shapes as corrupt", () => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "bad.json"), JSON.stringify({ sid: 1 }));
    expect(readDiskCookies("bad")).toMatchObject({
      kind: "corrupt",
      detail: expect.stringContaining("{name: string}"),
    });
  });
});
