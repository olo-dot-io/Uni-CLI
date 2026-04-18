/**
 * Input hardening — agents hallucinate differently from humans. A typo
 * like `../../../.ssh` is near-impossible for a person but routine for an
 * LLM confusing path segments. This module validates the resolved ArgBag
 * against the schema the adapter *declares*, not regex heuristics on arg
 * names (v0.213.3: D5 locked — no fallback to `looksLike*`).
 *
 * Dispatch order for each string arg:
 *   1. Always-on: ASCII control-char check (below 0x20, except \t\n\r)
 *   2. `format: "uri"` (+ the other draft-2020-12 standard formats)
 *      → ajv format-assertion — fails closed
 *   3. `x-unicli-kind: "path"`        → validatePathArg (traversal + NUL + sandbox)
 *   4. `x-unicli-kind: "adapter-ref"` → `<site>/<command>` regex
 *   5. `x-unicli-kind: "selector"`    → reject `<script` or unescaped backtick
 *   6. `x-unicli-kind: "shell-safe"`  → reject `$` `` ` `` `;` `|` `&` `>`
 *   7. `x-unicli-kind: "id"`          → reject URL punctuation (`?` `#`) and
 *                                        percent-escapes; IDs are bare tokens
 *   8. If a kind check fails, `x-unicli-accepts` lists secondary kinds
 *      that can salvage the value (dual-accept fallback).
 *   9. No format / kind declared → freeform; only the control-char gate
 *      applies (codemod in Phase 4 migrates YAML adapters; unannotated
 *      args stay permissive until then).
 *
 * Violations throw `InputHardeningError` with a directional suggestion
 * that completes the self-repair contract (Banach convergence principle).
 *
 * NOTE: kept the `InputHardeningError` class and its `{argName, suggestion}`
 * fields intact — MCP/ACP surfaces depend on them for `structuredContent`.
 */

import { isAbsolute, resolve as resolvePath, relative, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
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
  // Use strict boundary match (dir === base || startsWith(base + sep)) so
  // `$HOME=/Users/foo` does NOT match `/Users/foobar/...` — raw `startsWith`
  // would allow a prefix-collision escape on shared machines.
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const withinHome = Boolean(
    homeDir && (abs === homeDir || abs.startsWith(homeDir + sep)),
  );
  const withinCwd = !rel.startsWith("..") && !isAbsolute(rel);

  if (!withinCwd && !withinHome) {
    throw new InputHardeningError(
      `path arg "${name}" escapes CWD and is not inside $HOME: "${value}"`,
      name,
      `pass a path inside ${cwd} or inside $HOME (${homeDir})`,
    );
  }
}

/** `<site>/<command>` token (alphanumeric + _ - on each side). */
function validateAdapterRefArg(name: string, value: string): void {
  if (!/^[a-z0-9_-]+\/[a-z0-9_-]+$/.test(value)) {
    throw new InputHardeningError(
      `adapter-ref arg "${name}" must match "<site>/<command>": "${value}"`,
      name,
      "pass the adapter reference as `<site>/<command>` (lowercase alphanumerics, `_`, `-`)",
    );
  }
}

/** CSS/XPath-ish selector — reject the two punctuations agents use to smuggle code. */
function validateSelectorArg(name: string, value: string): void {
  if (/<script/i.test(value)) {
    throw new InputHardeningError(
      `selector arg "${name}" contains "<script" — likely XSS payload: "${value}"`,
      name,
      "pass a bare CSS or XPath selector; never include HTML tags",
    );
  }
  // Reject any backtick — `querySelector` does not need them and they are
  // the classic JS template-literal escape.
  if (/`/.test(value)) {
    throw new InputHardeningError(
      `selector arg "${name}" contains backtick — selectors never need them: "${value}"`,
      name,
      "remove backticks; use single or double quotes in attribute selectors",
    );
  }
}

/**
 * Resource id token — reject anything that is a URL fragment rather than a
 * bare identifier. Agents frequently paste a full URL into an `id` slot; the
 * adapter then either double-encodes it or 404s. We reject `?`/`#` (query or
 * fragment) and `%XX` (already URL-encoded). Adapters that legitimately accept
 * both a bare id AND a URL declare `x-unicli-accepts: [url]` so the URL
 * salvage path kicks in.
 */
function validateIdArg(name: string, value: string): void {
  if (/[?#]/.test(value)) {
    throw new InputHardeningError(
      `id arg "${name}" contains URL punctuation (? or #): "${value}"`,
      name,
      "strip query string/fragment — resource ids are bare tokens, not URLs",
    );
  }
  if (/%[0-9a-fA-F]{2}/.test(value)) {
    throw new InputHardeningError(
      `id arg "${name}" contains URL-encoded characters (%XX): "${value}"`,
      name,
      "strip query string/fragment — resource ids are bare tokens, not URLs",
    );
  }
  // A full URL ("https://…") is not a bare id. Adapters that legitimately
  // accept both a token and a URL declare `x-unicli-accepts: [url]`; the
  // caller's try/catch salvage path picks that up without widening this
  // validator's contract.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    throw new InputHardeningError(
      `id arg "${name}" looks like a URL ("${value}") but kind is "id"`,
      name,
      "strip query string/fragment — resource ids are bare tokens, not URLs",
    );
  }
}

/** Shell-safe string — reject the injection chars a subprocess arg would expand. */
function validateShellSafeArg(name: string, value: string): void {
  // The order of chars in the regex is irrelevant — we reject any occurrence.
  // Keep `>` even though stdout redirection requires adjacent space; an
  // agent that wrote `>` in a shell-safe arg has already misunderstood it.
  if (/[$`;|&>]/.test(value)) {
    throw new InputHardeningError(
      `shell-safe arg "${name}" contains shell metacharacter ($ \` ; | & >): "${value}"`,
      name,
      "pass only literal values; the adapter will construct any subprocess args safely",
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

/** Treat URL fallback as "succeeds if it parses as an http(s) URL". */
function tryAcceptUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Treat ID fallback as "succeeds if it has no URL punctuation and no percent-escapes". */
function tryAcceptId(value: string): boolean {
  return !/[?#]/.test(value) && !/%[0-9a-fA-F]{2}/.test(value);
}

type AjvValidator = {
  (data: unknown): boolean;
  errors?: Array<{ message?: string }> | null;
};

let cachedFormatValidators:
  | Map<NonNullable<AdapterArg["format"]>, AjvValidator>
  | undefined;

/**
 * Lazy-init ajv with the draft-2020-12 format-assertion vocabulary and
 * build one compiled validator per standard format. Ajv treats `format` as
 * an annotation by default — opting into `meta/format-assertion` is what
 * makes it fail-closed (spec §7.3).
 *
 * Module-level so that per-arg validation is O(1) once the first call has
 * primed the cache. The cost is bounded (7 validators total).
 */
function getFormatValidators(): Map<
  NonNullable<AdapterArg["format"]>,
  AjvValidator
> {
  if (cachedFormatValidators) return cachedFormatValidators;
  // Normalise CJS/ESM interop: Node wraps `module.exports = class` as a
  // default-keyed namespace when imported into an ESM file.
  const AjvCtor = ((Ajv2020 as unknown as { default?: unknown }).default ??
    Ajv2020) as new (opts: {
    strict: boolean;
    allErrors: boolean;
    validateFormats: boolean;
  }) => {
    compile(schema: unknown): AjvValidator;
  };
  const addFormatsFn = ((addFormats as unknown as { default?: unknown })
    .default ?? addFormats) as (
    ajv: unknown,
    opts?: { mode?: "fast" | "full" },
  ) => void;
  // `validateFormats: true` with `mode: "full"` makes `format:` a hard
  // precondition rather than a silent annotation (JSON Schema draft-2020-12
  // format-assertion semantics, §7.3).
  const ajv = new AjvCtor({
    strict: true,
    allErrors: false,
    validateFormats: true,
  });
  addFormatsFn(ajv, { mode: "full" });

  const formats: Array<NonNullable<AdapterArg["format"]>> = [
    "uri",
    "uuid",
    "date-time",
    "email",
    "hostname",
    "ipv4",
    "ipv6",
    "regex",
  ];
  const map = new Map<NonNullable<AdapterArg["format"]>, AjvValidator>();
  for (const f of formats) {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
      format: f,
    };
    map.set(f, ajv.compile(schema));
  }
  cachedFormatValidators = map;
  return map;
}

function validateFormatArg(
  name: string,
  value: string,
  format: NonNullable<AdapterArg["format"]>,
): void {
  const validator = getFormatValidators().get(format);
  if (!validator) return;
  const ok = validator(value);
  if (ok) return;
  const detail =
    validator.errors?.[0]?.message ?? `does not match format "${format}"`;
  throw new InputHardeningError(
    `arg "${name}" ${detail}: "${value}"`,
    name,
    `pass a value matching JSON Schema format "${format}"`,
  );
}

type Kind = NonNullable<AdapterArg["x-unicli-kind"]>;

function validateKind(name: string, value: string, kind: Kind): void {
  switch (kind) {
    case "path":
      validatePathArg(name, value);
      return;
    case "adapter-ref":
      validateAdapterRefArg(name, value);
      return;
    case "selector":
      validateSelectorArg(name, value);
      return;
    case "shell-safe":
      validateShellSafeArg(name, value);
      return;
    case "id":
      validateIdArg(name, value);
      return;
  }
}

/**
 * Validate the resolved ArgBag against the adapter schema. Returns any
 * non-fatal warnings (double-encoded URLs, etc.); throws InputHardeningError
 * for anything unsafe.
 *
 * `argByName` is the Map already built by the invocation kernel. Callers
 * that hold the raw `AdapterArg[]` can pass it directly — the function
 * tolerates either shape via an internal normalisation.
 */
export function hardenArgs(
  args: Record<string, unknown>,
  schemaOrMap: AdapterArg[] | Map<string, AdapterArg>,
): { warnings: string[] } {
  const warnings: string[] = [];
  const byName =
    schemaOrMap instanceof Map
      ? schemaOrMap
      : new Map(schemaOrMap.map((a) => [a.name, a] as const));

  for (const [name, raw] of Object.entries(args)) {
    if (typeof raw !== "string") continue;
    const value = raw;

    // Always-on control-char gate — applies regardless of kind declaration.
    if (hasControlChars(value)) {
      throw new InputHardeningError(
        `arg "${name}" contains control characters (ASCII <0x20 or 0x7F)`,
        name,
        "remove control characters; only \\t \\n \\r are allowed in string args",
      );
    }

    const declared = byName.get(name);
    if (!declared) continue; // unknown field — left freeform until codemod

    // Standard-vocab format check (fails closed).
    if (declared.format) {
      try {
        validateFormatArg(name, value, declared.format);
      } catch (err) {
        if (!(err instanceof InputHardeningError)) throw err;
        // If the format is `uri` and dual-accept lists `id`, allow a bare
        // token to pass; otherwise rethrow.
        const accepts = declared["x-unicli-accepts"] ?? [];
        if (declared.format === "uri" && accepts.includes("id")) {
          if (tryAcceptId(value)) {
            // primary failed but secondary passed
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
      // Double-URL-encoding warning applies even on success.
      if (declared.format === "uri") {
        const w = warnDoubleEncoded(name, value);
        if (w) warnings.push(w);
      }
      continue;
    }

    // Bespoke kind dispatch.
    const kind = declared["x-unicli-kind"];
    if (kind) {
      try {
        validateKind(name, value, kind);
      } catch (err) {
        if (!(err instanceof InputHardeningError)) throw err;
        const accepts = declared["x-unicli-accepts"] ?? [];
        let salvaged = false;
        for (const alt of accepts) {
          if (alt === "url" && tryAcceptUrl(value)) {
            salvaged = true;
            break;
          }
          if (alt === "id" && tryAcceptId(value)) {
            salvaged = true;
            break;
          }
        }
        if (!salvaged) throw err;
      }
      continue;
    }
    // Missing kind declaration = freeform. Codemod (Phase 4) will
    // annotate the remaining 1324/1355 args.
  }

  return { warnings };
}
