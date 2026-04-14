/**
 * Phase 5 workflow adapter contracts.
 *
 * Covers the three YAML adapter sets shipped in v0.212 Shatalov Phase 5:
 *   - apple-notes (desktop-ax / AppleScript, 3 commands)
 *   - imessage    (subprocess / sqlite3, 3 commands)
 *   - linear      (http / GraphQL, 3 commands)
 *
 * Each suite verifies two things:
 *   1. Every YAML parses and carries the schema-v2 fields
 *      (capabilities, minimum_capability, trust, confidentiality,
 *      quarantine) so the Phase 1.7 migration has nothing to fill in.
 *   2. Every pipeline step name routes to a known step handler
 *      (registered in CAPABILITY_MATRIX or executed directly by the
 *      YAML runner — `exec`, `fetch`, etc.).
 *
 * These tests are offline/deterministic — no macOS, Linear API, or
 * `chat.db` required. They validate adapter shape only.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = join(__dirname, "..", "..", "src", "adapters");

interface Phase5Adapter {
  site: string;
  name: string;
  type?: string;
  strategy?: string;
  capabilities?: string[];
  minimum_capability?: string;
  trust?: string;
  confidentiality?: string;
  quarantine?: boolean;
  quarantineReason?: string;
  args?: Record<string, unknown>;
  pipeline: Array<Record<string, unknown>>;
  columns?: string[];
}

const SIBLING_KEYS = new Set([
  "fallback",
  "then",
  "else",
  "merge",
  "retry",
  "backoff",
  "continue_on_error",
  "label",
]);

function stepAction(step: Record<string, unknown>): string {
  for (const key of Object.keys(step)) {
    if (!SIBLING_KEYS.has(key)) return key;
  }
  return "";
}

function loadAdapter(rel: string): Phase5Adapter {
  const absPath = join(ADAPTERS_DIR, rel);
  const raw = readFileSync(absPath, "utf-8");
  return yaml.load(raw) as Phase5Adapter;
}

// Steps the YAML runner recognises directly (non-desktop-ax, non-browser).
// Kept small and local to this test; the full runtime registry lives in
// src/engine/yaml-runner.ts and src/commands/lint.ts.
const RUNNER_STEPS = new Set([
  "fetch",
  "fetch_text",
  "parse_rss",
  "html_to_md",
  "select",
  "map",
  "filter",
  "sort",
  "limit",
  "exec",
  "write_temp",
  "set",
  "if",
  "append",
  "each",
  "parallel",
  "rate_limit",
  "assert",
  "retry",
]);

// Desktop-AX steps that route through the capability bus.
const DESKTOP_AX_STEPS = new Set([
  "ax_focus",
  "ax_menu_select",
  "applescript",
  "clipboard_read",
  "clipboard_write",
  "launch_app",
  "focus_window",
]);

function assertSchemaV2(adapter: Phase5Adapter): void {
  expect(
    Array.isArray(adapter.capabilities),
    "capabilities must be an array",
  ).toBe(true);
  expect(adapter.capabilities?.length, "capabilities must be non-empty").toBeGreaterThan(
    0,
  );
  expect(typeof adapter.minimum_capability).toBe("string");
  expect((adapter.minimum_capability ?? "").length).toBeGreaterThan(0);
  expect(["public", "user", "system"]).toContain(adapter.trust);
  expect(["public", "internal", "private"]).toContain(adapter.confidentiality);
  expect(typeof adapter.quarantine).toBe("boolean");
}

// ── apple-notes ─────────────────────────────────────────────────────────

describe("apple-notes adapters (desktop-ax / AppleScript)", () => {
  const commands = [
    { rel: "apple-notes/list.yaml", cmd: "list" },
    { rel: "apple-notes/read.yaml", cmd: "read" },
    { rel: "apple-notes/search.yaml", cmd: "search" },
  ];

  for (const { rel, cmd } of commands) {
    describe(cmd, () => {
      const adapter = loadAdapter(rel);

      it("parses with site + name", () => {
        expect(adapter.site).toBe("apple-notes");
        expect(adapter.name).toBe(cmd);
      });

      it("carries every schema-v2 field", () => {
        assertSchemaV2(adapter);
        expect(adapter.capabilities).toContain("desktop-ax");
        expect(adapter.minimum_capability).toBe("desktop-ax.applescript");
        expect(adapter.trust).toBe("user");
        expect(adapter.confidentiality).toBe("private");
        expect(adapter.quarantine).toBe(false);
      });

      it("pipeline uses the applescript step", () => {
        const actions = adapter.pipeline.map(stepAction);
        expect(actions).toContain("applescript");
        for (const a of actions) {
          expect(
            DESKTOP_AX_STEPS.has(a) || RUNNER_STEPS.has(a),
            `unknown step "${a}" in ${rel}`,
          ).toBe(true);
        }
      });
    });
  }
});

// ── imessage ────────────────────────────────────────────────────────────

describe("imessage adapters (subprocess / sqlite3)", () => {
  const commands = [
    { rel: "imessage/recent.yaml", cmd: "recent" },
    { rel: "imessage/contact.yaml", cmd: "contact" },
    { rel: "imessage/search.yaml", cmd: "search" },
  ];

  for (const { rel, cmd } of commands) {
    describe(cmd, () => {
      const adapter = loadAdapter(rel);

      it("parses with site + name", () => {
        expect(adapter.site).toBe("imessage");
        expect(adapter.name).toBe(cmd);
      });

      it("carries every schema-v2 field", () => {
        assertSchemaV2(adapter);
        expect(adapter.capabilities).toContain("subprocess");
        expect(adapter.minimum_capability).toBe("subprocess.exec");
        expect(adapter.trust).toBe("user");
        expect(adapter.confidentiality).toBe("private");
        expect(adapter.quarantine).toBe(false);
      });

      it("pipeline uses the exec step with sqlite3", () => {
        const actions = adapter.pipeline.map(stepAction);
        expect(actions).toEqual(["exec"]);
        // Verify the exec step invokes sh -c wrapping sqlite3 (prevents
        // regressions where someone accidentally switches to a different
        // subprocess shape).
        const exec = adapter.pipeline[0].exec as Record<string, unknown>;
        expect(exec.command).toBe("sh");
        const script = Array.isArray(exec.args) ? (exec.args as string[]).join("") : "";
        expect(script).toContain("sqlite3");
        expect(script).toContain("chat.db");
      });

      it("gates on darwin via detect", () => {
        const a = adapter as unknown as { detect?: string };
        expect(a.detect).toMatch(/Darwin/);
      });

      it("forces integer on limit (injection guard)", () => {
        const exec = adapter.pipeline[0].exec as Record<string, unknown>;
        const script = Array.isArray(exec.args)
          ? (exec.args as string[]).join("")
          : "";
        expect(script).toContain("UNICLI_LIMIT");
        expect(script).toMatch(/\$\{UNICLI_LIMIT\/\/\[\^0-9\]\//);
      });
    });
  }

  it("contact and search escape single quotes in user input", () => {
    for (const rel of ["imessage/contact.yaml", "imessage/search.yaml"]) {
      const adapter = loadAdapter(rel);
      const exec = adapter.pipeline[0].exec as Record<string, unknown>;
      const script = Array.isArray(exec.args)
        ? (exec.args as string[]).join("")
        : "";
      // Bash parameter-expansion escape: ${VAR//\'/\'\'}
      expect(script, `${rel} missing SQL-quote escape`).toMatch(/\/\/\\'\/\\'\\'/);
    }
  });
});

// ── linear ──────────────────────────────────────────────────────────────

describe("linear adapters (http / GraphQL)", () => {
  const commands = [
    { rel: "linear/issue-list.yaml", cmd: "issue-list" },
    { rel: "linear/issue-create.yaml", cmd: "issue-create" },
    { rel: "linear/issue-update.yaml", cmd: "issue-update" },
  ];

  for (const { rel, cmd } of commands) {
    describe(cmd, () => {
      const adapter = loadAdapter(rel);

      it("parses with site + name", () => {
        expect(adapter.site).toBe("linear");
        expect(adapter.name).toBe(cmd);
      });

      it("carries every schema-v2 field", () => {
        assertSchemaV2(adapter);
        expect(adapter.capabilities).toContain("http");
        expect(adapter.minimum_capability).toBe("http.fetch");
        expect(adapter.trust).toBe("user");
        expect(adapter.confidentiality).toBe("internal");
        expect(adapter.quarantine).toBe(false);
      });

      it("pipeline hits Linear's GraphQL endpoint with API-key header", () => {
        const fetchSteps = adapter.pipeline.filter(
          (s) => stepAction(s) === "fetch",
        );
        expect(fetchSteps.length).toBeGreaterThan(0);
        for (const step of fetchSteps) {
          const f = step.fetch as Record<string, unknown>;
          expect(f.url).toBe("https://api.linear.app/graphql");
          expect(f.method).toBe("POST");
          const headers = (f.headers as Record<string, string>) ?? {};
          expect(headers.Authorization).toBe("${{ env.LINEAR_API_KEY }}");
        }
      });

      it("uses strategy: public to skip the cookie loader", () => {
        // strategy: header would trigger runPipeline's cookie-loader gate
        // and fail with "No cookies found for linear" before the fetch.
        expect(adapter.strategy).toBe("public");
      });
    });
  }
});
