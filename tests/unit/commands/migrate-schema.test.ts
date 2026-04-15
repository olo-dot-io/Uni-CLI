/**
 * Tests for `unicli migrate schema-v2` — the mass-migration helper.
 *
 * Contract we care about:
 *   1. A v1 YAML adapter gains the five required schema-v2 fields.
 *   2. Capabilities are inferred from pipeline step names.
 *   3. Trust bumps to "user" for desktop / exec / ax_* / cua_* steps.
 *   4. Confidentiality bumps to "private" for dir names matching the
 *      private-data patterns (mail, imessage, auth, ...).
 *   5. Re-running the migration over already-v2 YAML is a no-op.
 *   6. Malformed YAML is quarantined with a descriptive reason.
 */

import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import {
  migrateYamlText,
  inferCapabilities,
  inferMinimumCapability,
} from "../../../src/commands/migrate-schema.js";

function loadBack(content: string): Record<string, unknown> {
  const parsed = yaml.load(content);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("expected yaml to parse into an object");
  }
  return parsed as Record<string, unknown>;
}

describe("inferCapabilities", () => {
  it("maps fetch to http.fetch", () => {
    const caps = inferCapabilities([{ fetch: { url: "https://example.com" } }]);
    expect(caps).toEqual(["http.fetch"]);
  });

  it("maps navigate + click to cdp-browser capabilities", () => {
    const caps = inferCapabilities([
      { navigate: "https://example.com" },
      { click: ".btn" },
    ]);
    expect(caps.sort()).toEqual(
      ["cdp-browser.click", "cdp-browser.navigate"].sort(),
    );
  });

  it("maps exec to subprocess.exec", () => {
    const caps = inferCapabilities([{ exec: { command: "ls" } }]);
    expect(caps).toEqual(["subprocess.exec"]);
  });

  it("ignores control-flow steps (if, each, set, filter)", () => {
    const caps = inferCapabilities([
      { set: { x: 1 } },
      { filter: "item.ok" },
      { if: { condition: "true", then: [{ fetch: { url: "u" } }] } },
    ]);
    // The nested fetch should still be picked up.
    expect(caps).toEqual(["http.fetch"]);
  });
});

describe("inferMinimumCapability", () => {
  it("returns the highest-priority capability", () => {
    expect(inferMinimumCapability(["http.fetch", "subprocess.exec"])).toBe(
      "subprocess.exec",
    );
  });

  it("returns http.fetch for an empty capability set", () => {
    expect(inferMinimumCapability([])).toBe("http.fetch");
  });

  it("picks cdp-browser.* over plain http.fetch", () => {
    expect(inferMinimumCapability(["http.fetch", "cdp-browser.navigate"])).toBe(
      "cdp-browser.navigate",
    );
  });
});

describe("migrateYamlText — injection", () => {
  it("adds all five v2 fields to a minimal v1 adapter", () => {
    const raw = [
      "site: example",
      "name: search",
      "type: web-api",
      "strategy: public",
      "pipeline:",
      "  - fetch:",
      "      url: https://example.com/api",
    ].join("\n");

    const result = migrateYamlText(raw, "src/adapters/example/search.yaml");
    expect(result.status).toBe("migrated");
    if (result.status !== "migrated") throw new Error("expected migrated");

    const parsed = loadBack(result.content);
    expect(parsed.capabilities).toEqual(["http.fetch"]);
    expect(parsed.minimum_capability).toBe("http.fetch");
    expect(parsed.trust).toBe("public");
    expect(parsed.confidentiality).toBe("public");
    expect(parsed.quarantine).toBe(false);
    // Original fields untouched.
    expect(parsed.site).toBe("example");
    expect(parsed.name).toBe("search");
  });

  it("bumps trust to 'user' when the adapter type is desktop", () => {
    const raw = [
      "site: gimp",
      "name: flip",
      "type: desktop",
      "pipeline:",
      "  - exec: { command: gimp }",
    ].join("\n");
    const result = migrateYamlText(raw, "src/adapters/gimp/flip.yaml");
    if (result.status !== "migrated") throw new Error("expected migrated");
    const parsed = loadBack(result.content);
    expect(parsed.trust).toBe("user");
    expect(parsed.capabilities).toEqual(["subprocess.exec"]);
    expect(parsed.minimum_capability).toBe("subprocess.exec");
  });

  it("bumps trust to 'user' for any pipeline with exec", () => {
    const raw = [
      "site: slack",
      "name: channels",
      "type: bridge",
      "pipeline:",
      "  - exec: { command: slack }",
    ].join("\n");
    const result = migrateYamlText(raw, "src/adapters/slack/channels.yaml");
    if (result.status !== "migrated") throw new Error("expected migrated");
    const parsed = loadBack(result.content);
    expect(parsed.trust).toBe("user");
  });

  it("bumps trust to 'user' for cua_* steps", () => {
    const raw = [
      "site: example",
      "name: task",
      "type: desktop",
      "pipeline:",
      "  - cua_click: { selector: 'button' }",
    ].join("\n");
    const result = migrateYamlText(raw, "src/adapters/example/task.yaml");
    if (result.status !== "migrated") throw new Error("expected migrated");
    const parsed = loadBack(result.content);
    expect(parsed.trust).toBe("user");
    expect(parsed.capabilities).toContain("cua.click");
  });

  it("bumps confidentiality to 'private' for mail-like site dirs", () => {
    const raw = [
      "site: mail",
      "name: list",
      "type: web-api",
      "pipeline:",
      "  - fetch: { url: https://example.com }",
    ].join("\n");
    const result = migrateYamlText(raw, "src/adapters/mail/list.yaml");
    if (result.status !== "migrated") throw new Error("expected migrated");
    const parsed = loadBack(result.content);
    expect(parsed.confidentiality).toBe("private");
  });

  it("preserves quarantine: true and quarantineReason", () => {
    const raw = [
      "site: example",
      "name: broken",
      "type: web-api",
      "quarantine: true",
      'quarantineReason: "upstream API gone"',
      "pipeline:",
      "  - fetch: { url: https://example.com }",
    ].join("\n");
    const result = migrateYamlText(raw, "src/adapters/example/broken.yaml");
    if (result.status !== "migrated") throw new Error("expected migrated");
    const parsed = loadBack(result.content);
    expect(parsed.quarantine).toBe(true);
    expect(parsed.quarantineReason).toBe("upstream API gone");
  });
});

describe("migrateYamlText — idempotency", () => {
  it("re-running on already-v2 YAML returns status 'already_v2'", () => {
    const raw = [
      "site: example",
      "name: search",
      "type: web-api",
      "strategy: public",
      "pipeline:",
      "  - fetch: { url: https://example.com }",
      'capabilities: ["http.fetch"]',
      "minimum_capability: http.fetch",
      "trust: public",
      "confidentiality: public",
      "quarantine: false",
    ].join("\n");
    const result = migrateYamlText(raw, "src/adapters/example/search.yaml");
    expect(result.status).toBe("already_v2");
  });
});

describe("migrateYamlText — quarantine-on-malformed", () => {
  it("flags unparseable YAML as quarantined with a descriptive reason", () => {
    const raw =
      "site: bad\nname: x\npipeline:\n  - fetch: { url: [unterminated";
    const result = migrateYamlText(raw, "src/adapters/bad/x.yaml");
    expect(result.status).toBe("quarantine");
    if (result.status !== "quarantine") return;
    expect(result.reason).toContain("malformed during schema-v2 sweep");
    expect(result.content).toContain("quarantine: true");
    expect(result.content).toContain("malformed during schema-v2 sweep");
  });
});
