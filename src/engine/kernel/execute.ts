/**
 * execute() — the bag-to-envelope pipeline every surface shares.
 *
 * Flow per invocation:
 *   1. ajv validate(bag.args)              → fail-closed USAGE_ERROR on reject
 *   2. hardenArgs(bag.args, argByName)     → schema-driven hardening
 *   3. runPipeline() / command.func()      → actual work
 *   4. build success envelope with live next_actions (runtime, not templated)
 *
 * Callers (CLI/MCP/ACP) format the returned `InvocationResult` for their
 * transport; they do not rebuild envelopes.
 */

import { runPipeline } from "../executor.js";
import { hardenArgs, InputHardeningError } from "../harden.js";
import {
  defaultSuccessNextActions,
  defaultErrorNextActions,
} from "../../output/next-actions.js";
import {
  errorTypeToCode,
  errorToAgentFields,
  mapErrorToExitCode,
} from "../../output/error-map.js";
import { resolveCommand } from "../../registry.js";
import type { AgentError } from "../../output/envelope.js";
import { ExitCode } from "../../types.js";
import type { ResolvedArgs } from "../args.js";

import { getCompiled } from "./compile.js";
import type { Invocation, InvocationResult } from "./types.js";
import { newULID } from "./ulid.js";

/**
 * Raised when execute() is called for a (site, cmd) pair that was not seen
 * by `compileAll()` at loader boot. Signals a wiring bug (the loader forgot
 * to prime the cache), not a user error.
 */
export class KernelLookupError extends Error {
  constructor(key: string) {
    super(
      `KernelLookupError: compiled command not found: ${key}. ` +
        "Loader must call compileAll() before execute() — call primeKernelCache() from discovery/loader.ts.",
    );
    this.name = "KernelLookupError";
  }
}

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

/**
 * Run a validated, hardened invocation end-to-end. Failure paths never
 * throw — every error surfaces as `{ exitCode, error }` on the returned
 * result so transport code can do uniform error handling.
 */
export async function execute(inv: Invocation): Promise<InvocationResult> {
  const startedAt = Date.now();
  const key = `${inv.adapter.name}.${inv.cmdName}`;
  const compiled = getCompiled(inv.adapter.name, inv.cmdName);
  const warnings: string[] = [];

  // Loader primes the kernel cache via primeKernelCache() after every
  // registry mutation. A miss here means either a wiring bug or a test
  // that registers an adapter without calling primeKernelCache() — throw
  // a clear error instead of silently recompiling.
  if (!compiled) throw new KernelLookupError(key);

  // 1. JSON Schema validation (fail-closed via ajv strict mode).
  const v = compiled.validate(inv.bag.args);
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
    const h = hardenArgs(inv.bag.args, compiled.argByName);
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

  // 3. Pipeline / func execution. runPipeline requires a ResolvedArgs bag
  //    as of v0.213.3 P3 (D6); surface + trace_id are plumbed through so
  //    YAML templates can reference ${{ surface }} / ${{ trace_id }}.
  let results: unknown[] = [];
  try {
    if (inv.command.pipeline) {
      results = await runPipeline(
        inv.command.pipeline,
        inv.bag,
        inv.adapter.base,
        {
          site: inv.adapter.name,
          strategy: inv.adapter.strategy,
          surface: inv.surface,
          trace_id: inv.trace_id,
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

  // 4. Success envelope. next_actions built at runtime with the literal
  //    site/cmd so adapter templates that legitimately carry `${site}` are
  //    never mangled and `paginated` metadata flows through.
  const durationMs = Date.now() - startedAt;
  const nextActions = defaultSuccessNextActions(inv.adapter.name, inv.cmdName, {
    supportsPagination: inv.command.paginated === true,
  });
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
