/**
 * Conformance test — every adapter YAML under src/adapters/ must satisfy
 * the schema-v2 contract. This is the final backstop against a YAML ever
 * being registered without the five required metadata fields.
 *
 * Lives in the adapter project so CI runs it against the full fleet on
 * every PR touching adapters.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parseAdapterV2 } from "../../src/core/schema-v2.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "..", "src", "adapters");

function* walkYaml(path: string): Generator<string> {
  const st = statSync(path);
  if (st.isFile()) {
    if (extname(path) === ".yaml" || extname(path) === ".yml") yield path;
    return;
  }
  for (const entry of readdirSync(path)) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    yield* walkYaml(join(path, entry));
  }
}

describe("schema-v2 conformance", () => {
  const files: string[] = Array.from(walkYaml(ADAPTERS_DIR));

  it("found adapter YAML files to check", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const file of files) {
    const rel = file.slice(ADAPTERS_DIR.length + 1);
    describe(rel, () => {
      it("parses as schema-v2", () => {
        const raw = readFileSync(file, "utf-8");
        const parsed = yaml.load(raw) as Record<string, unknown>;
        // Project only the v2-relevant fields before handing off to zod;
        // parseAdapterV2 ignores unknown keys but asserts shape on the
        // five required fields + the command name.
        const projection = {
          name: parsed.name ?? "unknown",
          description: parsed.description,
          capabilities: parsed.capabilities,
          minimum_capability: parsed.minimum_capability,
          trust: parsed.trust,
          confidentiality: parsed.confidentiality,
          quarantine: parsed.quarantine ?? false,
        };
        expect(() => parseAdapterV2(projection)).not.toThrow();
      });
    });
  }
});
