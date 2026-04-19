/**
 * Emission-layer judges for the Claude Agent SDK bench.
 *
 * - judgeAsrGen: parse the Bash tool's `command` input to decide if the
 *   agent's emission was syntactically well-formed.
 * - judgeAsrExec: spawn the emitted command (30s timeout) and return exit
 *   status + stdout/stderr so asr_exec is decided by real behavior.
 * - judgeAsrSem: cross-check the agent's final text report against the
 *   actual stdout JSON so the "agent understood the result" claim is
 *   verified, not trusted.
 */

import { spawn } from "node:child_process";
import { parse as shellParse } from "shell-quote";

import type { Channel } from "./payload-factory.js";

export interface Emission {
  tool: string;
  input: Record<string, unknown>;
}

export interface GenVerdict {
  ok: boolean;
  command?: string;
}

export function judgeAsrGen(
  emissions: Emission[],
  channel: Channel,
): GenVerdict {
  const bash = emissions.find(
    (e) => e.tool === "Bash" && typeof e.input.command === "string",
  );
  if (!bash) return { ok: false };
  const command = bash.input.command as string;

  if (channel === "shell") {
    try {
      const tokens = shellParse(command);
      if (tokens.length === 0) return { ok: false, command };
      return { ok: true, command };
    } catch {
      return { ok: false, command };
    }
  }
  return judgeGenJsonChannel(command);
}

function judgeGenJsonChannel(command: string): GenVerdict {
  const heredoc =
    command.match(/<<'?JSON'?\s*([\s\S]*?)^\s*JSON/m) ??
    command.match(/>\s*\S+\.json\s*<<'?\w+'?\s*([\s\S]*?)^\s*\w+/m);
  const echo =
    command.match(/echo\s+'(\{[\s\S]*?\})'/) ??
    command.match(/echo\s+"(\{[\s\S]*?\})"/);
  const candidate = heredoc?.[1] ?? echo?.[1];
  if (candidate) {
    try {
      JSON.parse(candidate.trim());
      return { ok: true, command };
    } catch {
      return { ok: false, command };
    }
  }
  const loose = command.match(/\{[^{}]*\}/);
  if (!loose) return { ok: false, command };
  try {
    JSON.parse(loose[0]);
    return { ok: true, command };
  } catch {
    return { ok: false, command };
  }
}

export interface ExecVerdict {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export async function judgeAsrExec(command: string): Promise<ExecVerdict> {
  return new Promise((resolvePromise) => {
    const child = spawn("sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (err += String(d)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, stdout: out, stderr: err });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ ok: false, stdout: out, stderr: err });
    });
  });
}

export interface SemExpectation {
  minResults: number;
  keyFields: string[];
}

function parseRows(execStdout: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(execStdout);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      for (const key of ["data", "rows", "items", "results"]) {
        const v = obj[key];
        if (Array.isArray(v)) return v;
      }
    }
  } catch {
    // non-JSON stdout
  }
  return [];
}

function claimsMinN(text: string, minResults: number): boolean {
  const m =
    text.match(/found\s+(\d+)\s+result/i) ??
    text.match(/(\d+)\s+(?:items|rows|results|entries)/i);
  const n = m ? parseInt(m[1], 10) : NaN;
  return Number.isFinite(n) && n >= minResults;
}

function matchesRealContent(
  text: string,
  rows: unknown[],
  keyFields: string[],
): boolean {
  if (rows.length === 0) return false;
  const first = rows[0] as Record<string, unknown>;
  for (const k of keyFields) {
    const v = first[k];
    if (typeof v === "string" && v.length >= 8) {
      const excerpt = v.slice(0, 40).replace(/["']/g, "");
      if (text.includes(excerpt.slice(0, 8))) return true;
    }
  }
  // Real content exists but the agent's text doesn't quote any of it —
  // we assume hallucination rather than trusting the agent's claim.
  return false;
}

export function judgeAsrSem(
  finalResult: string | undefined,
  execStdout: string,
  expected: SemExpectation,
): boolean {
  if (!finalResult) return false;
  if (!claimsMinN(finalResult, expected.minResults)) return false;
  const rows = parseRows(execStdout);
  if (rows.length > 0) {
    return matchesRealContent(finalResult, rows, expected.keyFields);
  }
  return expected.keyFields.some((k) =>
    new RegExp(`\\b${k}\\b`, "i").test(finalResult),
  );
}
