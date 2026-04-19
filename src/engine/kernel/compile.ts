/**
 * Compile step — converts adapter manifests into immutable `CompiledCommand`
 * entries keyed by `${site}.${cmd}`. Called once at loader boot; every
 * subsequent invocation looks up O(1).
 *
 * Built on ajv 2020-12 strict mode + format-assertion so adapter schemas
 * fail closed. `x-unicli` extension keywords are stripped before handing to
 * ajv (strict mode rejects unknowns) but preserved in the introspection
 * schema returned to describe.ts / MCP tools/list.
 */

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import type {
  AdapterArg,
  AdapterCommand,
  AdapterManifest,
} from "../../types.js";
import type { AjvValidateFn, CompiledCommand } from "./types.js";

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
    // annotations under a nested `x-unicli` bag that Ajv's schema cloner
    // strips before compilation.
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
 * once per command per process; the validator is reused on every call.
 */
export function compileCommand(cmd: AdapterCommand): CompiledCommand {
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
  return {
    jsonSchema,
    example: buildExample(args),
    channels: ["shell", "file", "stdin"] as const,
    argByName,
    validate: (input: unknown) => {
      const ok = validator(input);
      if (ok) return { ok: true };
      return {
        ok: false,
        errors: validator.errors ?? [],
      };
    },
  };
}

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

/** Internal — used by execute() for lazy cache fill on isolated unit tests. */
export function setCompiled(key: string, compiled: CompiledCommand): void {
  compiledCache.set(key, compiled);
}

/** Test hook — clear the cache between independent test files. */
export function _resetCompiledCacheForTests(): void {
  compiledCache.clear();
}
