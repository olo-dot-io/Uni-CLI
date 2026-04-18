/**
 * Invocation Kernel — the single entry point every surface (CLI, MCP, ACP,
 * bench, hub) funnels through. v0.213.3 R2 thesis: one validator, one
 * hardener, one envelope-builder for every caller.
 *
 * Responsibilities:
 *   - compile(adapter) → CompiledCommand (jsonSchema, example, ajv
 *     validator) eagerly at load-time so per-call cost is O(1)
 *   - execute(Invocation) → validate bag → harden → runPipeline → envelope
 *   - buildInvocation(surface, site, cmd, bag) → Invocation | null
 *
 * This file deliberately does NOT depend on any commander / MCP / ACP
 * machinery. Surfaces call `buildInvocation` + `execute`, format the
 * returned envelope for their own transport, and are done.
 */

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { randomBytes } from "node:crypto";

import { runPipeline } from "./executor.js";
import { hardenArgs, InputHardeningError } from "./harden.js";
import type { ResolvedArgs } from "./args.js";
import {
  defaultSuccessNextActions,
  defaultErrorNextActions,
} from "../output/next-actions.js";
import {
  errorTypeToCode,
  errorToAgentFields,
  mapErrorToExitCode,
} from "../output/error-map.js";
import { resolveCommand } from "../registry.js";
import type {
  AgentContext,
  AgentError,
  AgentNextAction,
} from "../output/envelope.js";
import { ExitCode } from "../types.js";
import type { AdapterArg, AdapterCommand, AdapterManifest } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

export interface Invocation {
  adapter: AdapterManifest;
  command: AdapterCommand;
  cmdName: string;
  bag: ResolvedArgs;
  surface: "cli" | "mcp" | "acp" | "bench" | "hub";
  /** ULID — 26-char Crockford Base32, time-sortable. */
  trace_id: string;
}

type AjvValidateFn = {
  (data: unknown): boolean;
  errors?: Array<{
    instancePath?: string;
    keyword?: string;
    message?: string;
    params?: Record<string, unknown>;
  }> | null;
};

export interface CompiledCommand {
  jsonSchema: Record<string, unknown>;
  example: Record<string, unknown>;
  channels: readonly ["shell", "file", "stdin"];
  argByName: Map<string, AdapterArg>;
  defaultNextActions: AgentNextAction[];
  validate: (
    args: unknown,
  ) =>
    | { ok: true }
    | { ok: false; errors: NonNullable<AjvValidateFn["errors"]> };
}

export interface InvocationResult {
  results: unknown[];
  envelope: AgentContext;
  durationMs: number;
  exitCode: number;
  warnings: string[];
  error?: AgentError;
}

// ─────────────────────────────────────────────────────────────────────────
// AJV singleton + schema compilation
// ─────────────────────────────────────────────────────────────────────────

type AjvCtor = new (opts: {
  strict: boolean;
  allErrors: boolean;
  validateFormats: boolean;
}) => {
  compile(schema: unknown): AjvValidateFn;
};

let ajvSingleton: InstanceType<AjvCtor> | undefined;

function getAjv() {
  if (ajvSingleton) return ajvSingleton;
  const Ctor = ((Ajv2020 as unknown as { default?: unknown }).default ??
    Ajv2020) as AjvCtor;
  const addFormatsFn = ((addFormats as unknown as { default?: unknown })
    .default ?? addFormats) as (
    ajv: unknown,
    opts?: { mode?: "fast" | "full" },
  ) => void;
  ajvSingleton = new Ctor({
    strict: true,
    allErrors: false,
    validateFormats: true,
  });
  addFormatsFn(ajvSingleton, { mode: "full" });
  return ajvSingleton;
}

/** Map adapter-arg type tokens to JSON Schema `type` strings. */
function jsonSchemaType(t: AdapterArg["type"]): string {
  switch (t) {
    case "int":
      return "integer";
    case "float":
      return "number";
    case "bool":
      return "boolean";
    default:
      return "string";
  }
}

function buildJsonSchema(args: AdapterArg[]): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const a of args) {
    const prop: Record<string, unknown> = { type: jsonSchemaType(a.type) };
    if (a.description) prop.description = a.description;
    if (a.default !== undefined) prop.default = a.default;
    if (a.choices && a.choices.length > 0) prop.enum = a.choices;
    if (a.format) prop.format = a.format;
    // x-unicli-kind / x-unicli-accepts are non-standard extension keywords;
    // Ajv is strict about unknown keywords, so we pass them through as
    // annotations under a nested `$comment`-like bag. Ajv treats unknown
    // top-level keys under `strict:true` as errors unless declared, so we
    // encode them via a custom `x-unicli` object which Ajv ignores.
    const ext: Record<string, unknown> = {};
    if (a["x-unicli-kind"]) ext.kind = a["x-unicli-kind"];
    if (a["x-unicli-accepts"]) ext.accepts = a["x-unicli-accepts"];
    if (Object.keys(ext).length > 0) prop["x-unicli"] = ext;
    properties[a.name] = prop;
    if (a.required) required.push(a.name);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function buildExample(args: AdapterArg[]): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  for (const a of args) {
    if (a.default !== undefined) {
      example[a.name] = a.default;
    } else if (a.choices && a.choices.length > 0) {
      example[a.name] = a.choices[0];
    } else {
      switch (a.type) {
        case "int":
          example[a.name] = 10;
          break;
        case "float":
          example[a.name] = 0.5;
          break;
        case "bool":
          example[a.name] = false;
          break;
        default:
          example[a.name] = `<${a.name}>`;
      }
    }
  }
  return example;
}

/**
 * Compile one `AdapterCommand` into an immutable `CompiledCommand`. Called
 * once per command per process; the resulting validator is reused on every
 * invocation.
 */
function compileCommand(cmd: AdapterCommand): CompiledCommand {
  const args = cmd.adapterArgs ?? [];
  const jsonSchema = buildJsonSchema(args);
  const ajv = getAjv();
  // Strip `x-unicli` from the schema passed to Ajv — Ajv's strict mode
  // rejects unknown keywords, but the original `jsonSchema` (kept for
  // introspection) preserves them. Clone + prune.
  const ajvSchema = JSON.parse(JSON.stringify(jsonSchema)) as Record<
    string,
    unknown
  >;
  const props = ajvSchema.properties as Record<string, Record<string, unknown>>;
  for (const key of Object.keys(props)) {
    if ("x-unicli" in props[key]) delete props[key]["x-unicli"];
  }
  const validator: AjvValidateFn = ajv.compile(ajvSchema);
  const argByName = new Map<string, AdapterArg>(
    args.map((a) => [a.name, a] as const),
  );
  const defaultNextActions = defaultSuccessNextActions(
    // Site / cmd aren't known yet here — filled in by execute(). Return a
    // template keyed by `${site}` / `${cmd}` that execute() re-issues.
    "${site}",
    "${cmd}",
  );
  return {
    jsonSchema,
    example: buildExample(args),
    channels: ["shell", "file", "stdin"] as const,
    argByName,
    defaultNextActions,
    validate: (args: unknown) => {
      const ok = validator(args);
      if (ok) return { ok: true };
      return {
        ok: false,
        errors: validator.errors ?? [],
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Module-level cache + public compileAll
// ─────────────────────────────────────────────────────────────────────────

const compiledCache = new Map<string, CompiledCommand>();

/**
 * Eagerly compile every (adapter, command) in the registry. Intended to be
 * called once at the tail of `loadAllAdapters()`; subsequent CLI / MCP /
 * ACP calls look up by `${site}.${cmd}` in O(1).
 */
export function compileAll(
  registry: AdapterManifest[],
): Map<string, CompiledCommand> {
  compiledCache.clear();
  for (const adapter of registry) {
    for (const [cmdName, cmd] of Object.entries(adapter.commands)) {
      compiledCache.set(`${adapter.name}.${cmdName}`, compileCommand(cmd));
    }
  }
  return compiledCache;
}

/** Expose the cache read-only for introspection (tests, describe.ts). */
export function getCompiled(
  site: string,
  cmd: string,
): CompiledCommand | undefined {
  return compiledCache.get(`${site}.${cmd}`);
}

/** Test hook — clear the cache between independent test files. */
export function _resetCompiledCacheForTests(): void {
  compiledCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────
// ULID generation (26-char Crockford Base32, time-sortable)
// ─────────────────────────────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generate a 26-char ULID. 48 bits of timestamp (ms since epoch) + 80 bits
 * of randomness. Time-sortable because the high 10 chars encode the ms
 * timestamp left-to-right. Dependency-free.
 */
function newULID(): string {
  const now = Date.now();
  const timeChars: string[] = [];
  let t = now;
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = CROCKFORD[t % 32];
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(10);
  const randChars: string[] = [];
  // 10 bytes = 80 bits = 16 Crockford chars.
  // Build the BigInt value then convert, staying synchronous.
  let acc = 0n;
  for (const b of rand) acc = (acc << 8n) | BigInt(b);
  for (let i = 15; i >= 0; i--) {
    randChars[i] = CROCKFORD[Number(acc & 31n)];
    acc >>= 5n;
  }
  return timeChars.join("") + randChars.join("");
}

// ─────────────────────────────────────────────────────────────────────────
// buildInvocation + execute
// ─────────────────────────────────────────────────────────────────────────

/**
 * Look up an adapter + command pair and return an Invocation ready for
 * execute(). Returns `null` if either the site or command is unknown —
 * callers can emit their own "unknown command" envelope.
 */
export function buildInvocation(
  surface: Invocation["surface"],
  site: string,
  cmd: string,
  bag: ResolvedArgs,
): Invocation | null {
  const resolved = resolveCommand(site, cmd);
  if (!resolved) return null;
  return {
    adapter: resolved.adapter,
    command: resolved.command,
    cmdName: cmd,
    bag,
    surface,
    trace_id: newULID(),
  };
}

/** Populate `${site}` / `${cmd}` placeholders in the default next-actions. */
function instantiateNextActions(
  site: string,
  cmd: string,
  templates: AgentNextAction[],
): AgentNextAction[] {
  return templates.map((a) => ({
    ...a,
    command: a.command.replaceAll("${site}", site).replaceAll("${cmd}", cmd),
  }));
}

/**
 * Run a validated, hardened invocation end-to-end. Callers receive a
 * typed `InvocationResult` — they are responsible for formatting the
 * envelope for their transport (stdout/MCP/ACP).
 *
 * Failure paths never throw: every error surfaces as `{ exitCode, error }`
 * on the returned result so transport code can do uniform error handling.
 */
export async function execute(inv: Invocation): Promise<InvocationResult> {
  const startedAt = Date.now();
  const key = `${inv.adapter.name}.${inv.cmdName}`;
  const compiled = compiledCache.get(key);
  const warnings: string[] = [];

  // Lazily compile on cache miss — loader wiring might not have primed the
  // cache when an individual unit test imports execute() in isolation.
  const compiledOrLazy = compiled ?? compileCommand(inv.command);
  if (!compiled) compiledCache.set(key, compiledOrLazy);

  // 1. JSON Schema validation (fail-closed via ajv strict mode).
  const v = compiledOrLazy.validate(inv.bag.args);
  if (!v.ok) {
    const first = v.errors[0] ?? { message: "invalid arguments" };
    const path = (first.instancePath ?? "").replace(/^\//, "");
    const name = path || "args";
    const err: AgentError = {
      code: "invalid_input",
      message: `arg "${name}" ${first.message ?? "invalid"}`,
      adapter_path: `src/adapters/${inv.adapter.name}/${inv.cmdName}.yaml`,
      step: 0,
      suggestion: `match the JSON Schema at \`unicli describe ${inv.adapter.name} ${inv.cmdName}\``,
      retryable: false,
    };
    const durationMs = Date.now() - startedAt;
    return {
      results: [],
      envelope: {
        command: key,
        duration_ms: durationMs,
        adapter_version: inv.adapter.version,
        surface: "web",
        error: err,
        next_actions: defaultErrorNextActions(
          inv.adapter.name,
          inv.cmdName,
          "invalid_input",
        ),
      },
      durationMs,
      exitCode: ExitCode.USAGE_ERROR,
      warnings,
      error: err,
    };
  }

  // 2. Schema-driven hardening (ajv format-assertion + x-unicli-kind).
  try {
    const h = hardenArgs(inv.bag.args, compiledOrLazy.argByName);
    warnings.push(...h.warnings);
  } catch (err) {
    if (err instanceof InputHardeningError) {
      const agentErr: AgentError = {
        code: "invalid_input",
        message: err.message,
        adapter_path: `src/adapters/${inv.adapter.name}/${inv.cmdName}.yaml`,
        step: 0,
        suggestion: err.suggestion,
        retryable: false,
      };
      const durationMs = Date.now() - startedAt;
      return {
        results: [],
        envelope: {
          command: key,
          duration_ms: durationMs,
          adapter_version: inv.adapter.version,
          surface: "web",
          error: agentErr,
          next_actions: defaultErrorNextActions(
            inv.adapter.name,
            inv.cmdName,
            "invalid_input",
          ),
        },
        durationMs,
        exitCode: ExitCode.USAGE_ERROR,
        warnings,
        error: agentErr,
      };
    }
    throw err;
  }

  // 3. Pipeline / func execution. runPipeline's Phase-3 signature change
  //    (bag-first) is deferred; here we pass `inv.bag.args`.
  let results: unknown[] = [];
  try {
    if (inv.command.pipeline) {
      results = await runPipeline(
        inv.command.pipeline,
        inv.bag.args,
        inv.adapter.base,
        {
          site: inv.adapter.name,
          strategy: inv.adapter.strategy,
        },
      );
    } else if (inv.command.func) {
      const raw = await inv.command.func(null as never, inv.bag.args);
      results = Array.isArray(raw) ? raw : [raw];
    } else {
      const agentErr: AgentError = {
        code: "internal_error",
        message: `command ${key} has neither pipeline nor func`,
        adapter_path: `src/adapters/${inv.adapter.name}/${inv.cmdName}.yaml`,
        step: 0,
        suggestion:
          "the adapter manifest is broken; run `unicli repair` to regenerate",
        retryable: false,
      };
      const durationMs = Date.now() - startedAt;
      return {
        results: [],
        envelope: {
          command: key,
          duration_ms: durationMs,
          adapter_version: inv.adapter.version,
          surface: "web",
          error: agentErr,
        },
        durationMs,
        exitCode: ExitCode.CONFIG_ERROR,
        warnings,
        error: agentErr,
      };
    }
  } catch (err) {
    const adapterPath = `src/adapters/${inv.adapter.name}/${inv.cmdName}.yaml`;
    const fields = errorToAgentFields(err, adapterPath, inv.adapter.name);
    const agentErr: AgentError = {
      code: errorTypeToCode(err),
      message: err instanceof Error ? err.message : String(err),
      ...fields,
    };
    const durationMs = Date.now() - startedAt;
    return {
      results: [],
      envelope: {
        command: key,
        duration_ms: durationMs,
        adapter_version: inv.adapter.version,
        surface: "web",
        error: agentErr,
        next_actions: defaultErrorNextActions(
          inv.adapter.name,
          inv.cmdName,
          agentErr.code,
        ),
      },
      durationMs,
      exitCode: mapErrorToExitCode(err),
      warnings,
      error: agentErr,
    };
  }

  // 4. Success envelope with next_actions (default + any YAML overrides).
  const durationMs = Date.now() - startedAt;
  const templates =
    compiledOrLazy.defaultNextActions.length > 0
      ? compiledOrLazy.defaultNextActions
      : defaultSuccessNextActions(inv.adapter.name, inv.cmdName);
  const nextActions = instantiateNextActions(
    inv.adapter.name,
    inv.cmdName,
    templates,
  );
  return {
    results,
    envelope: {
      command: key,
      duration_ms: durationMs,
      adapter_version: inv.adapter.version,
      surface: "web",
      next_actions: nextActions,
    },
    durationMs,
    exitCode: results.length === 0 ? ExitCode.EMPTY_RESULT : ExitCode.SUCCESS,
    warnings,
  };
}
