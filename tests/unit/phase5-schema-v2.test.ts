/**
 * Phase 5 schema-v2 contract — unit-level guard.
 *
 * The adapter-project tests in tests/adapter/phase5-workflow.test.ts
 * cover the structural and routing contract but only run under
 * `npm run test:adapter`. This file runs under `npm run test` (the
 * default verify chain) so a regression in the new adapters is caught
 * on every commit.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import { migrateToV2 } from "../../src/core/schema-v2.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "..", "src", "adapters");

interface V2Adapter {
  name: string;
  capabilities?: string[];
  minimum_capability?: string;
  trust?: string;
  confidentiality?: string;
  quarantine?: boolean;
}

const PHASE_5_ADAPTERS: Array<{
  rel: string;
  capability: string;
  min: string;
  confidentiality: "private" | "internal";
}> = [
  {
    rel: "apple-notes/list.yaml",
    capability: "desktop-ax",
    min: "desktop-ax.applescript",
    confidentiality: "private",
  },
  {
    rel: "apple-notes/read.yaml",
    capability: "desktop-ax",
    min: "desktop-ax.applescript",
    confidentiality: "private",
  },
  {
    rel: "apple-notes/search.yaml",
    capability: "desktop-ax",
    min: "desktop-ax.applescript",
    confidentiality: "private",
  },
  {
    rel: "imessage/recent.yaml",
    capability: "subprocess",
    min: "subprocess.exec",
    confidentiality: "private",
  },
  {
    rel: "imessage/contact.yaml",
    capability: "subprocess",
    min: "subprocess.exec",
    confidentiality: "private",
  },
  {
    rel: "imessage/search.yaml",
    capability: "subprocess",
    min: "subprocess.exec",
    confidentiality: "private",
  },
  {
    rel: "linear/issue-list.yaml",
    capability: "http",
    min: "http.fetch",
    confidentiality: "internal",
  },
  {
    rel: "linear/issue-create.yaml",
    capability: "http",
    min: "http.fetch",
    confidentiality: "internal",
  },
  {
    rel: "linear/issue-update.yaml",
    capability: "http",
    min: "http.fetch",
    confidentiality: "internal",
  },
];

describe("Phase 5 adapters — schema-v2 fields present from day one", () => {
  for (const { rel, capability, min, confidentiality } of PHASE_5_ADAPTERS) {
    it(`${rel} declares all five schema-v2 fields`, () => {
      const raw = readFileSync(join(ADAPTERS_DIR, rel), "utf-8");
      const parsed = yaml.load(raw) as V2Adapter;

      // Phase 1.7 migration should find nothing to change — the v2
      // shape must already be present in source.
      expect(parsed.capabilities).toBeDefined();
      expect(parsed.capabilities).toContain(capability);
      expect(parsed.minimum_capability).toBe(min);
      expect(parsed.trust).toBe("user");
      expect(parsed.confidentiality).toBe(confidentiality);
      expect(parsed.quarantine).toBe(false);

      // And migrateToV2() is a no-op when v2 fields are already correct.
      const migrated = migrateToV2(parsed);
      expect(migrated.capabilities).toEqual(parsed.capabilities);
      expect(migrated.minimum_capability).toBe(parsed.minimum_capability);
      expect(migrated.trust).toBe(parsed.trust);
      expect(migrated.confidentiality).toBe(parsed.confidentiality);
      expect(migrated.quarantine).toBe(parsed.quarantine);
    });
  }

  it("all nine new YAML files are accounted for", () => {
    expect(PHASE_5_ADAPTERS).toHaveLength(9);
  });
});
