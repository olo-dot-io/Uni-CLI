import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "..", "src", "adapters");

const VALID_TYPES = ["web-api", "desktop", "browser", "bridge", "service"];
const VALID_STRATEGIES = ["public", "cookie", "header", "intercept", "ui"];

interface ParsedAdapter {
  site: string;
  name: string;
  type?: string;
  strategy?: string;
  pipeline?: unknown[];
  args?: Record<string, unknown>;
  quarantine?: boolean;
  quarantineReason?: string;
}

const adapters: { file: string; parsed: ParsedAdapter }[] = [];

for (const site of readdirSync(ADAPTERS_DIR)) {
  if (site.startsWith("_") || site.startsWith(".")) continue;
  const siteDir = join(ADAPTERS_DIR, site);
  if (!statSync(siteDir).isDirectory()) continue;

  for (const file of readdirSync(siteDir)) {
    if (extname(file) !== ".yaml" && extname(file) !== ".yml") continue;
    const filePath = join(siteDir, file);
    const raw = readFileSync(filePath, "utf-8");
    const parsed = yaml.load(raw) as ParsedAdapter;
    adapters.push({ file: `${site}/${file}`, parsed });
  }
}

describe("all YAML adapters are valid", () => {
  it("found adapters to test", () => {
    expect(adapters.length).toBeGreaterThan(0);
  });

  for (const { file, parsed } of adapters) {
    describe(file, () => {
      it("has required fields", () => {
        expect(parsed.site).toBeTruthy();
        expect(parsed.name).toBeTruthy();
      });

      it("has valid type", () => {
        if (parsed.type) {
          expect(VALID_TYPES).toContain(parsed.type);
        }
      });

      it("has valid strategy", () => {
        if (parsed.strategy) {
          expect(VALID_STRATEGIES).toContain(parsed.strategy);
        }
      });

      it("has pipeline or execArgs", () => {
        if (parsed.quarantine === true) {
          // Quarantined adapters are intentionally broken; they may lack
          // a pipeline while awaiting repair.
          return;
        }
        expect(
          parsed.pipeline || (parsed as Record<string, unknown>).execArgs,
        ).toBeTruthy();
      });

      it("quarantine flag is boolean when set", () => {
        if (parsed.quarantine !== undefined) {
          expect(typeof parsed.quarantine).toBe("boolean");
        }
      });
    });
  }
});
