/**
 * @owner       src::engine::repair::verifier
 * @does        Re-runs one adapter command as a bounded subprocess and checks envelope/exit-code agreement.
 * @needs       node child_process/crypto, AgentEnvelope validator, repair plan
 * @feeds       src/commands/repair.ts
 * @breaks      Launch, timeout, malformed-envelope, and truth-mismatch states are explicit verification errors.
 * @invariants  Execution never uses a shell; success requires target envelope.ok=true and process exit 0.
 * @side-effects Starts one child process and reads bounded stdout/stderr.
 * @perf        One target invocation, 4 MiB output cap, caller-bounded timeout.
 * @concurrency Stateless; each call owns its subprocess.
 * @test        tests/unit/repair.test.ts, tests/integration/repair-truth.test.ts
 * @stability   stable
 * @since       2026-07-12
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { AgentEnvelope } from "../../output/envelope.js";
import { validateEnvelope } from "../../output/envelope.js";
import type { RepairPlan } from "./plan.js";

const OUTPUT_LIMIT = 4 * 1024 * 1024;

export interface RepairCliLaunch {
  executable: string;
  prefixArgs: string[];
}

export type RepairVerification =
  | {
      status: "passed";
      exitCode: 0;
      envelope: AgentEnvelope & { ok: true };
      evidenceSha256: string;
    }
  | {
      status: "failed";
      exitCode: number;
      envelope: AgentEnvelope & { ok: false };
      evidenceSha256: string;
    }
  | {
      status: "error";
      exitCode: number;
      code: "timeout" | "launch_error" | "invalid_envelope" | "truth_mismatch";
      message: string;
      outputPreview?: string;
    };

function defaultLaunch(): RepairCliLaunch {
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("Cannot locate the current Uni-CLI entry point");
  }
  return {
    executable: process.execPath,
    prefixArgs: [...process.execArgv, entry],
  };
}

function jsonObjects(text: string): unknown[] {
  const values: unknown[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"' && depth > 0) {
      quoted = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character !== "}" || depth === 0) continue;
    depth -= 1;
    if (depth !== 0 || start < 0) continue;
    const parsed = parseJsonCandidate(text.slice(start, index + 1));
    if (parsed !== undefined) values.push(parsed);
    start = -1;
  }
  return values;
}

function parseJsonCandidate(candidate: string): unknown | undefined {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function validatedEnvelope(candidate: unknown): AgentEnvelope | undefined {
  try {
    validateEnvelope(candidate as AgentEnvelope);
    return candidate as AgentEnvelope;
  } catch {
    return undefined;
  }
}

function findEnvelope(
  stdout: string,
  stderr: string,
  expectedCommand: string,
): AgentEnvelope | undefined {
  const candidates = [...jsonObjects(stdout), ...jsonObjects(stderr)];
  for (const candidate of candidates.reverse()) {
    const envelope = validatedEnvelope(candidate);
    if (envelope?.command === expectedCommand) return envelope;
  }
  return undefined;
}

function preview(stdout: string, stderr: string): string | undefined {
  const text = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  return text ? text.slice(0, 500) : undefined;
}

export function verifyRepairPlan(
  plan: RepairPlan,
  launch?: RepairCliLaunch,
): RepairVerification {
  let resolvedLaunch: RepairCliLaunch;
  try {
    resolvedLaunch = launch ?? defaultLaunch();
  } catch (error) {
    return {
      status: "error",
      exitCode: 78,
      code: "launch_error",
      message: `Verification process failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const targetArgs = plan.oracle.argv.slice(1);
  let result;
  try {
    result = spawnSync(
      resolvedLaunch.executable,
      [...resolvedLaunch.prefixArgs, ...targetArgs],
      {
        encoding: "utf-8",
        timeout: plan.oracle.timeout_ms,
        killSignal: "SIGTERM",
        maxBuffer: OUTPUT_LIMIT,
        env: {
          ...process.env,
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          UNICLI_REPAIR_CHILD: "1",
          UNICLI_FORCE_QUARANTINE: "1",
          UNICLI_SKIP_UPDATE_CHECK: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    return {
      status: "error",
      exitCode: 78,
      code: "launch_error",
      message: `Verification process failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      return {
        status: "error",
        exitCode: 75,
        code: "timeout",
        message: `Verification timed out after ${plan.oracle.timeout_ms} ms`,
        outputPreview: preview(stdout, stderr),
      };
    }
    return {
      status: "error",
      exitCode: 78,
      code: "launch_error",
      message: `Verification process failed: ${result.error.message}`,
      outputPreview: preview(stdout, stderr),
    };
  }

  const expectedCommand = `${plan.target.site}.${plan.target.command}`;
  const envelope = findEnvelope(stdout, stderr, expectedCommand);
  const exitCode = result.status;
  if (!envelope || exitCode === null) {
    return {
      status: "error",
      exitCode: 78,
      code: "invalid_envelope",
      message: `Verification did not return a valid ${expectedCommand} v2 envelope`,
      outputPreview: preview(stdout, stderr),
    };
  }

  if ((envelope.ok && exitCode !== 0) || (!envelope.ok && exitCode === 0)) {
    return {
      status: "error",
      exitCode: 78,
      code: "truth_mismatch",
      message: `Target envelope.ok=${envelope.ok} contradicts process exit ${exitCode}`,
      outputPreview: preview(stdout, stderr),
    };
  }
  if (
    !envelope.ok &&
    envelope.error.exit_code !== undefined &&
    envelope.error.exit_code !== exitCode
  ) {
    return {
      status: "error",
      exitCode: 78,
      code: "truth_mismatch",
      message: `Target error.exit_code=${envelope.error.exit_code} contradicts process exit ${exitCode}`,
      outputPreview: preview(stdout, stderr),
    };
  }

  const evidenceSha256 = createHash("sha256")
    .update(JSON.stringify(envelope))
    .digest("hex");
  return envelope.ok
    ? {
        status: "passed",
        exitCode: 0,
        envelope,
        evidenceSha256,
      }
    : {
        status: "failed",
        exitCode,
        envelope,
        evidenceSha256,
      };
}
