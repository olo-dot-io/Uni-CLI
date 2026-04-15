/**
 * v0.212.1 third-round audit — regression tests for the six hardening
 * fixes landed after the post-tag audit. Each `describe` block maps 1:1
 * to an audit finding so a future regression flips exactly one known
 * test name, not a diffuse "something is off".
 *
 * Findings covered:
 *   1. SSRF guard on pipeline fetch / fetch_text / http.download
 *   2. AppleScript escapeAs — newline + NUL neutralisation
 *   3. schema-v2 hard gate — full parsed object (not 5-field projection)
 *   4. ACP prompt length cap — 64 KiB bound before regex
 *   5. stepParallel concurrency cap — uses mapConcurrent, not Promise.all
 *   6. migrate-schema roundtrip — blesses only files that re-validate
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── 1. SSRF guard ─────────────────────────────────────────────────────
describe("assertSafeRequestUrl — SSRF defence on pipeline fetch", () => {
  let prevAllowLocal: string | undefined;
  beforeEach(() => {
    prevAllowLocal = process.env.UNICLI_ALLOW_LOCAL;
    // The audit fix triggers only when the override is OFF — the test
    // harness sets it globally via vitest.config.ts, so we peel it back
    // for the blocks that must see real production behaviour.
    delete process.env.UNICLI_ALLOW_LOCAL;
  });
  afterEach(() => {
    if (prevAllowLocal !== undefined)
      process.env.UNICLI_ALLOW_LOCAL = prevAllowLocal;
  });

  it("accepts a public https URL", async () => {
    const { assertSafeRequestUrl } =
      await import("../../src/engine/yaml-runner.js");
    expect(() => assertSafeRequestUrl("https://api.example.com/v1/foo")).not
      .toThrow;
    expect(() => assertSafeRequestUrl("https://api.example.com/v1/foo")).not
      .toThrow;
  });

  it.each([
    ["file://", "file:///etc/passwd"],
    ["data:", "data:text/plain,hello"],
    ["gopher:", "gopher://evil.test/"],
  ])("rejects %s scheme", async (_label, url) => {
    const { assertSafeRequestUrl } =
      await import("../../src/engine/yaml-runner.js");
    expect(() => assertSafeRequestUrl(url)).toThrow(/disallowed URL scheme/);
  });

  it.each([
    ["127.0.0.1 loopback", "http://127.0.0.1:8080/admin"],
    ["IPv6 loopback", "http://[::1]/admin"],
    ["AWS IMDS", "http://169.254.169.254/latest/meta-data/"],
    ["GCP metadata", "http://metadata.google.internal/computeMetadata/v1/"],
    ["RFC1918 10/8", "http://10.0.0.1/internal"],
    ["RFC1918 192.168/16", "http://192.168.1.1/router"],
    ["RFC1918 172.16/12", "http://172.16.5.9/internal"],
    ["localhost literal", "http://localhost/"],
  ])("rejects %s", async (_label, url) => {
    const { assertSafeRequestUrl } =
      await import("../../src/engine/yaml-runner.js");
    expect(() => assertSafeRequestUrl(url)).toThrow(
      /blocked fetch to reserved\/local address/,
    );
  });

  it("UNICLI_ALLOW_LOCAL=1 override permits 127.0.0.1", async () => {
    process.env.UNICLI_ALLOW_LOCAL = "1";
    const { assertSafeRequestUrl } =
      await import("../../src/engine/yaml-runner.js");
    expect(() =>
      assertSafeRequestUrl("http://127.0.0.1:8080/ok"),
    ).not.toThrow();
  });

  it("rejects a malformed URL rather than passing it through", async () => {
    const { assertSafeRequestUrl } =
      await import("../../src/engine/yaml-runner.js");
    expect(() => assertSafeRequestUrl("not a url")).toThrow(/invalid URL/);
  });
});

// ── 2. AppleScript escape ─────────────────────────────────────────────
describe("escapeAs — AppleScript string literal sanitisation", () => {
  // The function is not exported — we reach it via the only caller whose
  // observable shape reveals the escape: the transport's dispatch of
  // `ax_focus` builds a script literal from the user-supplied `app`
  // param. An AxShell stub captures the final osascript args.
  it("folds \\r\\n to spaces so new statements can't be smuggled", async () => {
    const { DesktopAxTransport } =
      await import("../../src/transport/adapters/desktop-ax.js");
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockShell = {
      async run(cmd: string, args: readonly string[]) {
        calls.push({ cmd, args: [...args] });
        return { stdout: "", stderr: "" };
      },
    };
    const ax = new DesktopAxTransport({ shell: mockShell, platform: "darwin" });
    await ax.open({
      cwd: "/",
      env: {},
      bus: { register() {}, get() {}, list: () => [], require() {} } as never,
    });
    await ax.action({
      kind: "ax_focus",
      params: { app: 'Calculator"\nos_command("rm -rf /")' },
    });
    const script = calls[0]?.args.at(-1) ?? "";
    // The attack relies on (a) the newline terminating the `tell` and
    // (b) an unescaped quote closing the string literal. Both must be
    // neutralised; the literal text "os_command" is harmless once it
    // sits safely inside a `\"…\"` string literal.
    expect(script).not.toContain("\n");
    expect(script).not.toContain("\r");
    // The smuggled quote is backslash-escaped → remains part of the
    // string, cannot close it.
    const quoteGroups = script.match(/(?:^|[^\\])"/g) ?? [];
    // Exactly two non-escaped quotes: the pair that delimits the app name.
    expect(quoteGroups.length).toBe(2);
    expect(script.startsWith('tell application "')).toBe(true);
  });

  it("strips NUL bytes so osascript doesn't abort mid-script", async () => {
    const { DesktopAxTransport } =
      await import("../../src/transport/adapters/desktop-ax.js");
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockShell = {
      async run(cmd: string, args: readonly string[]) {
        calls.push({ cmd, args: [...args] });
        return { stdout: "", stderr: "" };
      },
    };
    const ax = new DesktopAxTransport({ shell: mockShell, platform: "darwin" });
    await ax.action({
      kind: "ax_focus",
      params: { app: "Foo\u0000Bar" },
    });
    const script = calls[0]?.args.at(-1) ?? "";
    expect(script).not.toContain("\u0000");
    expect(script).toContain("FooBar");
  });
});

// ── 3. schema-v2 full-object gate ─────────────────────────────────────
describe("schema-v2 loader gate — full YAML validation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unicli-schema-full-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a well-formed adapter with a valid pipeline array", async () => {
    const { validateAdapterV2 } = await import("../../src/core/schema-v2.js");
    const candidate = {
      name: "ok",
      capabilities: ["http.fetch"],
      minimum_capability: "http.fetch",
      trust: "public",
      confidentiality: "public",
      quarantine: false,
      pipeline: [{ fetch: { url: "https://example.com/ok" } }],
    };
    const res = validateAdapterV2(candidate);
    expect(res.ok).toBe(true);
  });

  it("rejects a candidate whose pipeline is a string (v0.212 regression guard)", async () => {
    const { validateAdapterV2 } = await import("../../src/core/schema-v2.js");
    const candidate = {
      name: "bad",
      capabilities: [],
      minimum_capability: "http.fetch",
      trust: "public",
      confidentiality: "public",
      quarantine: false,
      pipeline: "not an array",
    };
    const res = validateAdapterV2(candidate);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/pipeline/i);
  });
});

// ── 4. ACP prompt length cap ──────────────────────────────────────────
describe("parseUnicliInvocation — ReDoS length bound", () => {
  it("parses an invocation at the start of a large prompt", async () => {
    const { parseUnicliInvocation } = await import("../../src/protocol/acp.js");
    const prompt = "unicli twitter trending --limit 3\n" + "x".repeat(200_000);
    const parsed = parseUnicliInvocation(prompt);
    expect(parsed?.site).toBe("twitter");
    expect(parsed?.command).toBe("trending");
    expect(parsed?.args.limit).toBe(3);
  });

  it("returns undefined when the invocation is past the 64 KiB window", async () => {
    const { parseUnicliInvocation } = await import("../../src/protocol/acp.js");
    const prompt = "x".repeat(70_000) + " unicli twitter trending --limit 3";
    const parsed = parseUnicliInvocation(prompt);
    expect(parsed).toBeUndefined();
  });
});

// ── 5. migrate-schema roundtrip ───────────────────────────────────────
describe("migrateYamlText — post-migration roundtrip validation", () => {
  it("quarantines a file when the rewritten YAML still violates v2", async () => {
    const { migrateYamlText } =
      await import("../../src/commands/migrate-schema.js");
    // `pipeline: "not an array"` is syntactically valid YAML but the v2
    // schema rejects it. The append-only migrator CAN'T fix the broken
    // shape — the roundtrip must catch it and quarantine instead of
    // blessing it as "migrated".
    const raw = [
      "name: broken",
      "description: broken adapter",
      'pipeline: "not an array"',
      "",
    ].join("\n");
    const result = migrateYamlText(raw, "/tmp/broken.yaml");
    expect(result.status).toBe("quarantine");
    if (result.status === "quarantine") {
      expect(result.reason).toMatch(/roundtrip validation failed/);
      // The quarantine append must itself be parseable so the next
      // migrate run recognises the file as already v2 + quarantined.
      expect(result.content).toContain("quarantine: true");
      expect(result.content).toContain("quarantineReason:");
    }
  });

  it("migrates a plain v1 adapter whose rewritten text passes the roundtrip", async () => {
    const { migrateYamlText } =
      await import("../../src/commands/migrate-schema.js");
    const raw = [
      "name: ok",
      "description: happy path",
      "pipeline:",
      "  - fetch:",
      "      url: https://example.com/ok",
      "",
    ].join("\n");
    const result = migrateYamlText(raw, "/tmp/ok.yaml");
    expect(result.status).toBe("migrated");
    if (result.status === "migrated") {
      expect(result.content).toContain("capabilities:");
      expect(result.content).toContain("minimum_capability:");
    }
  });
});

// ── 6. stepParallel concurrency cap ───────────────────────────────────
describe("stepParallel — bounded concurrency (not Promise.all)", () => {
  it("source uses mapConcurrent so 100-branch pipelines don't exhaust sockets", async () => {
    // Meta-check: the fix is a structural guarantee rather than a
    // runtime-observable throttle (which would require injecting a
    // branch that observes its own concurrency peers). We pin the
    // behaviour by asserting the import and call shape stay intact —
    // a regression to `Promise.all` would trip this immediately.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../src/engine/yaml-runner.ts", import.meta.url),
      "utf-8",
    );
    const parallelBody = src.slice(
      src.indexOf("export async function stepParallel"),
    );
    const body = parallelBody.slice(0, parallelBody.indexOf("\n}\n"));
    expect(body).toMatch(/mapConcurrent\(branches/);
    expect(body).not.toMatch(/Promise\.all\(\s*\n?\s*branches\.map/);
  });
});
