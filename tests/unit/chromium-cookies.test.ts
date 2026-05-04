import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import {
  decryptValue,
  deriveKey,
  listProfiles,
  resolveCookieDb,
  ChromiumCookieError,
  BROWSER_IDS,
  type Platform,
} from "../../src/engine/chromium-cookies.js";

const HOME = join(tmpdir(), `unicli-bx-test-${Date.now()}`);
const SALT = "saltysalt";
const IV_CBC = Buffer.alloc(16, 0x20);

beforeAll(() => {
  mkdirSync(HOME, { recursive: true });
  process.env.UNICLI_BROWSER_HOME = HOME;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  delete process.env.UNICLI_BROWSER_HOME;
});

/* -------------------------------------------------------------------------- */

describe("deriveKey", () => {
  it("macOS uses PBKDF2-SHA1(saltysalt, 1003, 16)", () => {
    const k = deriveKey("password", "darwin");
    expect(k).toHaveLength(16);
    expect(k.toString("hex")).toBe(
      pbkdf2Sync("password", SALT, 1003, 16, "sha1").toString("hex"),
    );
  });

  it("Linux uses PBKDF2-SHA1(saltysalt, 1, 16) — iter=1 not 1003", () => {
    const k = deriveKey("peanuts", "linux");
    expect(k).toHaveLength(16);
    expect(k.toString("hex")).toBe(
      pbkdf2Sync("peanuts", SALT, 1, 16, "sha1").toString("hex"),
    );
    // Hardcoded fallback documented in Chromium HEAD posix_key_provider.cc
    expect(k.toString("hex")).toBe("fd621fe5a2b402539dfa147ca9272778");
  });

  it("Windows passes a 32-byte master key through unchanged", () => {
    const master = randomBytes(32);
    expect(deriveKey(master, "win32").equals(master)).toBe(true);
  });

  it("Windows rejects a string secret (must be DPAPI master key Buffer)", () => {
    expect(() => deriveKey("not-a-buffer", "win32")).toThrowError(
      ChromiumCookieError,
    );
  });

  it("Windows rejects a master key with the wrong length", () => {
    expect(() => deriveKey(Buffer.alloc(16), "win32")).toThrowError(
      /unexpected length/,
    );
  });
});

/* -------------------------------------------------------------------------- */

function encryptCbcMac(
  plain: string,
  key: Buffer,
  withIntegrity = true,
): Buffer {
  const value = Buffer.from(plain, "utf8");
  const body = withIntegrity
    ? Buffer.concat([createHash("sha256").update(value).digest(), value])
    : value;
  const cipher = createCipheriv("aes-128-cbc", key, IV_CBC);
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "ascii"), ct]);
}

function encryptCbcLinux(plain: string, key: Buffer): Buffer {
  // Linux has NO 32-byte SHA256 prefix — plaintext is the raw value.
  const value = Buffer.from(plain, "utf8");
  const cipher = createCipheriv("aes-128-cbc", key, IV_CBC);
  const ct = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([Buffer.from("v10", "ascii"), ct]);
}

function encryptGcmWindows(plain: string, master: Buffer): Buffer {
  // Windows: v10 prefix + 12-byte nonce + AES-256-GCM(SHA256||plain) + 16-byte tag
  const value = Buffer.from(plain, "utf8");
  const body = Buffer.concat([
    createHash("sha256").update(value).digest(),
    value,
  ]);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master, nonce);
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("v10", "ascii"), nonce, ct, tag]);
}

describe("decryptValue", () => {
  describe("macOS (CBC + integrity prefix)", () => {
    const key = deriveKey("test-keychain-password", "darwin");

    it("round-trips plaintext through v10 + 32-byte SHA256 prefix", () => {
      const enc = encryptCbcMac("session=abc123; expires=foo", key, true);
      expect(decryptValue(enc, key, "darwin")).toBe(
        "session=abc123; expires=foo",
      );
    });

    it("returns plaintext for v10 without integrity prefix (legacy)", () => {
      const enc = encryptCbcMac("plain-old-cookie-value", key, false);
      expect(decryptValue(enc, key, "darwin")).toBe("plain-old-cookie-value");
    });

    it("throws decrypt_failed when key is wrong", () => {
      const enc = encryptCbcMac("anything", key, true);
      const wrongKey = deriveKey("not-the-right-password", "darwin");
      expect(() => decryptValue(enc, wrongKey, "darwin")).toThrowError(
        ChromiumCookieError,
      );
    });
  });

  describe("Linux (CBC, no integrity prefix, peanuts)", () => {
    const key = deriveKey("peanuts", "linux");

    it("round-trips plaintext through v10 with NO prefix to strip", () => {
      const enc = encryptCbcLinux("SESSDATA=abc; bili_jct=def", key);
      expect(decryptValue(enc, key, "linux")).toBe(
        "SESSDATA=abc; bili_jct=def",
      );
    });

    it("preserves leading SHA256-shaped bytes (Linux has no integrity prefix to strip)", () => {
      // 32-byte ASCII payload that happens to begin with non-printable bytes
      // would be misinterpreted on macOS — Linux must NOT strip.
      const value = "\x01\x02\x03payload=value-after-control-bytes";
      const enc = encryptCbcLinux(value, key);
      expect(decryptValue(enc, key, "linux")).toBe(value);
    });
  });

  describe("Windows (GCM + integrity prefix)", () => {
    const master = randomBytes(32);
    const key = deriveKey(master, "win32");

    it("round-trips plaintext through GCM + 32-byte SHA256 prefix", () => {
      const enc = encryptGcmWindows("token=xyz; csrf=qrs", master);
      expect(decryptValue(enc, key, "win32")).toBe("token=xyz; csrf=qrs");
    });

    it("rejects too-short ciphertext (< nonce + tag)", () => {
      const enc = Buffer.concat([
        Buffer.from("v10", "ascii"),
        Buffer.alloc(20),
      ]);
      expect(() => decryptValue(enc, key, "win32")).toThrowError(/too short/);
    });

    it("throws encryption_unsupported on v20 (App-Bound)", () => {
      const enc = Buffer.concat([
        Buffer.from("v20", "ascii"),
        Buffer.alloc(48),
      ]);
      try {
        decryptValue(enc, key, "win32");
        expect.fail("should throw");
      } catch (e) {
        expect((e as ChromiumCookieError).code).toBe("encryption_unsupported");
        expect((e as ChromiumCookieError).suggestion).toMatch(
          /CDP|browser start/,
        );
      }
    });
  });

  describe("Generic", () => {
    const key = deriveKey("password", "darwin");
    const platforms: Platform[] = ["darwin", "linux", "win32"];

    for (const p of platforms) {
      it(`returns empty string for empty buffer (${p})`, () => {
        expect(decryptValue(Buffer.alloc(0), key, p)).toBe("");
      });

      it(`returns raw bytes when no v-prefix (${p}) — legacy unencrypted`, () => {
        const raw = Buffer.from("plain-cookie-value", "utf8");
        expect(decryptValue(raw, key, p)).toBe("plain-cookie-value");
      });
    }

    it("throws encryption_unsupported on unknown vNN prefix", () => {
      const enc = Buffer.concat([
        Buffer.from("v99", "ascii"),
        Buffer.alloc(48),
      ]);
      expect(() => decryptValue(enc, key, "darwin")).toThrowError(
        /unsupported cookie encryption/,
      );
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("listProfiles", () => {
  it("returns [] when browser is not installed", () => {
    expect(listProfiles("brave")).toEqual([]);
  });

  it("returns profiles sorted by Cookies mtime descending (mac path)", () => {
    if (process.platform !== "darwin") return;
    const root = join(HOME, "Google", "Chrome");
    mkdirSync(join(root, "Default"), { recursive: true });
    mkdirSync(join(root, "Profile 1"), { recursive: true });
    mkdirSync(join(root, "Profile 2"), { recursive: true });
    writeFileSync(join(root, "Default", "Cookies"), "");
    writeFileSync(join(root, "Profile 1", "Cookies"), "");
    writeFileSync(join(root, "Profile 2", "Cookies"), "");

    const now = Date.now() / 1000;
    utimesSync(join(root, "Default", "Cookies"), now - 3600, now - 3600);
    utimesSync(join(root, "Profile 1", "Cookies"), now, now);
    utimesSync(join(root, "Profile 2", "Cookies"), now - 7200, now - 7200);

    expect(listProfiles("chrome")).toEqual([
      "Profile 1",
      "Default",
      "Profile 2",
    ]);
  });

  it("locates Cookies under <profile>/Network/Cookies (newer Chromium)", () => {
    if (process.platform !== "darwin") return;
    const root = join(HOME, "Microsoft Edge");
    mkdirSync(join(root, "Default", "Network"), { recursive: true });
    writeFileSync(join(root, "Default", "Network", "Cookies"), "");
    expect(listProfiles("edge")).toContain("Default");
  });

  it("uses User Data subdirectory for vendors that need it (mac)", () => {
    if (process.platform !== "darwin") return;
    const root = join(HOME, "Dia", "User Data");
    mkdirSync(join(root, "Default"), { recursive: true });
    writeFileSync(join(root, "Default", "Cookies"), "");
    expect(listProfiles("dia")).toEqual(["Default"]);
  });
});

/* -------------------------------------------------------------------------- */

describe("resolveCookieDb", () => {
  it("throws browser_not_installed when support root is missing", () => {
    expect(() => resolveCookieDb("brave")).toThrowError(/brave not found/);
  });

  it("picks the most-recent-modified profile by default (mac)", () => {
    if (process.platform !== "darwin") return;
    const root = join(HOME, "Google", "Chrome");
    mkdirSync(join(root, "Default"), { recursive: true });
    mkdirSync(join(root, "Profile 1"), { recursive: true });
    writeFileSync(join(root, "Default", "Cookies"), "");
    writeFileSync(join(root, "Profile 1", "Cookies"), "");
    const now = Date.now() / 1000;
    utimesSync(join(root, "Default", "Cookies"), now - 3600, now - 3600);
    utimesSync(join(root, "Profile 1", "Cookies"), now, now);

    const r = resolveCookieDb("chrome");
    expect(r.profile).toBe("Profile 1");
    expect(r.dbPath).toContain("Profile 1");
  });

  it("honours an explicit profile request", () => {
    if (process.platform !== "darwin") return;
    const r = resolveCookieDb("chrome", "Default");
    expect(r.profile).toBe("Default");
  });

  it("throws no_profile when the named profile has no Cookies file", () => {
    if (process.platform !== "darwin") return;
    expect(() => resolveCookieDb("chrome", "Profile 99")).toThrow(
      ChromiumCookieError,
    );
  });

  it("throws browser_not_installed when browser has no path on this platform", () => {
    // Arc has no Linux/Windows build — on those platforms the registry skips it.
    if (process.platform === "darwin") return;
    expect(() => resolveCookieDb("arc")).toThrowError(/not supported/);
  });
});

/* -------------------------------------------------------------------------- */

describe("BROWSER_IDS", () => {
  it("lists all supported browsers", () => {
    expect(BROWSER_IDS).toContain("chrome");
    expect(BROWSER_IDS).toContain("arc");
    expect(BROWSER_IDS).toContain("dia");
    expect(BROWSER_IDS).toContain("atlas");
    expect(BROWSER_IDS).toContain("brave");
    expect(BROWSER_IDS).toContain("edge");
  });
});
