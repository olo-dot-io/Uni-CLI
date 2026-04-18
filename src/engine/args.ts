/**
 * Agent-native ArgBag resolver — externalizes argument state out of shell
 * quoting (a TC0-bounded mod-2 matching problem that Transformers struggle
 * to generate correctly) into JSON channels (stdin / file) where state is
 * carried by byte structure and needs no nested escape tracking.
 *
 * Precedence (highest wins when the same key appears in multiple sources):
 *   stdin-JSON  >  --args-file  >  shell flags  >  positional args  >  defaults
 *
 * Stdin auto-detect: when stdout is non-TTY AND the first byte of stdin is
 * `{` or `[`, the stream is consumed and JSON-parsed. A trailing `-`
 * positional also triggers stdin consumption explicitly.
 *
 * See `.claude/plans/sessions/2026-04-18-v213.2-tc0/task_plan.md` §2 for
 * the quantitative hypothesis this module tests.
 */

import {
  readFileSync,
  readSync,
  openSync,
  closeSync,
  constants,
} from "node:fs";
import type { AdapterArg } from "../types.js";

export type ArgSource = "shell" | "file" | "stdin" | "mixed" | "mcp" | "acp";

export interface ResolvedArgs {
  args: Record<string, unknown>;
  source: ArgSource;
  /** Raw stdin body, retained for debugging when `--dry-run` prints the plan. */
  stdinRaw?: string;
}

export interface ResolveOptions {
  /** Commander option bag (flag values). */
  opts: Record<string, unknown>;
  /** Positional CLI args in declaration order. */
  positionals: string[];
  /** Adapter's declared arg schema — used for naming, types, defaults. */
  schema: AdapterArg[];
  /** Explicit path from `--args-file`. */
  argsFile?: string;
  /** Stdin body, if caller has already read it. Undefined means read lazily. */
  stdinBody?: string;
  /** Override stdin TTY detection (for tests). */
  stdinIsTTY?: boolean;
}

/**
 * Synchronously read all of stdin when data is available. Returns
 * undefined when:
 *   - stdin is an interactive TTY, OR
 *   - stdin is an open-empty pipe (no data and not closed), OR
 *   - stdin is /dev/null, OR
 *   - any read error.
 *
 * Uses `/dev/stdin` with O_NONBLOCK on POSIX so empty pipes fail fast
 * with EAGAIN rather than blocking forever (critical for subprocess
 * tests that spawn unicli with no stdin input). Windows (no /dev/stdin)
 * falls through to the blocking path — agents on Windows should pass
 * `-` explicitly to opt into reading stdin.
 */
export function readStdinSync(
  stdinIsTTY: boolean = process.stdin.isTTY === true,
): string | undefined {
  if (stdinIsTTY) return undefined;

  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);

  // Try the non-blocking POSIX path first.
  let nbFd: number | undefined;
  try {
    nbFd = openSync(
      "/dev/stdin",
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    nbFd = undefined;
  }

  if (nbFd !== undefined) {
    try {
      let keep = true;
      while (keep) {
        let read = 0;
        try {
          read = readSync(nbFd, buf, 0, buf.length, null);
        } catch (err) {
          // EAGAIN / EWOULDBLOCK — no data available right now.
          const code = (err as NodeJS.ErrnoException).code ?? "";
          if (code === "EAGAIN" || code === "EWOULDBLOCK") {
            keep = false;
            break;
          }
          keep = false;
          break;
        }
        if (read <= 0) {
          keep = false;
          break;
        }
        chunks.push(Buffer.from(buf.subarray(0, read)));
      }
    } finally {
      try {
        closeSync(nbFd);
      } catch {
        /* ignore */
      }
    }
    const body = Buffer.concat(chunks).toString("utf-8").trim();
    return body.length > 0 ? body : undefined;
  }

  // Fallback: blocking path (may hang on open-empty pipes — only reachable
  // when /dev/stdin is unavailable, e.g. Windows).
  let reading = true;
  while (reading) {
    let read = 0;
    try {
      read = readSync(0, buf, 0, buf.length, null);
    } catch {
      reading = false;
      break;
    }
    if (read <= 0) {
      reading = false;
      break;
    }
    chunks.push(Buffer.from(buf.subarray(0, read)));
  }
  const body = Buffer.concat(chunks).toString("utf-8").trim();
  return body.length > 0 ? body : undefined;
}

/**
 * Parse a JSON document from `body` that must be a plain object (`{…}`).
 * Throws on array / scalar / parse error so callers get a clean usage error.
 */
function parseJsonObject(
  body: string,
  origin: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid JSON from ${origin}: ${msg}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${origin} must be a JSON object (received ${Array.isArray(parsed) ? "array" : typeof parsed})`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Read and parse an --args-file. Path is read synchronously. JSON only —
 * YAML/TOML are deliberately excluded (D2: minimize format ambiguity).
 */
export function readArgsFile(path: string): Record<string, unknown> {
  let body: string;
  try {
    body = readFileSync(path, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read --args-file ${path}: ${msg}`);
  }
  return parseJsonObject(body, `--args-file ${path}`);
}

/**
 * Coerce a shell-provided string into the type declared on the adapter arg.
 * Mirrors the inline coercion previously buried in dispatch.ts so every
 * resolver path goes through the same rules.
 */
function coerce(value: string, type: AdapterArg["type"]): unknown {
  switch (type) {
    case "int":
      return Number.parseInt(value, 10);
    case "float":
      return Number.parseFloat(value);
    case "bool":
      return value === "true" || value === "1" || value === "yes";
    default:
      return value;
  }
}

/**
 * Merge shell-derived args (opts + positionals) into an ArgBag using the
 * adapter schema for naming, coercion, and defaults.
 */
function mergeShellArgs(
  opts: Record<string, unknown>,
  positionals: string[],
  schema: AdapterArg[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  let posIdx = 0;
  for (const arg of schema) {
    if (arg.positional) {
      if (posIdx < positionals.length) {
        out[arg.name] = coerce(positionals[posIdx++], arg.type);
      } else if (arg.default !== undefined) {
        out[arg.name] = arg.default;
      }
    }
  }

  for (const arg of schema) {
    if (arg.positional) continue;
    const raw = opts[arg.name];
    if (raw !== undefined && raw !== null) {
      out[arg.name] = typeof raw === "string" ? coerce(raw, arg.type) : raw;
    } else if (arg.default !== undefined) {
      out[arg.name] = arg.default;
    }
  }

  // Pass through `limit` and any non-schema opts so existing adapters keep
  // working while the schema evolves.
  for (const key of Object.keys(opts)) {
    if (out[key] === undefined && opts[key] !== undefined) {
      out[key] = opts[key];
    }
  }

  return out;
}

/**
 * The single entry point for argument resolution. Callers (currently
 * dispatch.ts; soon every command surface) hand over the Commander-parsed
 * state and receive a typed ArgBag with its provenance recorded.
 *
 * Precedence when the same key appears in multiple sources:
 *   stdin > args-file > shell flags > positional args > defaults
 *
 * Keys present in JSON sources but NOT in the adapter schema are passed
 * through — YAML adapters frequently reference `${{ args.foo }}` for
 * fields that are declared only via defaulting inside templates.
 */
export function resolveArgs(options: ResolveOptions): ResolvedArgs {
  const { opts, positionals, schema, argsFile, stdinBody, stdinIsTTY } =
    options;

  const sources: ArgSource[] = [];
  const hasShellInput = positionals.length > 0 || Object.keys(opts).length > 0;
  let merged = mergeShellArgs(opts, positionals, schema);
  if (hasShellInput) sources.push("shell");

  if (argsFile) {
    const fromFile = readArgsFile(argsFile);
    merged = { ...merged, ...fromFile };
    sources.push("file");
  }

  // Stdin — either already provided by caller or auto-detected.
  const explicitStdin = positionals.includes("-");
  let stdinRaw: string | undefined = stdinBody;
  if (stdinRaw === undefined) {
    stdinRaw = readStdinSync(stdinIsTTY);
  }
  const trimmed = (stdinRaw ?? "").trim();
  if (trimmed.length > 0) {
    const looksJson =
      trimmed.startsWith("{") || (explicitStdin && trimmed.startsWith("["));
    if (looksJson) {
      const fromStdin = parseJsonObject(trimmed, "stdin");
      merged = { ...merged, ...fromStdin };
      sources.push("stdin");
    } else if (explicitStdin) {
      throw new Error(
        "stdin was requested but body does not start with '{' — JSON object required",
      );
    }
  }

  const source: ArgSource =
    sources.length === 0
      ? "shell"
      : sources.length === 1
        ? sources[0]
        : "mixed";

  return { args: merged, source, stdinRaw };
}
