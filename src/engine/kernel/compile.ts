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

import { assertUriShapeDeclarations } from "../harden.js";
import {
  buildArgumentExample,
  compileArgumentSchema,
} from "../../core/argument-schema.js";

import type {
  AdapterArg,
  AdapterCommand,
  AdapterManifest,
} from "../../types.js";
import type { CompiledCommand } from "./types.js";

/**
 * Compile one `AdapterCommand` into an immutable `CompiledCommand`. Called
 * once per command per process; the validator is reused on every call.
 */
export function compileCommand(cmd: AdapterCommand): CompiledCommand {
  const args = cmd.adapterArgs ?? [];
  assertUriShapeDeclarations(args);
  const compiledArguments = compileArgumentSchema(args);
  const argByName = new Map<string, AdapterArg>(
    args.map((a) => [a.name, a] as const),
  );
  return {
    jsonSchema: compiledArguments.jsonSchema,
    example: buildArgumentExample(args),
    channels: ["shell", "file", "stdin"] as const,
    argByName,
    validate: compiledArguments.validate,
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
