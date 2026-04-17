/**
 * quarantine-cli.test.ts — end-to-end CLI spawn test for the quarantine gate.
 *
 * The quarantine contract is already unit-tested at the `format()` layer
 * (tests/unit/quarantine.test.ts), but that test doesn't cover the full
 * subprocess → dispatch → envelope → stderr → process.exit chain. This
 * suite spawns `node dist/main.js <site>/<cmd> -f json` against a temp
 * quarantined YAML fixture and asserts:
 *
 *   - exit code === ExitCode.CONFIG_ERROR (78)
 *   - stderr contains a valid v2 error envelope (ok:false)
 *   - envelope.error.code === "quarantined"
 *   - envelope.error.suggestion mentions `unicli repair`
 *   - stdout is empty (envelope goes to stderr per dispatch.ts Scene-6 pattern)
 *
 * Depends on a pre-built `dist/main.js`. Skipped with a clear message when
 * dist/ is missing (the normal `verify` pipeline builds before testing).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { ExitCode } from "../../../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const DIST_MAIN = join(REPO_ROOT, "dist", "main.js");

const distReady = existsSync(DIST_MAIN);

describe("CLI quarantine dispatch (spawn)", () => {
  // Fake HOME — loader walks $HOME/.unicli/adapters/<site>/*.yaml at startup
  // (see src/discovery/loader.ts USER_DIR). Writing a fixture here lets a
  // spawned CLI register `qtestcli broken` without touching the real home dir.
  let fakeHome: string;

  beforeAll(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "unicli-quarantine-cli-"));
    const siteDir = join(fakeHome, ".unicli", "adapters", "qtestcli");
    mkdirSync(siteDir, { recursive: true });
    const yamlBody =
      [
        "site: qtestcli",
        "name: broken",
        "description: quarantined fixture for CLI spawn test",
        "type: web-api",
        "strategy: public",
        "quarantine: true",
        "quarantineReason: fixture — broken upstream",
        "pipeline:",
        "  - fetch:",
        "      url: https://example.invalid/nothing",
        'capabilities: ["http.fetch"]',
        "minimum_capability: http.fetch",
        "trust: public",
        "confidentiality: public",
      ].join("\n") + "\n";
    writeFileSync(join(siteDir, "broken.yaml"), yamlBody, "utf-8");
  });

  afterAll(() => {
    try {
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it.runIf(distReady)(
    "quarantined adapter exits 78 with v2 error envelope on stderr",
    () => {
      const result = spawnSync(
        "node",
        [DIST_MAIN, "qtestcli", "broken", "-f", "json"],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: fakeHome,
            UNICLI_NO_LEDGER: "1",
            // Defensive: never allow a stale UNICLI_FORCE_QUARANTINE=1 from
            // the parent environment to override the gate we're testing.
            UNICLI_FORCE_QUARANTINE: "",
          },
          timeout: 30_000,
        },
      );

      expect(result.status).toBe(ExitCode.CONFIG_ERROR);

      const stdout = typeof result.stdout === "string" ? result.stdout : "";
      const stderr = typeof result.stderr === "string" ? result.stderr : "";

      // Envelope lands on stderr (dispatch.ts Scene-6 pattern).
      expect(stdout.trim()).toBe("");
      expect(stderr.length).toBeGreaterThan(0);

      const envelope = JSON.parse(stderr) as {
        ok: boolean;
        schema_version: string;
        command: string;
        data: unknown;
        error: {
          code: string;
          message: string;
          suggestion?: string;
          adapter_path?: string;
        };
      };

      expect(envelope.ok).toBe(false);
      expect(envelope.schema_version).toBe("2");
      expect(envelope.command).toBe("qtestcli.broken");
      expect(envelope.data).toBeNull();
      expect(envelope.error.code).toBe("quarantined");
      expect(envelope.error.message).toMatch(/quarantined/);
      expect(envelope.error.suggestion ?? "").toMatch(/unicli repair/);
      expect(envelope.error.adapter_path ?? "").toMatch(
        /src\/adapters\/qtestcli\/broken\.yaml/,
      );
    },
    30_000,
  );

  it.runIf(distReady)(
    "UNICLI_FORCE_QUARANTINE=1 bypasses the gate (reaches pipeline)",
    () => {
      // When bypass is on, the quarantine short-circuit is skipped and the
      // pipeline runs. The fetch to `example.invalid` fails with a network
      // error — the envelope.error.code should NOT be "quarantined" anymore.
      const result = spawnSync(
        "node",
        [DIST_MAIN, "qtestcli", "broken", "-f", "json"],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: fakeHome,
            UNICLI_NO_LEDGER: "1",
            UNICLI_FORCE_QUARANTINE: "1",
          },
          timeout: 30_000,
        },
      );

      // Exit must be non-zero (pipeline failed) but NOT the quarantine code
      // path. Either GENERIC_ERROR/TEMP_FAILURE/SERVICE_UNAVAILABLE depending
      // on how the network error classifies.
      expect(result.status).not.toBe(0);

      const stderr = typeof result.stderr === "string" ? result.stderr : "";
      // The envelope will still parse — we just want to confirm the
      // quarantine short-circuit did not fire.
      if (stderr.trim().startsWith("{")) {
        const env = JSON.parse(stderr) as { error?: { code?: string } };
        expect(env.error?.code).not.toBe("quarantined");
      }
    },
    30_000,
  );
});
