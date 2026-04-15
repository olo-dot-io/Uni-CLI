/**
 * Schema v2 validation + v1→v2 migration tests.
 *
 * Phase 1.1 introduces required trust/confidentiality/capabilities/
 * minimum_capability/quarantine fields on AdapterCommand v2. Legacy v1
 * adapters must migrate transparently via migrateToV2() defaults.
 */

import { describe, it, expect } from "vitest";
import {
  parseAdapterV2,
  validateAdapterV2,
  migrateToV2,
  AdapterV2DefaultMinimumCapability,
} from "../../../src/core/schema-v2.js";

describe("validateAdapterV2", () => {
  it("accepts a minimal v2 command with all required fields", () => {
    const cmd = {
      name: "search",
      description: "find things",
      capabilities: ["http.fetch"],
      minimum_capability: "http.fetch",
      trust: "public",
      confidentiality: "public",
      quarantine: false,
    };
    const res = validateAdapterV2(cmd);
    expect(res.ok).toBe(true);
  });

  it("rejects a command missing trust", () => {
    const cmd = {
      name: "x",
      capabilities: [],
      minimum_capability: "http.fetch",
      confidentiality: "public",
      quarantine: false,
    };
    const res = validateAdapterV2(cmd);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/trust/i);
  });

  it("rejects invalid trust enum", () => {
    const cmd = {
      name: "x",
      capabilities: [],
      minimum_capability: "http.fetch",
      trust: "untrusted",
      confidentiality: "public",
      quarantine: false,
    };
    const res = validateAdapterV2(cmd);
    expect(res.ok).toBe(false);
  });

  it("rejects invalid confidentiality enum", () => {
    const cmd = {
      name: "x",
      capabilities: [],
      minimum_capability: "http.fetch",
      trust: "public",
      confidentiality: "top-secret",
      quarantine: false,
    };
    const res = validateAdapterV2(cmd);
    expect(res.ok).toBe(false);
  });
});

describe("parseAdapterV2", () => {
  it("returns typed data when valid", () => {
    const cmd = {
      name: "q",
      capabilities: ["cdp-browser.click"],
      minimum_capability: "cdp-browser.click",
      trust: "user",
      confidentiality: "internal",
      quarantine: false,
    };
    const parsed = parseAdapterV2(cmd);
    expect(parsed.name).toBe("q");
    expect(parsed.capabilities).toEqual(["cdp-browser.click"]);
    expect(parsed.trust).toBe("user");
    expect(parsed.confidentiality).toBe("internal");
    expect(parsed.quarantine).toBe(false);
  });

  it("throws on invalid input", () => {
    expect(() => parseAdapterV2({ name: "x" })).toThrow();
  });
});

describe("migrateToV2 — v1 → v2 defaults", () => {
  it("fills all required v2 fields with safe defaults", () => {
    const v1 = { name: "legacy", description: "old" };
    const v2 = migrateToV2(v1);
    expect(v2.name).toBe("legacy");
    expect(v2.description).toBe("old");
    expect(v2.schema_version).toBe("v2");
    expect(v2.capabilities).toEqual([]);
    expect(v2.minimum_capability).toBe(AdapterV2DefaultMinimumCapability);
    expect(v2.trust).toBe("public");
    expect(v2.confidentiality).toBe("public");
    expect(v2.quarantine).toBe(false);
  });

  it("preserves existing v2 fields when already set", () => {
    const existing = {
      name: "shiny",
      capabilities: ["cua.click"],
      minimum_capability: "cua.click",
      trust: "system" as const,
      confidentiality: "private" as const,
      quarantine: true,
    };
    const v2 = migrateToV2(existing);
    expect(v2.capabilities).toEqual(["cua.click"]);
    expect(v2.minimum_capability).toBe("cua.click");
    expect(v2.trust).toBe("system");
    expect(v2.confidentiality).toBe("private");
    expect(v2.quarantine).toBe(true);
  });

  it("passes schema validation after migration", () => {
    const v1 = { name: "legacy" };
    const v2 = migrateToV2(v1);
    const validated = validateAdapterV2(v2);
    expect(validated.ok).toBe(true);
  });

  it("default minimum_capability is 'http.fetch' (the baseline transport)", () => {
    expect(AdapterV2DefaultMinimumCapability).toBe("http.fetch");
  });
});
