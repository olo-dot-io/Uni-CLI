/**
 * Per-platform Chromium cookie key derivation, keystore lookup, and decrypt.
 *
 * The three platforms diverge meaningfully:
 *
 *   macOS  — Keychain `security` CLI → password (≤24 ASCII chars)
 *            PBKDF2-SHA1(saltysalt, 1003, 16) → 16-byte AES key
 *            v10/v11 prefix + AES-128-CBC + IV=16×0x20 + PKCS7
 *            32-byte SHA256 integrity prefix on plaintext (M122+)
 *
 *   Linux  — libsecret/KWallet via `secret-tool` → password
 *              fallback to literal "peanuts" if no keyring (Chromium HEAD)
 *            PBKDF2-SHA1(saltysalt, **1**, 16) → 16-byte AES key   (CRITICAL)
 *            v10/v11 prefix + AES-128-CBC + IV=16×0x20 + PKCS7
 *            NO integrity prefix
 *
 *   Windows — `Local State` → os_crypt.encrypted_key (base64)
 *             strip "DPAPI" 5-byte prefix
 *             CryptUnprotectData(CurrentUser) via PowerShell → 32-byte master
 *             v10 prefix + 12-byte nonce + AES-256-GCM(ct + 16-byte tag, master)
 *             32-byte SHA256 integrity prefix on plaintext
 *             v20 (Chrome 127+ App-Bound Encryption) is BLOCKED for external
 *             processes by design; we surface encryption_unsupported and
 *             suggest CDP fallback rather than ship a brittle bypass.
 *
 * All three platforms validate the prefix bytes to detect format drift early.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import {
  ChromiumCookieError,
  type BrowserId,
} from "./chromium-cookies-types.js";

export type Platform = "darwin" | "linux" | "win32";

export function currentPlatform(): Platform {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  throw new ChromiumCookieError(
    "encryption_unsupported",
    `unsupported platform: ${p}`,
    "Direct cookie reads work on macOS, Linux, and Windows. Use CDP fallback elsewhere.",
  );
}

/* -------------------------------------------------------------------------- */
/*  Keystore                                                                  */
/* -------------------------------------------------------------------------- */

interface KeystoreSpec {
  /** macOS: Keychain service labels to probe in order. */
  macLabels?: readonly string[];
  /** macOS: Keychain account candidates per label. */
  macAccounts?: readonly string[];
  /** Linux: secret-tool `application` attribute. */
  linuxApp?: string;
  /** Linux: secret-tool xdg:schema attribute. */
  linuxSchema?: string;
  /**
   * Windows: Local State path relative to the user-data root. Each browser
   * stores its master key here; we read it once and feed DPAPI.
   */
  winLocalStateRel?: string;
}

/**
 * Look up a browser's encryption secret. Returns either a passphrase string
 * (macOS / Linux) or a 32-byte master key Buffer (Windows). The caller's
 * `deriveKey` knows which to expect based on the platform.
 *
 * Result is memoized per (browser, platform, userDataRoot) for the lifetime
 * of the process — Keychain prompts and DPAPI calls cost ~30-100 ms each, so
 * an audit walking 135 adapters with the same browser would otherwise spend
 * seconds re-fetching the same secret. Tests can clear via `_resetSecretCache`.
 */
const secretCache = new Map<string, Buffer | string>();

export function _resetSecretCache(): void {
  secretCache.clear();
}

export function getEncryptionSecret(
  browser: BrowserId,
  platform: Platform,
  spec: KeystoreSpec,
  userDataRoot: string,
): Buffer | string {
  const cacheKey = `${platform}:${browser}:${userDataRoot}`;
  const cached = secretCache.get(cacheKey);
  if (cached) return cached;
  let secret: Buffer | string;
  switch (platform) {
    case "darwin":
      secret = macSecurityLookup(browser, spec);
      break;
    case "linux":
      secret = linuxSecretLookup(browser, spec);
      break;
    case "win32":
      secret = winDpapiLookup(browser, spec, userDataRoot);
      break;
  }
  secretCache.set(cacheKey, secret);
  return secret;
}

/* macOS ------------------------------------------------------------------- */

function macSecurityLookup(browser: BrowserId, spec: KeystoreSpec): string {
  const labels = spec.macLabels ?? [];
  const accounts = spec.macAccounts ?? [];
  let lastError = "";
  for (const label of labels) {
    for (const account of accounts) {
      try {
        const args = ["find-generic-password", "-w", "-s", label];
        if (account) args.push("-a", account);
        const out = execFileSync("/usr/bin/security", args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const trimmed = out.trim();
        if (trimmed) return trimmed;
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
  }
  throw new ChromiumCookieError(
    "keychain_denied",
    `no Safe Storage password for ${browser}: ${lastError || "not found"}`,
    `Try: security find-generic-password -wa "${accounts[0] ?? browser}" -s "${labels[0] ?? `${browser} Safe Storage`}"`,
  );
}

/* Linux ------------------------------------------------------------------- */

function linuxSecretLookup(_browser: BrowserId, spec: KeystoreSpec): string {
  const app = spec.linuxApp;
  const schema = spec.linuxSchema ?? "chrome_libsecret_os_crypt_password_v2";
  if (app) {
    try {
      const out = execFileSync(
        "secret-tool",
        ["lookup", "application", app, "xdg:schema", schema],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const trimmed = out.trim();
      if (trimmed) return trimmed;
    } catch {
      // Fall through to peanuts — secret-tool missing or no entry.
    }
  }
  // Chromium HEAD `posix_key_provider.cc` literal: when no keyring backend is
  // available, the v10 password is the ASCII string "peanuts". That gives us
  // best-effort access on headless boxes / containers without a keyring.
  return "peanuts";
}

/* Windows ----------------------------------------------------------------- */

function winDpapiLookup(
  browser: BrowserId,
  spec: KeystoreSpec,
  userDataRoot: string,
): Buffer {
  const localStateRel = spec.winLocalStateRel ?? "Local State";
  const localStatePath = join(userDataRoot, localStateRel);
  if (!existsSync(localStatePath)) {
    throw new ChromiumCookieError(
      "keychain_denied",
      `${browser}: Local State not found at ${localStatePath}`,
      "Open the browser at least once so it writes its master key, then retry.",
    );
  }
  let parsed: { os_crypt?: { encrypted_key?: string } };
  try {
    parsed = JSON.parse(readFileSync(localStatePath, "utf8")) as typeof parsed;
  } catch (err) {
    throw new ChromiumCookieError(
      "keychain_denied",
      `${browser}: cannot parse Local State: ${(err as Error).message}`,
      "Local State is corrupt; close the browser and retry, or reset the profile.",
    );
  }
  const enc = parsed.os_crypt?.encrypted_key;
  if (!enc) {
    throw new ChromiumCookieError(
      "keychain_denied",
      `${browser}: Local State has no os_crypt.encrypted_key`,
      "The browser hasn't written a v10 master key. Sign into a site once, then retry.",
    );
  }
  const wrapped = Buffer.from(enc, "base64");
  // Strip "DPAPI" (5-byte prefix added since M55).
  if (
    wrapped.length < 5 ||
    wrapped.subarray(0, 5).toString("ascii") !== "DPAPI"
  ) {
    throw new ChromiumCookieError(
      "encryption_unsupported",
      `${browser}: encrypted_key missing DPAPI prefix`,
      "Likely an app-bound (v20) install. Use CDP via `unicli browser start`.",
    );
  }
  const ciphertext = wrapped.subarray(5);
  return dpapiUnprotect(ciphertext);
}

/**
 * Run DPAPI CryptUnprotectData(CurrentUser) without a native module.
 * Shells PowerShell to call `[System.Security.Cryptography.ProtectedData]`.
 * Slow (~80 ms) but zero-install.
 */
function dpapiUnprotect(ciphertext: Buffer): Buffer {
  const b64 = ciphertext.toString("base64");
  const ps = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    `$b=[Convert]::FromBase64String('${b64}')`,
    "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')",
    "[Convert]::ToBase64String($p)",
  ].join(";");
  let out: string;
  try {
    out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    throw new ChromiumCookieError(
      "decrypt_failed",
      `DPAPI unprotect failed: ${(err as Error).message}`,
      "Run as the same user that owns the profile. Cross-user DPAPI is intentionally blocked.",
    );
  }
  return Buffer.from(out.trim(), "base64");
}

/* -------------------------------------------------------------------------- */
/*  Key derivation                                                            */
/* -------------------------------------------------------------------------- */

const SALT = "saltysalt";
const KEY_LEN_128 = 16;
const KEY_LEN_256 = 32;

/**
 * Derive the AES key from the platform secret. macOS uses 1003 PBKDF2
 * iterations; Linux uses **1** iteration (Chromium's
 * `kEncryptionIterations = 1` for `freedesktop_secret_key_provider.cc`).
 * Windows passes through — DPAPI already returned a 32-byte master.
 */
export function deriveKey(secret: Buffer | string, platform: Platform): Buffer {
  if (platform === "win32") {
    if (typeof secret === "string") {
      throw new ChromiumCookieError(
        "decrypt_failed",
        "Windows expects a 32-byte master key, got a string",
        "This is an internal bug; report it.",
      );
    }
    if (secret.length !== KEY_LEN_256) {
      throw new ChromiumCookieError(
        "decrypt_failed",
        `Windows master key has unexpected length ${secret.length} (want 32)`,
        "Likely a corrupted Local State; reset the browser profile.",
      );
    }
    return secret;
  }
  const password =
    typeof secret === "string" ? secret : secret.toString("utf8");
  const iterations = platform === "darwin" ? 1003 : 1;
  return pbkdf2Sync(password, SALT, iterations, KEY_LEN_128, "sha1");
}

/* -------------------------------------------------------------------------- */
/*  Decrypt                                                                   */
/* -------------------------------------------------------------------------- */

const IV_CBC = Buffer.alloc(16, 0x20);
const INTEGRITY_PREFIX_LEN = 32;

/**
 * Decrypt a single Chromium-encrypted cookie value.
 *
 *  • Empty buffer        → empty string
 *  • No `vNN` prefix     → raw bytes (legacy unencrypted)
 *  • `v10`/`v11` macOS   → AES-128-CBC, strip 32-byte SHA256 prefix when present
 *  • `v10`/`v11` Linux   → AES-128-CBC, NO integrity prefix
 *  • `v10`        Win    → AES-256-GCM with 12-byte nonce + 16-byte tag,
 *                          strip 32-byte SHA256 prefix
 *  • `v20`        Win    → encryption_unsupported (App-Bound Encryption)
 */
export function decryptValue(
  encrypted: Buffer,
  key: Buffer,
  platform: Platform,
): string {
  if (encrypted.length === 0) return "";
  const prefix = encrypted.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") {
    if (/^v\d/.test(prefix)) {
      throw new ChromiumCookieError(
        "encryption_unsupported",
        `unsupported cookie encryption version "${prefix}"` +
          (prefix === "v20"
            ? " (Chrome 127+ App-Bound Encryption blocks external decrypt)"
            : ""),
        prefix === "v20"
          ? "Use CDP: `unicli browser start` then `unicli auth import` once Chrome is logged in."
          : "Open the site in your browser and try CDP fallback, or downgrade the browser.",
      );
    }
    return encrypted.toString("utf8");
  }

  const body = encrypted.subarray(3);
  const plain =
    platform === "win32" ? decryptGcm(body, key) : decryptCbc(body, key);

  // macOS + Windows prepend a 32-byte SHA256 integrity hash before the value.
  // Linux does not. Heuristic: if the first 32 bytes contain any non-printable
  // byte (the SHA256 of any value almost always does), strip them. ASCII-only
  // first 32 bytes are almost surely real cookie content.
  if (
    platform !== "linux" &&
    plain.length >= INTEGRITY_PREFIX_LEN &&
    hasNonPrintable(plain.subarray(0, INTEGRITY_PREFIX_LEN))
  ) {
    return plain.subarray(INTEGRITY_PREFIX_LEN).toString("utf8");
  }
  return plain.toString("utf8");
}

function decryptCbc(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-cbc", key, IV_CBC);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new ChromiumCookieError(
      "decrypt_failed",
      `AES-128-CBC decrypt failed: ${(err as Error).message}`,
      "The Keychain key may be wrong; revoke and re-grant Keychain access.",
    );
  }
}

function decryptGcm(ciphertext: Buffer, key: Buffer): Buffer {
  if (ciphertext.length < 12 + 16) {
    throw new ChromiumCookieError(
      "decrypt_failed",
      `GCM ciphertext too short (${ciphertext.length} bytes)`,
      "Cookie blob is malformed; the Cookies DB may be corrupt.",
    );
  }
  const nonce = ciphertext.subarray(0, 12);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const ct = ciphertext.subarray(12, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (err) {
    throw new ChromiumCookieError(
      "decrypt_failed",
      `AES-256-GCM decrypt failed: ${(err as Error).message}`,
      "The DPAPI master key may be wrong (cross-user DPAPI is blocked) or this is a v20 cookie.",
    );
  }
}

function hasNonPrintable(buf: Buffer): boolean {
  for (const b of buf) {
    if (b < 0x20 || b > 0x7e) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Per-browser keystore specs                                                */
/* -------------------------------------------------------------------------- */

export const KEYSTORE_SPECS: Record<BrowserId, KeystoreSpec> = {
  chrome: {
    macLabels: ["Chrome Safe Storage"],
    macAccounts: ["Chrome"],
    linuxApp: "chrome",
    winLocalStateRel: "Local State",
  },
  brave: {
    macLabels: ["Brave Safe Storage"],
    macAccounts: ["Brave"],
    linuxApp: "brave",
    winLocalStateRel: "Local State",
  },
  edge: {
    macLabels: ["Microsoft Edge Safe Storage"],
    macAccounts: ["Microsoft Edge"],
    linuxApp: "microsoft-edge",
    winLocalStateRel: "Local State",
  },
  arc: {
    macLabels: ["Arc Safe Storage"],
    macAccounts: ["Arc"],
    // No Linux/Windows Arc build as of 2026-05.
    winLocalStateRel: "Local State",
  },
  dia: {
    macLabels: ["Dia Safe Storage"],
    macAccounts: ["Dia"],
    winLocalStateRel: "Local State",
  },
  atlas: {
    macLabels: [
      "Atlas Safe Storage",
      "ChatGPT Atlas Safe Storage",
      "OpenAI Atlas Safe Storage",
      "ChatGPT Safe Storage",
    ],
    macAccounts: ["Atlas", "ChatGPT", "OpenAI"],
    winLocalStateRel: "Local State",
  },
};
