#!/usr/bin/env node
/**
 * Ship-gate enforcer for v0.213.3 Gagarin TC0 Patch R2.
 *
 * Reads bench/agent/results.json and fails (exit 2) unless:
 *   - summary.asr_sem_at_ics8_stdin >= 0.95
 *   - summary.sed_at_ics8           >= 0.30
 *   - summary.asr_sem_at_ics2_shell >= 0.90
 *   - total_trials == tasks * trials_per_cell * 4 * 3 (completeness)
 *   - No row has a null/undefined asr_sem value
 *
 * Exit codes:
 *   0 — all gates pass
 *   2 — one or more gates failed (includes "expected numbers, got nulls")
 *   78 — usage / missing file
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const RESULTS_PATH =
  process.argv[2] ?? resolve(process.cwd(), "bench/agent/results.json");

const REQ = Object.freeze({
  asr_sem_at_ics8_stdin: 0.95,
  sed_at_ics8: 0.3,
  asr_sem_at_ics2_shell: 0.9,
});

function loadResults() {
  if (!existsSync(RESULTS_PATH)) {
    process.stderr.write(
      `[ship-gate] ${RESULTS_PATH} not found — run \`npm run bench:agent\` first\n`,
    );
    process.exit(78);
  }
  try {
    return JSON.parse(readFileSync(RESULTS_PATH, "utf8"));
  } catch (err) {
    process.stderr.write(
      `[ship-gate] failed to parse ${RESULTS_PATH}: ${err.message}\n`,
    );
    process.exit(78);
  }
}

function checkCompleteness(r) {
  const expected =
    (r.tasks ?? 0) *
    (r.trials_per_cell ?? 0) *
    (r.buckets ?? 0) *
    (r.channels ?? 0);
  const ok = expected > 0 && r.total_trials === expected;
  return {
    name: "completeness",
    ok,
    required: expected,
    actual: r.total_trials ?? 0,
    msg: ok
      ? `total_trials=${r.total_trials}`
      : `expected ${expected} trials, got ${r.total_trials}`,
  };
}

function checkNoNulls(r) {
  if (!Array.isArray(r.rows))
    return { name: "no_nulls", ok: false, msg: "no rows[]" };
  const channels = ["shell", "file", "stdin"];
  const offenders = [];
  for (const row of r.rows) {
    for (const ch of channels) {
      const v = row?.asr_sem?.[ch];
      if (v === null || v === undefined) {
        offenders.push(`${row.site}/${row.cmd}/${row.bucket}/${ch}`);
      }
    }
  }
  return {
    name: "no_nulls",
    ok: offenders.length === 0,
    required: 0,
    actual: offenders.length,
    msg:
      offenders.length === 0
        ? "all asr_sem values populated"
        : `${offenders.length} null cells: ${offenders.slice(0, 5).join(", ")}${offenders.length > 5 ? "..." : ""}`,
  };
}

function checkNumeric(name, actualVal, required) {
  const actual = typeof actualVal === "number" ? actualVal : NaN;
  const ok = Number.isFinite(actual) && actual >= required;
  return {
    name,
    ok,
    required,
    actual: Number.isFinite(actual) ? actual : null,
    msg: `actual=${Number.isFinite(actual) ? actual.toFixed(3) : "null"}  required≥${required}`,
  };
}

function main() {
  const r = loadResults();
  const s = r.summary ?? {};
  const checks = [
    checkCompleteness(r),
    checkNoNulls(r),
    checkNumeric(
      "asr_sem@ICS=8 stdin",
      s.asr_sem_at_ics8_stdin,
      REQ.asr_sem_at_ics8_stdin,
    ),
    checkNumeric("sed@ICS=8", s.sed_at_ics8, REQ.sed_at_ics8),
    checkNumeric(
      "asr_sem@ICS=2 shell",
      s.asr_sem_at_ics2_shell,
      REQ.asr_sem_at_ics2_shell,
    ),
  ];

  process.stdout.write(`\nShip-gate report (bench-v2, ${r.model ?? "?"})\n`);
  process.stdout.write(`file: ${RESULTS_PATH}\n`);
  process.stdout.write("-".repeat(60) + "\n");
  for (const c of checks) {
    const tag = c.ok ? "PASS" : "FAIL";
    process.stdout.write(`[${tag}] ${c.name.padEnd(24)} ${c.msg}\n`);
  }
  process.stdout.write("-".repeat(60) + "\n");

  const allPass = checks.every((c) => c.ok);
  if (!allPass) {
    process.stdout.write("\nSHIP-GATE FAILED — do not release.\n");
    process.exit(2);
  }
  process.stdout.write("\nSHIP-GATE PASSED — cleared to release.\n");
}

main();
