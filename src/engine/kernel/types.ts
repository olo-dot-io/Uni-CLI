/**
 * @owner       src/engine/kernel/types.ts
 * @does        Define cancellable invocation, parent correlation, compiled-command, result, and diagnostic contracts.
 * @needs       resolved arguments, output envelopes, adapter domain types
 * @feeds       kernel execution, session recording, CLI/MCP/ACP surfaces
 * @breaks      Type drift here breaks cross-surface execution and cancellation semantics.
 * @invariants  Direct and nested diagnostics always carry a parent invocation; standalone diagnostics never do.
 * @side-effects none
 * @perf        Type-only module with no runtime allocation.
 * @concurrency Immutable request-owned contracts are safe to pass across async boundaries.
 * @test        tests/unit/engine/invoke.test.ts and tests/unit/kernel-stage-parity.test.ts
 * @stability   stable
 * @since       2026-04-19
 *
 * Pure type declarations only; no runtime dependencies beyond shared domain
 * types. Kept isolated so surfaces (MCP/ACP/CLI) can import types without
 * pulling ajv / crypto.
 */

import type { ResolvedArgs } from "../args.js";
import type { AgentContext, AgentError } from "../../output/envelope.js";
import type { EffectVerdict } from "../../core/effect-verdict.js";
import type { CookieInvocationOverride } from "../cookies.js";
import type {
  AdapterArg,
  AdapterCommand,
  AdapterManifest,
} from "../../types.js";

interface InvocationCore {
  adapter: AdapterManifest;
  command: AdapterCommand;
  cmdName: string;
  bag: ResolvedArgs;
  surface: "cli" | "mcp" | "acp" | "bench" | "hub";
  permissionProfile?: string;
  approved?: boolean;
  rememberApproval?: boolean;
  /** Opaque one-shot credential capability created by an explicit auth refresh. */
  cookieInvocationOverride?: CookieInvocationOverride;
  /** Request-owned cancellation propagated by transports that support it. */
  signal?: AbortSignal;
  /** ULID — 26-char Crockford Base32, time-sortable and monotonic within ms. */
  trace_id: string;
}

export type InvocationDiagnosticIdentity =
  | {
      diagnosticParentInvocationId: string;
      diagnosticRole: "direct" | "nested";
    }
  | {
      diagnosticParentInvocationId?: never;
      diagnosticRole: "standalone";
    };

export type Invocation = InvocationCore & InvocationDiagnosticIdentity;

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
  validate: (args: unknown) =>
    | { ok: true }
    | {
        ok: false;
        errors: Readonly<NonNullable<AjvValidateFn["errors"]>>;
      };
}

export interface InvocationResult {
  results: unknown[];
  envelope: AgentContext;
  durationMs: number;
  exitCode: number;
  warnings: string[];
  effectVerdict: EffectVerdict;
  error?: AgentError;
  diagnostics?: InvocationDiagnostic[];
}

export type InvocationDiagnostic =
  | RuntimePermissionDeniedDiagnostic
  | BrowserCommandDiagnostic;

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

export interface BrowserCommandDiagnostic {
  kind: "browser_command";
  site: string;
  command: string;
  adapter_path: string;
  target_surface: string;
  evidence: {
    session: string;
    network: string;
    verify: string;
  };
  site_memory: {
    endpoints: string;
    field_map: string;
    notes: string;
    fixtures_dir: string;
    verify_dir: string;
  };
  authoring_loop: string[];
}
