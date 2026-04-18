/**
 * Payload factory — generates benchmark payloads at controlled ICS levels
 * so the bench can sweep the TC0 complexity axis. Each generator emits a
 * JSON object (the "truth") and the three corresponding invocation
 * strings for the shell / file / stdin channels.
 */

import type { ICSBreakdown } from "./ics.js";
import { computeICS } from "./ics.js";

export type Channel = "shell" | "file" | "stdin";

export interface BenchPayload {
  /** Semantic args the command should receive. */
  args: Record<string, unknown>;
  /** The invocation string for each channel. */
  invocations: Record<Channel, string>;
  /** Target ICS bucket used to generate the payload. */
  target: "trivial" | "moderate" | "hostile" | "pathological";
  /** Actual ICS of the shell-channel invocation (source of truth). */
  ics: ICSBreakdown;
}

/** Shell-quote a string safely for a single-quoted bash context. */
function shellQuote(value: string): string {
  // Use single quotes and escape any embedded single quote via '\''
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Build the three invocation strings from a site/command/args triple. */
function buildInvocations(
  site: string,
  cmd: string,
  args: Record<string, unknown>,
  filePath: string = "/tmp/unicli-bench-args.json",
): Record<Channel, string> {
  const flagParts = Object.entries(args)
    .filter(([k]) => k !== "_positional")
    .map(([k, v]) => `--${k} ${shellQuote(String(v))}`);
  const positional = (args._positional as string[] | undefined) ?? [];
  const posParts = positional.map((p) => shellQuote(p));
  const shell =
    `unicli ${site} ${cmd} ${[...posParts, ...flagParts].join(" ")}`.trim();

  const file = `unicli ${site} ${cmd} --args-file ${filePath}`;

  const stdinPayload = JSON.stringify({
    ...Object.fromEntries(
      Object.entries(args).filter(([k]) => k !== "_positional"),
    ),
  });
  const stdin = `echo ${shellQuote(stdinPayload)} | unicli ${site} ${cmd}`;

  return { shell, file, stdin };
}

/** Generate a trivial payload — ICS ~ 1. */
export function genTrivial(site: string, cmd: string): BenchPayload {
  const args = { query: "hello world", limit: 10 };
  const invocations = buildInvocations(site, cmd, args);
  return {
    args,
    invocations,
    target: "trivial",
    ics: computeICS(invocations.shell),
  };
}

/** Generate a moderate payload — one level of quoting. */
export function genModerate(site: string, cmd: string): BenchPayload {
  const args = { query: "search for 'news' or 'tech'", limit: 10 };
  const invocations = buildInvocations(site, cmd, args);
  return {
    args,
    invocations,
    target: "moderate",
    ics: computeICS(invocations.shell),
  };
}

/** Hostile payload — mixed quotes, emoji, backticks. */
export function genHostile(site: string, cmd: string): BenchPayload {
  const args = {
    query: `she said "yes, 'exactly' — 🎉" ${"`cmd`"} $HOME`,
    limit: 10,
  };
  const invocations = buildInvocations(site, cmd, args);
  return {
    args,
    invocations,
    target: "hostile",
    ics: computeICS(invocations.shell),
  };
}

/** Pathological payload — nested JSON inline + 4-level quoting + emoji. */
export function genPathological(site: string, cmd: string): BenchPayload {
  const args = {
    query: 'outer "mid \'inner "deep `tick` $var" end\' close" and emoji 🎉🚀',
    filters: { nested: { level: { deep: 'value with "quotes"' } } },
    limit: 5,
  };
  const invocations = buildInvocations(site, cmd, args);
  return {
    args,
    invocations,
    target: "pathological",
    ics: computeICS(invocations.shell),
  };
}

/** Generate all four buckets for a given task. */
export function genAllBuckets(site: string, cmd: string): BenchPayload[] {
  return [
    genTrivial(site, cmd),
    genModerate(site, cmd),
    genHostile(site, cmd),
    genPathological(site, cmd),
  ];
}
