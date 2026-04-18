/**
 * ACP pure helpers — prompt parsing, tokenization, suggestion, command
 * execution. Extracted from `acp.ts` so the server module stays under the
 * complexity gate.
 */

import { getAllAdapters } from "../registry.js";
import { buildInvocation, execute } from "../engine/kernel/execute.js";
import { coerceLimit } from "../engine/args.js";
import type { AdapterManifest, AdapterCommand } from "../types.js";

export interface ParsedInvocation {
  site: string;
  command: string;
  args: Record<string, unknown>;
}

/**
 * Upper bound on prompt length that `parseUnicliInvocation` will scan. ACP
 * clients can send arbitrarily long editor contexts; regex scans over
 * multi-megabyte prompts are pointless (invocations live near the top) and
 * a ReDoS hazard when the tail regex `.*$` engages on a pathological input.
 * 64 KiB is ~32 pages of text, enough for any realistic prompt, and trims
 * the worst case to a bounded one-pass scan.
 */
const MAX_ACP_PROMPT_BYTES = 64 * 1024;

function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes: '"' | "'" | undefined;
  for (const ch of s) {
    if (inQuotes) {
      if (ch === inQuotes) inQuotes = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuotes = ch as '"' | "'";
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function coerce(v: string): unknown {
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}

/**
 * Parse a natural-language prompt for a `unicli <site> <command> [args]`
 * invocation. Matches the literal `unicli` token followed by two identifiers,
 * then consumes remaining key=value or --flag value tokens plus a single
 * trailing positional. Returns `undefined` when no invocation is detected.
 */
export function parseUnicliInvocation(
  prompt: string,
): ParsedInvocation | undefined {
  const bounded =
    prompt.length > MAX_ACP_PROMPT_BYTES
      ? prompt.slice(0, MAX_ACP_PROMPT_BYTES)
      : prompt;
  const match = bounded.match(
    /\bunicli\s+([a-zA-Z0-9_.-]+)\s+([a-zA-Z0-9_.-]+)(.*)$/m,
  );
  if (!match) return undefined;
  const [, site, command, tail] = match;

  const args: Record<string, unknown> = {};
  const tokens = tokenize(tail ?? "");
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = coerce(next);
        i++;
      } else {
        args[key] = true;
      }
      continue;
    }
    if (tok.includes("=") && /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(tok)) {
      const eq = tok.indexOf("=");
      args[tok.slice(0, eq)] = coerce(tok.slice(eq + 1));
      continue;
    }
    positional.push(tok);
  }

  if (positional.length > 0 && args.query === undefined) {
    args.query = positional.join(" ");
  }

  return { site, command, args };
}

/**
 * Execute a resolved adapter command with its merged args through the
 * invocation kernel (v0.213.3 R2). Returns the raw result array. Throws
 * on error — callers wrap in try/catch and surface the message over ACP.
 */
export async function runCommand(
  adapter: AdapterManifest,
  cmd: AdapterCommand,
  args: Record<string, unknown>,
): Promise<unknown[]> {
  // Only inject the default `limit` when the adapter declares it —
  // ajv strict mode would otherwise reject the undeclared property.
  const declaresLimit = (cmd.adapterArgs ?? []).some((a) => a.name === "limit");
  const mergedArgs: Record<string, unknown> = declaresLimit
    ? { limit: 20, ...args }
    : { ...args };
  if (declaresLimit && args.limit !== undefined) {
    const coerced = coerceLimit(args.limit);
    if (coerced !== undefined) mergedArgs.limit = coerced;
  }
  const inv = buildInvocation("acp", adapter.name, cmd.name, {
    args: mergedArgs,
    source: "acp",
  });
  if (!inv) throw new Error(`Unknown command: ${adapter.name} ${cmd.name}`);
  const result = await execute(inv);
  if (result.error) {
    const err = new Error(result.error.message);
    (err as Error & { suggestion?: string }).suggestion =
      result.error.suggestion;
    throw err;
  }
  return result.results;
}

export function summarizeResults(
  results: unknown[],
  site: string,
  command: string,
): string {
  if (!Array.isArray(results) || results.length === 0) {
    return `unicli ${site} ${command}: no results`;
  }
  const preview = results.slice(0, 5);
  return [
    `unicli ${site} ${command}: ${results.length} result(s)`,
    "",
    "```json",
    JSON.stringify(preview, null, 2),
    "```",
    results.length > preview.length
      ? `…${results.length - preview.length} more`
      : "",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

/**
 * Suggest at most five candidate commands based on a prompt. Lightweight
 * substring match over the adapter catalog — good enough for "did you
 * mean?" hints without pulling in the full BM25 search machinery.
 */
export function suggestCommands(prompt: string): string {
  const lower = prompt.toLowerCase();
  const candidates: string[] = [];
  for (const adapter of getAllAdapters()) {
    for (const cmd of Object.keys(adapter.commands)) {
      const hay =
        `${adapter.name} ${cmd} ${adapter.commands[cmd].description ?? ""}`.toLowerCase();
      if (lower.split(/\s+/).some((w) => w.length >= 3 && hay.includes(w))) {
        candidates.push(`- unicli ${adapter.name} ${cmd}`);
        if (candidates.length >= 5) break;
      }
    }
    if (candidates.length >= 5) break;
  }
  return candidates.length > 0
    ? candidates.join("\n")
    : "- unicli list      (see all available commands)";
}
