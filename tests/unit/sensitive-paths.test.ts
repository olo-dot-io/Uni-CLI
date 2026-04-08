import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SENSITIVE_PATH_PATTERNS,
  isSensitivePath,
  isSensitivePathRealpath,
  matchSensitivePath,
  matchSensitivePathRealpath,
  buildSensitivePathDenial,
} from "../../src/permissions/sensitive-paths.js";

describe("isSensitivePath — positive matches", () => {
  it("blocks SSH private key under macOS home", () => {
    expect(isSensitivePath("/Users/x/.ssh/id_rsa")).toBe(true);
  });

  it("blocks SSH directory itself", () => {
    expect(isSensitivePath("/Users/x/.ssh")).toBe(true);
  });

  it("blocks AWS credentials under Linux home", () => {
    expect(isSensitivePath("/home/y/.aws/credentials")).toBe(true);
  });

  it("blocks AWS config", () => {
    expect(isSensitivePath("/home/y/.aws/config")).toBe(true);
  });

  it("blocks kubeconfig", () => {
    expect(isSensitivePath("/Users/x/.kube/config")).toBe(true);
  });

  it("blocks docker config.json", () => {
    expect(isSensitivePath("/Users/x/.docker/config.json")).toBe(true);
  });

  it("blocks .npmrc auth token", () => {
    expect(isSensitivePath("/Users/x/.npmrc")).toBe(true);
  });

  it("blocks Uni-CLI per-site cookie file", () => {
    expect(isSensitivePath("/Users/x/.unicli/cookies/twitter.json")).toBe(true);
  });

  it("blocks Uni-CLI credentials file", () => {
    expect(isSensitivePath("/Users/x/.unicli/credentials.json")).toBe(true);
  });

  it("blocks OpenHarness credentials interop", () => {
    expect(isSensitivePath("/Users/x/.openharness/credentials.json")).toBe(
      true,
    );
  });

  it("blocks OpenHarness copilot auth interop", () => {
    expect(isSensitivePath("/Users/x/.openharness/copilot_auth.json")).toBe(
      true,
    );
  });

  it("blocks GCP application default credentials", () => {
    expect(
      isSensitivePath(
        "/Users/x/.config/gcloud/application_default_credentials.json",
      ),
    ).toBe(true);
  });

  it("blocks GCP legacy credentials directory", () => {
    expect(
      isSensitivePath("/Users/x/.config/gcloud/legacy_credentials/foo"),
    ).toBe(true);
  });

  it("blocks GPG keyring directory", () => {
    expect(isSensitivePath("/Users/x/.gnupg/pubring.kbx")).toBe(true);
  });
});

describe("isSensitivePath — negative cases (no false positives)", () => {
  it("allows ordinary documents", () => {
    expect(isSensitivePath("/Users/x/Documents/notes.txt")).toBe(false);
  });

  it("allows project source files", () => {
    expect(isSensitivePath("/Users/x/code/myproject/src/index.ts")).toBe(false);
  });

  it("rejects relative paths defensively", () => {
    expect(isSensitivePath("relative/path.json")).toBe(false);
    expect(isSensitivePath(".ssh/id_rsa")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSensitivePath("")).toBe(false);
  });

  it("does not match files that merely contain 'ssh' in name", () => {
    expect(isSensitivePath("/Users/x/sshfile.txt")).toBe(false);
    expect(isSensitivePath("/Users/x/myssh.conf")).toBe(false);
  });

  it("does not match files that look like .aws but are not", () => {
    expect(isSensitivePath("/Users/x/.aws-backup/credentials")).toBe(false);
  });
});

describe("matchSensitivePath", () => {
  it("returns the matching RegExp for a sensitive path", () => {
    const matched = matchSensitivePath("/Users/x/.ssh/id_rsa");
    expect(matched).toBeInstanceOf(RegExp);
    expect(matched?.source).toBe(SENSITIVE_PATH_PATTERNS[0]?.source);
  });

  it("returns undefined for a non-sensitive path", () => {
    expect(matchSensitivePath("/Users/x/code/index.ts")).toBeUndefined();
  });
});

describe("buildSensitivePathDenial", () => {
  it("returns a well-formed payload", () => {
    const denial = buildSensitivePathDenial("/Users/x/.aws/credentials");
    expect(denial.error).toBe("sensitive_path_denied");
    expect(denial.path).toBe("/Users/x/.aws/credentials");
    expect(denial.pattern).toContain(".aws");
    expect(denial.hint).toMatch(/sensitive/i);
  });

  it("still returns a payload for non-sensitive input (synthetic pattern)", () => {
    const denial = buildSensitivePathDenial("/Users/x/notes.txt");
    expect(denial.error).toBe("sensitive_path_denied");
    expect(denial.path).toBe("/Users/x/notes.txt");
    expect(denial.pattern).toBe("unknown");
  });
});

describe("Windows path normalization", () => {
  it("matches a Windows-style SSH path after normalization", () => {
    expect(isSensitivePath("C:\\Users\\x\\.ssh\\id_rsa")).toBe(true);
  });

  it("matches a Windows-style AWS credentials path", () => {
    expect(isSensitivePath("D:\\Users\\y\\.aws\\credentials")).toBe(true);
  });
});

describe("Case-insensitive filesystem support (Darwin/Win32)", () => {
  // Only runs on case-insensitive platforms
  const caseInsensitive =
    process.platform === "darwin" || process.platform === "win32";

  it.runIf(caseInsensitive)(
    "blocks /Users/x/.SSH/id_rsa on macOS/Windows",
    () => {
      expect(isSensitivePath("/Users/x/.SSH/id_rsa")).toBe(true);
    },
  );

  it.runIf(caseInsensitive)(
    "blocks /Users/x/.AWS/credentials on macOS/Windows",
    () => {
      expect(isSensitivePath("/Users/x/.AWS/credentials")).toBe(true);
    },
  );
});

describe("Extended pattern coverage (v0.208.1 hardening)", () => {
  it("blocks .pgpass (PostgreSQL password file)", () => {
    expect(isSensitivePath("/Users/x/.pgpass")).toBe(true);
  });

  it("blocks .netrc", () => {
    expect(isSensitivePath("/Users/x/.netrc")).toBe(true);
  });

  it("blocks .wgetrc", () => {
    expect(isSensitivePath("/Users/x/.wgetrc")).toBe(true);
  });

  it("blocks .my.cnf (MySQL credentials)", () => {
    expect(isSensitivePath("/Users/x/.my.cnf")).toBe(true);
  });

  it("blocks Azure accessTokens.json", () => {
    expect(isSensitivePath("/Users/x/.azure/accessTokens.json")).toBe(true);
  });

  it("blocks Azure azureProfile.json", () => {
    expect(isSensitivePath("/Users/x/.azure/azureProfile.json")).toBe(true);
  });

  it("blocks GitHub CLI hosts.yml", () => {
    expect(isSensitivePath("/Users/x/.config/gh/hosts.yml")).toBe(true);
  });

  it("blocks 1Password CLI directory", () => {
    expect(isSensitivePath("/Users/x/.config/op/session.json")).toBe(true);
  });

  it("blocks rclone.conf", () => {
    expect(isSensitivePath("/Users/x/.config/rclone/rclone.conf")).toBe(true);
  });
});

describe("Symlink-aware realpath check", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unicli-symlink-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("blocks a symlink that targets a sensitive path", () => {
    // Arrange: create a decoy sensitive file + a symlink pointing at it.
    // We can't use a real credential path in tests, so we build a fake
    // `.ssh` directory inside the temp dir and link to a file inside it.
    const fakeSsh = join(dir, "fake-home", ".ssh");
    mkdirSync(fakeSsh, { recursive: true });
    const secret = join(fakeSsh, "id_rsa");
    writeFileSync(secret, "BEGIN OPENSSH PRIVATE KEY\n");
    const bait = join(dir, "pretty.txt");
    symlinkSync(secret, bait);

    // Realpath-aware check sees through the symlink and matches the .ssh
    // directory pattern.
    expect(isSensitivePathRealpath(bait)).toBe(true);
    const matched = matchSensitivePathRealpath(bait);
    expect(matched).toBeInstanceOf(RegExp);
  });

  it("allows an ordinary file that is NOT a symlink to anything sensitive", () => {
    const ordinary = join(dir, "ordinary.txt");
    writeFileSync(ordinary, "hello");
    expect(isSensitivePathRealpath(ordinary)).toBe(false);
  });

  it("does not crash on a broken symlink", () => {
    const bait = join(dir, "broken.txt");
    symlinkSync(join(dir, "does-not-exist"), bait);
    // Broken symlink cannot resolve; we fall through to the string-only
    // check, which also returns false because the link name itself is
    // not in the deny list.
    expect(() => isSensitivePathRealpath(bait)).not.toThrow();
    expect(isSensitivePathRealpath(bait)).toBe(false);
  });
});
