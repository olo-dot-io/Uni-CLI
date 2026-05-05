/**
 * @owner   tests/adapter/cua-samples.test.ts
 * @does    Validate active CUA sample adapters without exercising host apps or VLM backends.
 * @needs   src/adapters/figma/export-selected.yaml, src/adapters/zoom/toggle-mute.yaml, CAPABILITY_MATRIX
 * @feeds   npm run test:adapter, CUA sample adapter contract
 * @breaks  Unknown CUA or desktop step names can ship without matching transports.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import { CAPABILITY_MATRIX } from "../../src/transport/capability.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "..", "src", "adapters");

interface Adapter {
  site: string;
  name: string;
  quarantine?: boolean;
  quarantineReason?: string;
  pipeline: Array<Record<string, unknown>>;
}

const SAMPLES = [
  { rel: "figma/export-selected.yaml" },
  { rel: "zoom/toggle-mute.yaml" },
];

const SIBLING_KEYS = new Set([
  "fallback",
  "then",
  "else",
  "merge",
  "retry",
  "backoff",
]);

function stepAction(step: Record<string, unknown>): string {
  for (const key of Object.keys(step)) {
    if (!SIBLING_KEYS.has(key)) return key;
  }
  return "";
}

describe("CUA sample adapters", () => {
  for (const { rel } of SAMPLES) {
    const absPath = join(ADAPTERS_DIR, rel);
    const raw = readFileSync(absPath, "utf-8");
    const parsed = yaml.load(raw) as Adapter;

    describe(rel, () => {
      it("parses and has site + name", () => {
        expect(parsed.site).toBeTruthy();
        expect(parsed.name).toBeTruthy();
      });

      it("is quarantined with a reason", () => {
        expect(parsed.quarantine).toBe(true);
        expect(typeof parsed.quarantineReason).toBe("string");
        expect((parsed.quarantineReason ?? "").length).toBeGreaterThan(10);
      });

      it("has a non-empty pipeline", () => {
        expect(Array.isArray(parsed.pipeline)).toBe(true);
        expect(parsed.pipeline.length).toBeGreaterThan(0);
      });

      it("every step action is present in CAPABILITY_MATRIX", () => {
        const unknown = parsed.pipeline
          .map(stepAction)
          .filter((a) => a.length > 0 && !(a in CAPABILITY_MATRIX));
        expect(unknown).toEqual([]);
      });
    });
  }

  it("figma sample composes cua + desktop-ax", () => {
    const raw = readFileSync(
      join(ADAPTERS_DIR, "figma/export-selected.yaml"),
      "utf-8",
    );
    const parsed = yaml.load(raw) as Adapter;
    const actions = parsed.pipeline.map(stepAction);
    expect(actions.some((a) => a.startsWith("cua_"))).toBe(true);
    expect(actions.some((a) => a.startsWith("ax_") || a === "launch_app")).toBe(
      true,
    );
  });

  it("zoom sample is pure AX — no cua_* verbs", () => {
    const raw = readFileSync(
      join(ADAPTERS_DIR, "zoom/toggle-mute.yaml"),
      "utf-8",
    );
    const parsed = yaml.load(raw) as Adapter;
    const actions = parsed.pipeline.map(stepAction);
    expect(actions.some((a) => a.startsWith("cua_"))).toBe(false);
    expect(actions).toContain("applescript");
  });
});
