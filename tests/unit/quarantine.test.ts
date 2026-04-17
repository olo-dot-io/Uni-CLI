import { describe, it, expect } from "vitest";
import { loadAdaptersFromDir } from "../../src/discovery/loader.js";
import { listCommands } from "../../src/registry.js";
import { format, detectFormat } from "../../src/output/formatter.js";
import type { AgentContext } from "../../src/output/envelope.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Quarantine flag contract:
 *   - YAML loader preserves `quarantine: true` on the parsed AdapterCommand
 *   - listCommands() surfaces `quarantined` on each entry
 *   - A `quarantineReason` round-trips through both layers
 *   - Omitted flag defaults to `quarantined: false`
 */

function writeFixture(base: string, site: string, file: string, body: string) {
  const siteDir = join(base, site);
  mkdirSync(siteDir, { recursive: true });
  writeFileSync(join(siteDir, file), body, "utf-8");
}

describe("quarantine flag", () => {
  const tmpBase = mkdtempSync(join(tmpdir(), "unicli-quarantine-"));

  // Schema-v2 footer to keep the strict loader gate happy.
  const V2_FOOTER = [
    'capabilities: ["http.fetch"]',
    "minimum_capability: http.fetch",
    "trust: public",
    "confidentiality: public",
  ];

  // Healthy adapter with no flag
  writeFixture(
    tmpBase,
    "qfixture-healthy",
    "ping.yaml",
    [
      "site: qfixture-healthy",
      "name: ping",
      "description: healthy fixture",
      "type: web-api",
      "strategy: public",
      "pipeline:",
      "  - fetch:",
      "      url: https://example.com/ping.json",
      ...V2_FOOTER,
      "quarantine: false",
    ].join("\n") + "\n",
  );

  // Quarantined adapter with reason
  writeFixture(
    tmpBase,
    "qfixture-broken",
    "broken.yaml",
    [
      "site: qfixture-broken",
      "name: broken",
      "description: broken fixture",
      "type: web-api",
      "strategy: public",
      "quarantine: true",
      "quarantineReason: upstream API returned 451",
      "pipeline:",
      "  - fetch:",
      "      url: https://example.com/gone.json",
      ...V2_FOOTER,
    ].join("\n") + "\n",
  );

  loadAdaptersFromDir(tmpBase);

  it("loads healthy adapter without quarantine flag", () => {
    const all = listCommands();
    const healthy = all.find(
      (c) => c.site === "qfixture-healthy" && c.command === "ping",
    );
    expect(healthy).toBeDefined();
    expect(healthy!.quarantined).toBe(false);
    expect(healthy!.quarantineReason).toBeUndefined();
  });

  it("loads quarantined adapter with quarantined=true", () => {
    const all = listCommands();
    const broken = all.find(
      (c) => c.site === "qfixture-broken" && c.command === "broken",
    );
    expect(broken).toBeDefined();
    expect(broken!.quarantined).toBe(true);
    expect(broken!.quarantineReason).toBe("upstream API returned 451");
  });

  // Cleanup — vitest runs tests serially per file, safe to rm at end
  setTimeout(() => {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }, 0);
});

describe("quarantine v2 envelope contract", () => {
  it("format() with quarantine error context produces a v2 error envelope", () => {
    const site = "qfixture-broken";
    const cmd = "broken";
    const errCtx: AgentContext = {
      command: `${site}.${cmd}`,
      duration_ms: 1,
      surface: "web",
      error: {
        code: "quarantined",
        message: `adapter ${site}.${cmd} is quarantined: upstream API returned 451`,
        adapter_path: `src/adapters/${site}/${cmd}.yaml`,
        step: 0,
        suggestion: `run \`unicli repair ${site} ${cmd}\` or unset \`quarantine\` in the adapter YAML after fixing; override with UNICLI_FORCE_QUARANTINE=1 for one-off debugging`,
        retryable: false,
        alternatives: [`unicli repair ${site} ${cmd}`],
      },
    };
    const fmt = detectFormat("json");
    const rendered = format([], undefined, fmt, errCtx);
    const envelope = JSON.parse(rendered) as Record<string, unknown>;

    expect(envelope.ok).toBe(false);
    expect(envelope.schema_version).toBe("2");
    expect(envelope.command).toBe(`${site}.${cmd}`);
    expect(envelope.data).toBeNull();

    const error = envelope.error as Record<string, unknown>;
    expect(error.code).toBe("quarantined");
    expect(typeof error.message).toBe("string");
    expect((error.message as string).includes("quarantined")).toBe(true);
  });
});
