/**
 * Input hardening — agents hallucinate differently from humans. A typo
 * like `../../../.ssh` is near-impossible for a person but routine for an
 * LLM confusing path segments. This module validates the resolved ArgBag
 * for the four classes of adversarial input that Poehnelt (Google
 * Workspace CLI, 2026-03) identified:
 *
 *   - Control characters in string args (below 0x20, except \t\n\r)
 *   - Path traversal in path-like args (../ segments, absolute escape)
 *   - Resource-id shaped args containing URL syntax (?, #, embedded params)
 *   - Double URL-encoding of values that will be URL-encoded again
 *
 * Violations throw `InputHardeningError` with a directional suggestion
 * that completes the self-repair contract (Banach convergence principle).
 */

import { isAbsolute, resolve as resolvePath, relative } from "node:path";
import type { AdapterArg } from "../types.js";

export class InputHardeningError extends Error {
  constructor(
    message: string,
    public readonly argName: string,
    public readonly suggestion: string,
  ) {
    super(message);
    this.name = "InputHardeningError";
  }
}

/** Does the value contain an ASCII control char we never want to see? */
function hasControlChars(value: string): boolean {
  // Allow \t (0x09), \n (0x0A), \r (0x0D); reject anything else <0x20 or DEL (0x7F).
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Heuristic: does this arg look like a filesystem path by name? */
function looksLikePathArg(name: string): boolean {
  return /(^|_)(path|file|output|dir|dest|destination)$/i.test(name);
}

/** Heuristic: does this arg look like a resource id (not a URL)? */
function looksLikeIdArg(name: string): boolean {
  // Match *_id, *Id, id. Exclude args named *_url or containing 'url'.
  if (/url/i.test(name)) return false;
  return /(^|_)id$/i.test(name) || /Id$/.test(name);
}

/** Heuristic: does this arg carry a URL (tolerate ? and # in value)? */
function looksLikeUrlArg(name: string, value: string): boolean {
  if (/(^|_)url$/i.test(name) || /url/i.test(name)) return true;
  return value.startsWith("http://") || value.startsWith("https://");
}

/**
 * Sandbox a path to the current working directory. Absolute paths outside
 * CWD / home-dir, or any path that escapes CWD via `..`, are rejected.
 * Explicit home-dir paths (starting with `~`) are allowed after expansion.
 */
function validatePathArg(name: string, value: string): void {
  if (value.includes("\0")) {
    throw new InputHardeningError(
      `path arg "${name}" contains NUL byte`,
      name,
      "remove NUL bytes and retry; NUL is never valid in filesystem paths",
    );
  }

  // Expand ~ manually; node doesn't do it for us.
  let expanded = value;
  if (expanded.startsWith("~")) {
    expanded =
      (process.env.HOME ?? process.env.USERPROFILE ?? "") + expanded.slice(1);
  }

  const cwd = process.cwd();
  const abs = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
  const rel = relative(cwd, abs);

  // Rejected if the relative path starts with `..` AND also isn't within
  // the user's home directory (agents often legitimately target ~/.unicli).
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const withinHome = homeDir && abs.startsWith(homeDir);
  const withinCwd = !rel.startsWith("..") && !isAbsolute(rel);

  if (!withinCwd && !withinHome) {
    throw new InputHardeningError(
      `path arg "${name}" escapes CWD and is not inside $HOME: "${value}"`,
      name,
      `pass a path inside ${cwd} or inside $HOME (${homeDir})`,
    );
  }
}

/** Reject resource-id args that contain URL punctuation. */
function validateIdArg(name: string, value: string): void {
  if (/[?#]/.test(value)) {
    throw new InputHardeningError(
      `id arg "${name}" contains URL punctuation "?" or "#": "${value}"`,
      name,
      "strip query string / fragment — resource ids are bare tokens, not URLs",
    );
  }
  if (/%[0-9a-fA-F]{2}/.test(value)) {
    throw new InputHardeningError(
      `id arg "${name}" appears to be pre-URL-encoded: "${value}"`,
      name,
      "pass the raw id; unicli applies URL encoding at the HTTP layer",
    );
  }
}

/** Warn (non-throwing) when a URL arg looks double-encoded. */
function warnDoubleEncoded(name: string, value: string): string | undefined {
  // Look for %25 followed by two hex — that's `%` itself being encoded twice.
  if (/%25[0-9a-fA-F]{2}/.test(value)) {
    return `arg "${name}" looks double-URL-encoded (contains %25XX). Pass a single-encoded or raw URL.`;
  }
  return undefined;
}

/**
 * Validate the resolved ArgBag against the adapter schema. Returns any
 * non-fatal warnings (double-encoded URLs, etc.); throws InputHardeningError
 * for anything unsafe.
 */
export function hardenArgs(
  args: Record<string, unknown>,
  schema: AdapterArg[],
): { warnings: string[] } {
  const warnings: string[] = [];
  const byName = new Map(schema.map((a) => [a.name, a] as const));

  for (const [name, raw] of Object.entries(args)) {
    if (typeof raw !== "string") continue;
    const value = raw;

    if (hasControlChars(value)) {
      throw new InputHardeningError(
        `arg "${name}" contains control characters (ASCII <0x20 or 0x7F)`,
        name,
        "remove control characters; only \\t \\n \\r are allowed in string args",
      );
    }

    const declared = byName.get(name);
    const isExplicitUrl = declared?.description
      ? /url/i.test(declared.description)
      : false;

    if (looksLikePathArg(name)) {
      validatePathArg(name, value);
      continue;
    }

    if (looksLikeUrlArg(name, value) || isExplicitUrl) {
      const w = warnDoubleEncoded(name, value);
      if (w) warnings.push(w);
      continue;
    }

    if (looksLikeIdArg(name)) {
      validateIdArg(name, value);
      continue;
    }
  }

  return { warnings };
}
