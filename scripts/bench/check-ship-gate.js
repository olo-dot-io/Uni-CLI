#!/usr/bin/env node
/**
 * Ship-gate enforcer for v0.213.3 Gagarin TC0 Patch R2.
 *
 * Reads bench/agent/results.json (schema bench-v3, multi-model) and fails
 * (exit 2) unless:
 *   - summary_overall.asr_sem_at_ics8_stdin_avg >= 0.95
 *   - summary_overall.sed_at_ics8_avg           >= 0.30
 *   - summary_overall.asr_sem_at_ics2_shell_avg >= 0.90
 *   - summary_overall.models_passing_gate       >= 2
 *   - total_trials matches the expected grid across all models (completeness)
 *   - No row across any model has a null/undefined asr_sem value
 *
 * Legacy bench-v2 (single-model summary) is still accepted so this script
 * can gate the older runner output without breaking.
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
  models_passing_gate: 2,
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
  const nModels = Array.isArray(r.models) ? r.models.length : 1;
  const expected =
    (r.tasks ?? 0) *
    (r.trials_per_cell ?? 0) *
    (r.buckets ?? 0) *
    (r.channels ?? 0) *
    nModels;
  const ok = expected > 0 && r.total_trials === expected;
  return {
    name: "completeness",
    ok,
    required: expected,
    actual: r.total_trials ?? 0,
    msg: ok
      ? `total_trials=${r.total_trials} (${nModels} models)`
      : `expected ${expected} trials, got ${r.total_trials}`,
  };
}

function collectRows(r) {
  if (Array.isArray(r.rows)) return r.rows;
  if (r.by_model && typeof r.by_model === "object") {
    const all = [];
    for (const entry of Object.values(r.by_model)) {
      if (entry && Array.isArray(entry.rows)) all.push(...entry.rows);
    }
    return all;
  }
  return [];
}

function checkNoNulls(r) {
  const rows = collectRows(r);
  if (rows.length === 0)
    return { name: "no_nulls", ok: false, msg: "no rows[] or by_model[].rows" };
  const channels = ["shell", "file", "stdin"];
  const offenders = [];
  for (const row of rows) {
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

function resolveSummary(r) {
  // bench-v3: summary_overall with avg-suffixed keys
  if (r.summary_overall) {
    const so = r.summary_overall;
    return {
      asr_sem_at_ics8_stdin:
        so.asr_sem_at_ics8_stdin_avg ?? so.asr_sem_at_ics8_stdin,
      sed_at_ics8: so.sed_at_ics8_avg ?? so.sed_at_ics8,
      asr_sem_at_ics2_shell:
        so.asr_sem_at_ics2_shell_avg ?? so.asr_sem_at_ics2_shell,
      models_passing_gate: so.models_passing_gate,
    };
  }
  // bench-v2: flat summary, no per-model gate
  const s = r.summary ?? {};
  return {
    asr_sem_at_ics8_stdin: s.asr_sem_at_ics8_stdin,
    sed_at_ics8: s.sed_at_ics8,
    asr_sem_at_ics2_shell: s.asr_sem_at_ics2_shell,
    models_passing_gate: 1, // legacy single-model result always counts as one
  };
}

function modelLabel(r) {
  if (Array.isArray(r.models) && r.models.length > 0)
    return r.models.join(", ");
  return r.model ?? "?";
}

function main() {
  const r = loadResults();
  const s = resolveSummary(r);
  const checks = [
    checkCompleteness(r),
    checkNoNulls(r),
    checkNumeric(
      "asr_sem@ICS=8 stdin (avg)",
      s.asr_sem_at_ics8_stdin,
      REQ.asr_sem_at_ics8_stdin,
    ),
    checkNumeric("sed@ICS=8 (avg)", s.sed_at_ics8, REQ.sed_at_ics8),
    checkNumeric(
      "asr_sem@ICS=2 shell (avg)",
      s.asr_sem_at_ics2_shell,
      REQ.asr_sem_at_ics2_shell,
    ),
    checkNumeric(
      "models_passing_gate",
      s.models_passing_gate,
      REQ.models_passing_gate,
    ),
  ];

  const schema = r.schema_version ?? "bench-v?";
  process.stdout.write(`\nShip-gate report (${schema}, ${modelLabel(r)})\n`);
  process.stdout.write(`file: ${RESULTS_PATH}\n`);
  process.stdout.write("-".repeat(60) + "\n");
  for (const c of checks) {
    const tag = c.ok ? "PASS" : "FAIL";
    process.stdout.write(`[${tag}] ${c.name.padEnd(28)} ${c.msg}\n`);
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
