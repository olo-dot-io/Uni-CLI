/**
 * Kernel types — Invocation, CompiledCommand, InvocationResult.
 *
 * Pure type declarations only; no runtime dependencies beyond shared domain
 * types. Kept isolated so surfaces (MCP/ACP/CLI) can import types without
 * pulling ajv / crypto.
 */

import type { ResolvedArgs } from "../args.js";
import type { AgentContext, AgentError } from "../../output/envelope.js";
import type {
  AdapterArg,
  AdapterCommand,
  AdapterManifest,
} from "../../types.js";

export interface Invocation {
  adapter: AdapterManifest;
  command: AdapterCommand;
  cmdName: string;
  bag: ResolvedArgs;
  surface: "cli" | "mcp" | "acp" | "bench" | "hub";
  permissionProfile?: string;
  approved?: boolean;
  rememberApproval?: boolean;
  /** ULID — 26-char Crockford Base32, time-sortable and monotonic within ms. */
  trace_id: string;
}

export type AjvValidateFn = {
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
  diagnostics?: InvocationDiagnostic[];
}

export type InvocationDiagnostic = RuntimePermissionDeniedDiagnostic;

export interface RuntimePermissionDeniedDiagnostic {
  kind: "runtime_permission_denied";
  code: "permission_denied";
  action: string;
  step: number;
  retryable: boolean;
  rule_id?: string;
  resource_buckets: string[];
  resources?: Record<string, string[]>;
}
