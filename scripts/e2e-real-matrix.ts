/**
 * @owner   scripts/e2e-real-matrix.ts
 * @does    Run real CLI end-to-end workflows through dist/main.js and classify every catalog command by runnable posture.
 * @needs   dist/main.js, src/discovery/loader.ts, src/registry.ts, src/core/command-contract.ts
 * @feeds   npm run e2e:real, session handoffs, release confidence checks.
 * @breaks  Missing dist, unsafe command classification drift, or CLI envelope drift fail the real E2E matrix.
 * @invariants Only read-only or repo-local/temp-file workflows execute automatically; auth/write/browser gaps are reported, not faked.
 * @side-effects Creates and mutates files under .tmp/e2e-real-matrix; may read local macOS state on Darwin.
 * @perf    O(catalog commands) classification plus bounded real workflow subprocesses.
 * @concurrency Runs workflows sequentially to avoid racing local desktop state.
 * @test    npm run e2e:real
 * @stability operator-facing verification script.
 * @since   2026-06-01
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildCommandContract } from "../src/core/command-contract.js";
import { listCoreDiscoveryCommands } from "../src/discovery/core-catalog.js";
import { loadAllAdapters, loadTsAdapters } from "../src/discovery/loader.js";
import { getAllAdapters } from "../src/registry.js";
import type { AdapterArg, AdapterCommand } from "../src/types.js";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DIST_MAIN = join(ROOT, "dist", "main.js");
const WORK_ROOT = join(ROOT, ".tmp", "e2e-real-matrix", `${Date.now()}`);
const DEFAULT_TIMEOUT_MS = 30_000;

interface CliResult {
  status: number;
  signal: NodeJS.Signals | null;
  error: string | null;
  errorCode: string | null;
  timedOut: boolean;
  timeoutMs: number;
  stdout: string;
  stderr: string;
  json: unknown;
}

interface WorkflowCase {
  id: string;
  args: string[];
  timeoutMs?: number;
  runOn?: NodeJS.Platform | "all";
  prepare?: () => Promise<void>;
  expect: (result: CliResult) => void;
}

class WorkflowSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSkip";
  }
}

interface CatalogPosture {
  ref: string;
  posture:
    | "auto_runnable_read"
    | "auth_required"
    | "browser_required"
    | "core_command"
    | "platform_mismatch"
    | "quarantined"
    | "requires_input"
    | "write_or_destructive";
  reason: string;
}

function runCli(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): CliResult {
  const result = spawnSync(
    process.execPath,
    [DIST_MAIN, ...args, "-f", "json"],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: timeoutMs,
    },
  );
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const error = result.error as NodeJS.ErrnoException | undefined;
  return {
    status: result.status ?? -1,
    signal: result.signal ?? null,
    error: error?.message ?? null,
    errorCode: error?.code ?? null,
    timedOut: error?.code === "ETIMEDOUT",
    timeoutMs,
    stdout,
    stderr,
    json: parseJson(stdout) ?? parseJson(stderr),
  };
}

function parseJson(value: string): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${label} is not an object`);
}

function expectExitZero(result: CliResult): Record<string, unknown> {
  if (result.status !== 0) {
    throw new Error(describeCliFailure(result));
  }
  return asRecord(result.json, "json output");
}

function describeCliFailure(result: CliResult): string {
  const parts = [
    `exit ${result.status}`,
    result.signal ? `signal=${result.signal}` : undefined,
    result.timedOut ? `timed_out_after_ms=${result.timeoutMs}` : undefined,
    result.errorCode ? `error_code=${result.errorCode}` : undefined,
    result.error ? `error=${result.error}` : undefined,
    `stderr=${result.stderr.slice(0, 300)}`,
    result.stdout ? `stdout=${result.stdout.slice(0, 300)}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join("; ");
}

function expectEnvelopeOk(result: CliResult): Record<string, unknown> {
  const env = expectExitZero(result);
  if (env.ok !== true)
    throw new Error(`expected ok envelope: ${result.stdout}`);
  return env;
}

function dataArray(env: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(env.data)) {
    throw new Error("expected envelope data array");
  }
  return env.data.map((row) => asRecord(row, "data row"));
}

function firstData(env: Record<string, unknown>): Record<string, unknown> {
  const rows = dataArray(env);
  if (!rows[0]) throw new Error("expected at least one data row");
  return rows[0];
}

function expectTopCommand(
  result: CliResult,
  site: string,
  command: string,
): void {
  const env = expectEnvelopeOk(result);
  const first = firstData(env);
  const ref = commandRef(first);
  if (ref.site !== site || ref.command !== command) {
    throw new Error(
      `expected ${site}/${command}, got ${ref.site}/${ref.command}`,
    );
  }
}

function commandRef(row: Record<string, unknown>): {
  site: string | undefined;
  command: string | undefined;
} {
  if (typeof row.site === "string" && typeof row.command === "string") {
    return { site: row.site, command: row.command };
  }
  if (typeof row.command === "string") {
    const [site, ...rest] = row.command.split(/\s+/).filter(Boolean);
    return { site, command: rest.join(" ") || undefined };
  }
  return { site: undefined, command: undefined };
}

function argListHasRequiredInput(
  args: readonly AdapterArg[] | undefined,
): boolean {
  return (args ?? []).some(
    (arg) => arg.required === true && arg.default === undefined,
  );
}

function platformMismatch(command: AdapterCommand): string | undefined {
  const capability = command.minimum_capability;
  if (!capability) return undefined;
  if (capability.startsWith("desktop-ax.") && process.platform !== "darwin") {
    return `desktop-ax requires darwin (runner ${process.platform})`;
  }
  if (capability.startsWith("desktop-uia.") && process.platform !== "win32") {
    return `desktop-uia requires win32 (runner ${process.platform})`;
  }
  if (capability.startsWith("desktop-atspi.") && process.platform !== "linux") {
    return `desktop-atspi requires linux (runner ${process.platform})`;
  }
  return undefined;
}

function skipIfUpstreamUnavailable(result: CliResult, label: string): void {
  if (result.status === 0) return;
  const body = `${result.stdout}\n${result.stderr}`;
  if (/HTTP 429|rate_limited/i.test(body)) {
    throw new WorkflowSkip(`${label} rate limited`);
  }
  if (/HTTP 5\d\d|fetch failed|timed out/i.test(body)) {
    throw new WorkflowSkip(`${label} upstream/network unavailable`);
  }
}

async function buildCatalogPosture(): Promise<CatalogPosture[]> {
  loadAllAdapters();
  await loadTsAdapters();

  const rows: CatalogPosture[] = [];
  for (const adapter of getAllAdapters()) {
    for (const [commandName, command] of Object.entries(adapter.commands)) {
      const ref = `${adapter.name}.${commandName}`;
      const contract = buildCommandContract({ adapter, commandName, command });
      const mismatch = platformMismatch(command);
      if (command.quarantine) {
        rows.push({
          ref,
          posture: "quarantined",
          reason: command.quarantineReason ?? "command is quarantined",
        });
      } else if (mismatch) {
        rows.push({ ref, posture: "platform_mismatch", reason: mismatch });
      } else if (contract.auth.required) {
        rows.push({
          ref,
          posture: "auth_required",
          reason: contract.auth.setup_command ?? "authentication required",
        });
      } else if (contract.effect.browser) {
        rows.push({
          ref,
          posture: "browser_required",
          reason: "requires browser/CDP or UI substrate",
        });
      } else if (contract.effect.safety_class !== "read") {
        rows.push({
          ref,
          posture: "write_or_destructive",
          reason: contract.effect.operation_effect,
        });
      } else if (argListHasRequiredInput(command.adapterArgs)) {
        rows.push({
          ref,
          posture: "requires_input",
          reason: "required argument has no default",
        });
      } else {
        rows.push({
          ref,
          posture: "auto_runnable_read",
          reason: "read-only, public, non-browser, no required args",
        });
      }
    }
  }

  for (const command of listCoreDiscoveryCommands()) {
    rows.push({
      ref: `${command.site}.${command.command}`,
      posture: "core_command",
      reason: "covered by explicit workflow cases or unit/integration tests",
    });
  }
  return rows.sort((left, right) => left.ref.localeCompare(right.ref));
}

async function workflowCases(): Promise<WorkflowCase[]> {
  const source = join(WORK_ROOT, "source.txt");
  const copied = join(WORK_ROOT, "copied.txt");
  const moved = join(WORK_ROOT, "moved.txt");
  const folder = join(WORK_ROOT, "created-folder");
  const deliverySpec = join(WORK_ROOT, "delivery-system-info.json");
  const runRoot = join(WORK_ROOT, "runs");

  await mkdir(WORK_ROOT, { recursive: true });
  await writeFile(source, "unicli real e2e\n", "utf8");
  await writeFile(
    deliverySpec,
    JSON.stringify(
      {
        objective: {
          id: "real-e2e-system-info",
          goal: "Execute a read-only system-info command through delivery.run",
          evidence_gates: [
            { kind: "run_completed" },
            {
              kind: "required_evidence_type",
              evidence_type: "result-envelope",
            },
          ],
          attempt_budget: {
            max_attempts: 1,
            max_attempts_per_strategy: 1,
          },
        },
        strategies: [
          {
            id: "macos-system-info",
            kind: "adapter",
            label: "Read macOS system info",
            priority: 1,
            command: "macos.system-info",
            verify_command: "unicli macos system-info",
          },
        ],
        attempts: [],
        runs: [],
      },
      null,
      2,
    ),
    "utf8",
  );

  const cases: WorkflowCase[] = [
    {
      id: "catalog-list-spotify",
      args: ["list", "--site", "spotify"],
      expect(result) {
        const rows = dataArray(expectEnvelopeOk(result));
        if (!rows.some((row) => row.command === "play-track")) {
          throw new Error("spotify play-track missing from list output");
        }
      },
    },
    {
      id: "discovery-audio-cn",
      args: ["search", "我想听 I really wanna stay at your house"],
      expect: (result) => expectTopCommand(result, "spotify", "play-track"),
    },
    {
      id: "discovery-audio-spotify",
      args: ["search", "play I really wanna stay at your house spotify"],
      expect: (result) => expectTopCommand(result, "spotify", "play-track"),
    },
    {
      id: "discovery-travel-ctrip",
      args: ["search", "search Ctrip hotels for a weekend stay in Shanghai"],
      expect: (result) => expectTopCommand(result, "ctrip", "hotel-search"),
    },
    {
      id: "objective-do-audio",
      args: ["do", "我想听", "I really wanna stay at your house"],
      expect(result) {
        const env = expectEnvelopeOk(result);
        const data = asRecord(env.data, "do data");
        const plan = asRecord(data.objective_plan, "objective_plan");
        if (
          data.match !== null ||
          plan.schema_version !== "objective-plan.v1"
        ) {
          throw new Error(
            "audio objective did not compile to objective-plan.v1",
          );
        }
        const actions = env.next_actions as
          | Array<{ command?: string }>
          | undefined;
        if (
          actions?.[0]?.command !==
          "unicli delivery run <objective-delivery-spec.json>"
        ) {
          throw new Error(
            "objective next action did not lead with delivery.run",
          );
        }
      },
    },
    {
      id: "command-do-delivery-first",
      args: ["do", "spotify search music"],
      expect(result) {
        const env = expectEnvelopeOk(result);
        const actions = env.next_actions as
          | Array<{ command?: string }>
          | undefined;
        if (
          actions?.[0]?.command !== "unicli delivery run <delivery-spec.json>"
        ) {
          throw new Error("command plan did not lead with delivery.run");
        }
      },
    },
    {
      id: "describe-spotify-play-track-contract",
      args: ["describe", "spotify", "play-track"],
      expect(result) {
        const payload = expectExitZero(result);
        const schema = asRecord(payload.args_schema, "args_schema");
        if (
          !Array.isArray(schema.required) ||
          !schema.required.includes("query")
        ) {
          throw new Error("play-track contract does not require query");
        }
      },
    },
    {
      id: "public-web-hackernews",
      args: ["hackernews", "top", "--limit", "3"],
      timeoutMs: 35_000,
      expect(result) {
        skipIfUpstreamUnavailable(result, "hackernews");
        const env = expectEnvelopeOk(result);
        if (dataArray(env).length < 1) {
          throw new Error("hackernews top returned no rows");
        }
      },
    },
    {
      id: "public-web-arxiv",
      args: ["arxiv", "search", "agent", "--limit", "2"],
      timeoutMs: 35_000,
      expect: (result) => {
        skipIfUpstreamUnavailable(result, "arxiv");
        expectEnvelopeOk(result);
      },
    },
  ];

  if (process.platform === "darwin") {
    cases.push(
      ...[
        ["macos-active-app", ["macos", "active-app"]],
        ["macos-apps", ["macos", "apps"]],
        ["macos-apps-list", ["macos", "apps-list"]],
        ["macos-app-actions", ["macos", "app-actions"]],
        ["macos-battery", ["macos", "battery"]],
        ["macos-bluetooth", ["macos", "bluetooth"]],
        ["macos-brightness", ["macos", "brightness"]],
        ["macos-clipboard", ["macos", "clipboard"]],
        ["macos-dark-mode", ["macos", "dark-mode"]],
        ["macos-disk-info", ["macos", "disk-info"]],
        ["macos-disk-usage", ["macos", "disk-usage"]],
        ["macos-finder-recent", ["macos", "finder-recent"]],
        ["macos-finder-selection", ["macos", "finder-selection"]],
        ["macos-mail-status", ["macos", "mail-status"]],
        ["macos-music-now", ["macos", "music-now"]],
        ["macos-notes-list", ["macos", "notes-list"]],
        ["macos-processes", ["macos", "processes"]],
        ["macos-reminders-list", ["macos", "reminders-list"]],
        ["macos-safari-tabs", ["macos", "safari-tabs"]],
        ["macos-safari-url", ["macos", "safari-url"]],
        ["macos-shortcuts-list", ["macos", "shortcuts-list"]],
        ["macos-system-info", ["macos", "system-info"]],
        ["macos-trash", ["macos", "trash"]],
        ["macos-uptime", ["macos", "uptime"]],
        ["macos-volume", ["macos", "volume"]],
        ["macos-wallpaper", ["macos", "wallpaper"]],
        ["macos-wifi-info", ["macos", "wifi-info"]],
        ["macos-wifi-status", ["macos", "wifi", "status"]],
        [
          "macos-spotlight-repo",
          ["macos", "spotlight", "README", "--dir", ROOT],
        ],
        ["macos-finder-tags", ["macos", "finder-tags", source]],
        ["macos-finder-new-folder", ["macos", "finder-new-folder", folder]],
        ["macos-finder-copy", ["macos", "finder-copy", source, copied]],
        ["macos-finder-move", ["macos", "finder-move", copied, moved]],
        ["macos-caffeinate-short", ["macos", "caffeinate", "--duration", "1"]],
        [
          "delivery-run-readonly-macos",
          ["delivery", "run", deliverySpec, "--root", runRoot],
        ],
      ].map(([id, args]) => ({
        id: id as string,
        args: args as string[],
        runOn: "darwin" as const,
        timeoutMs: id === "macos-notes-list" ? 60_000 : DEFAULT_TIMEOUT_MS,
        expect(result: CliResult) {
          expectEnvelopeOk(result);
        },
      })),
    );
  }

  return cases;
}

function summarizePostures(
  rows: readonly CatalogPosture[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.posture] = (counts[row.posture] ?? 0) + 1;
  }
  return counts;
}

async function main(): Promise<void> {
  if (!existsSync(DIST_MAIN)) {
    throw new Error(`dist/main.js missing; run npm run build before e2e:real`);
  }

  const catalog = await buildCatalogPosture();
  const cases = await workflowCases();
  const results: Array<{
    id: string;
    status: "pass" | "fail" | "skip";
    detail?: string;
  }> = [];

  for (const testCase of cases) {
    if (
      testCase.runOn &&
      testCase.runOn !== "all" &&
      testCase.runOn !== process.platform
    ) {
      results.push({
        id: testCase.id,
        status: "skip",
        detail: `requires ${testCase.runOn}`,
      });
      continue;
    }
    try {
      if (testCase.prepare) await testCase.prepare();
      const result = runCli(testCase.args, testCase.timeoutMs);
      testCase.expect(result);
      results.push({ id: testCase.id, status: "pass" });
    } catch (err) {
      if (err instanceof WorkflowSkip) {
        results.push({
          id: testCase.id,
          status: "skip",
          detail: err.message,
        });
        continue;
      }
      results.push({
        id: testCase.id,
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const failed = results.filter((result) => result.status === "fail");
  const skipped = results.filter((result) => result.status === "skip");
  const summary = {
    schema_version: "e2e-real-matrix.v1",
    platform: process.platform,
    work_root: WORK_ROOT,
    catalog_total: catalog.length,
    catalog_posture_counts: summarizePostures(catalog),
    workflow_total: results.length,
    workflow_passed: results.filter((result) => result.status === "pass")
      .length,
    workflow_failed: failed.length,
    workflow_skipped: skipped.length,
    failed,
    skipped,
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(
    `e2e-real-matrix: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
