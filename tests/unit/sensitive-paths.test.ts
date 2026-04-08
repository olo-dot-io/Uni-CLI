import { describe, it, expect } from "vitest";
import {
  SENSITIVE_PATH_PATTERNS,
  isSensitivePath,
  matchSensitivePath,
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
