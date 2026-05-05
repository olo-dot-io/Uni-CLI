/**
 * Quarantine honesty invariant — every adapter shipped with `quarantine: true`
 * MUST carry a non-empty `quarantineReason` containing a 4-digit year.
 *
 * Why: without dated reasons, `quarantine: true` decays into a silent
 * kill-switch — the next agent reading the YAML can't tell whether the
 * upstream is genuinely broken (try-and-repair worth doing) or whether
 * the maintainer just disabled the path months ago.
 *
 * The test walks the real `src/adapters/` tree at load time, so every
 * future quarantine commit is forced to pass the honesty bar.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const ADAPTERS_ROOT = join(process.cwd(), "src", "adapters");
const YEAR_PATTERN = /\b(19|20|21)\d{2}\b/;

function walkYamlFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkYamlFiles(full, out);
    } else if (entry.endsWith(".yaml")) {
      out.push(full);
    }
  }
  return out;
}

interface AdapterShape {
  quarantine?: boolean;
  quarantineReason?: string;
  site?: string;
  name?: string;
}

function loadAdapter(path: string): AdapterShape | null {
  try {
    return yaml.load(readFileSync(path, "utf-8")) as AdapterShape;
  } catch {
    return null;
  }
}

describe("quarantine honesty invariant", () => {
  const yamlFiles = walkYamlFiles(ADAPTERS_ROOT);
  const quarantined = yamlFiles
    .map((path) => ({ path, adapter: loadAdapter(path) }))
    .filter(
      (entry): entry is { path: string; adapter: AdapterShape } =>
        entry.adapter?.quarantine === true,
    );

  it("the working tree has at least one quarantined adapter (sanity)", () => {
    expect(quarantined.length).toBeGreaterThan(0);
  });

  it.each(quarantined)(
    "$path → quarantineReason is non-empty and includes a 4-digit year",
    ({ adapter, path }) => {
      const reason = adapter.quarantineReason ?? "";
      expect(
        reason.length,
        `${path} sets quarantine: true but has no quarantineReason`,
      ).toBeGreaterThan(0);
      expect(
        YEAR_PATTERN.test(reason),
        `${path} quarantineReason "${reason}" is missing a 4-digit year for provenance`,
      ).toBe(true);
    },
  );
});
