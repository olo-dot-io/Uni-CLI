/**
 * Agent-Native v2 envelope — stable contract for machine-readable output.
 *
 * All `--json` / `--yaml` / `--md` output wraps payloads in this envelope.
 * Hard-switch: v0.215 removes any legacy v1 path (DECISION 3 confirmed 2026-04-17).
 *
 * NOTE: Names are prefixed "Agent*" to avoid collision with the transport-layer
 * EnvelopeMeta / EnvelopeError re-exported from src/errors.ts (src/core/envelope.ts).
 */

export const SCHEMA_VERSION = "2" as const;
export type SchemaVersion = "2";

export type Surface = "web" | "desktop" | "system" | "mobile";

/** MCP-style content block carried alongside structured data. */
export interface AgentContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  uri?: string;
}

/** Timing, pagination, and provenance metadata on every envelope. */
export interface AgentMeta {
  duration_ms: number;
  count?: number;
  adapter_version?: string;
  surface?: Surface;
  operator?: string;
  pagination?: {
    next_cursor?: string;
    has_more?: boolean;
  };
}

/** Structured error payload following sysexits.h / self-repair contract. */
export interface AgentError {
  code: string;
  message: string;
  adapter_path?: string;
  step?: number;
  suggestion?: string;
  retryable?: boolean;
  alternatives?: string[];
}

/** Caller-supplied context used to build an envelope. */
export interface AgentContext {
  command: string; // e.g. "twitter.search"
  duration_ms: number;
  adapter_version?: string;
  surface?: Surface;
  operator?: string;
  pagination?: AgentMeta["pagination"];
  /** Set on the error path in format() — makeEnvelope ignores this field. */
  error?: AgentError;
}

/** Success arm of the discriminated union. */
export interface AgentEnvelopeOk {
  ok: true;
  schema_version: SchemaVersion;
  command: string;
  meta: AgentMeta;
  data: unknown[] | Record<string, unknown>;
  error: null;
  content?: AgentContent[];
}

/** Error arm of the discriminated union. */
export interface AgentEnvelopeErr {
  ok: false;
  schema_version: SchemaVersion;
  command: string;
  meta: AgentMeta;
  data: null;
  error: AgentError;
  content?: AgentContent[];
}

export type AgentEnvelope = AgentEnvelopeOk | AgentEnvelopeErr;

/** Build a success envelope from context + payload. */
export function makeEnvelope(
  ctx: AgentContext,
  data: unknown[] | Record<string, unknown>,
): AgentEnvelopeOk {
  const count = Array.isArray(data) ? data.length : undefined;
  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    command: ctx.command,
    meta: {
      duration_ms: ctx.duration_ms,
      ...(count !== undefined ? { count } : {}),
      ...(ctx.adapter_version !== undefined
        ? { adapter_version: ctx.adapter_version }
        : {}),
      ...(ctx.surface !== undefined ? { surface: ctx.surface } : {}),
      ...(ctx.operator !== undefined ? { operator: ctx.operator } : {}),
      ...(ctx.pagination !== undefined &&
      (ctx.pagination.next_cursor !== undefined ||
        ctx.pagination.has_more !== undefined)
        ? { pagination: ctx.pagination }
        : {}),
    },
    data,
    error: null,
  };
}

/** Build an error envelope. `data` is forced to null. */
export function makeError(
  ctx: AgentContext,
  err: AgentError,
): AgentEnvelopeErr {
  return {
    ok: false,
    schema_version: SCHEMA_VERSION,
    command: ctx.command,
    meta: {
      duration_ms: ctx.duration_ms,
      ...(ctx.adapter_version !== undefined
        ? { adapter_version: ctx.adapter_version }
        : {}),
      ...(ctx.surface !== undefined ? { surface: ctx.surface } : {}),
      ...(ctx.operator !== undefined ? { operator: ctx.operator } : {}),
    },
    data: null,
    error: err,
  };
}

/**
 * Invariant check — throws `Error` with a descriptive message if the envelope
 * violates any structural rule. Used by tests and by the formatter before serialization.
 */
export function validateEnvelope(env: AgentEnvelope): void {
  if (env.schema_version !== SCHEMA_VERSION) {
    throw new Error(`envelope schema_version must be "${SCHEMA_VERSION}"`);
  }
  if (env.ok && env.error !== null) {
    throw new Error("envelope.ok=true but error is not null");
  }
  if (!env.ok && env.error === null) {
    throw new Error("envelope.ok=false but error is null");
  }
  if (!env.ok && env.data !== null) {
    throw new Error("envelope.ok=false but data is not null");
  }
  if (env.ok && env.data === null) {
    throw new Error("envelope.ok=true but data is null");
  }
  if (typeof env.meta.duration_ms !== "number") {
    throw new Error("envelope.meta.duration_ms must be a number");
  }
  // command must match "<site>.<command>" (covers non-empty as well)
  if (!/^[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(env.command)) {
    throw new Error(
      `envelope.command must match "<site>.<command>" (alnum + _/-), got "${env.command}"`,
    );
  }
  // content[].type enum
  if (env.content !== undefined) {
    for (const c of env.content) {
      if (!["text", "image", "resource"].includes(c.type)) {
        throw new Error(
          `envelope.content[].type must be text|image|resource, got "${c.type}"`,
        );
      }
    }
  }
  // meta.count must agree with data.length when both are present
  if (
    Array.isArray(env.data) &&
    env.meta.count !== undefined &&
    env.meta.count !== env.data.length
  ) {
    throw new Error(
      `envelope.meta.count (${env.meta.count}) disagrees with data.length (${env.data.length})`,
    );
  }
}
