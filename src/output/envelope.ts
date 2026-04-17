/**
 * Agent-Native v2 envelope — stable contract for machine-readable output.
 *
 * All `--json` / `--yaml` / `--md` output wraps payloads in this envelope.
 * Hard-switch: v0.215 removes any legacy v1 path (DECISION 3 confirmed 2026-04-17).
 */

export const SCHEMA_VERSION = "2" as const;

export type Surface = "web" | "desktop" | "system" | "mobile";

export interface EnvelopeContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  uri?: string;
}

export interface EnvelopeMeta {
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

export interface EnvelopeError {
  code: string;
  message: string;
  adapter_path?: string;
  step?: number;
  suggestion?: string;
  retryable?: boolean;
  alternatives?: string[];
}

export interface EnvelopeContext {
  command: string; // e.g. "twitter.search"
  duration_ms: number;
  adapter_version?: string;
  surface?: Surface;
  operator?: string;
  pagination?: EnvelopeMeta["pagination"];
}

export interface AgentEnvelope {
  ok: boolean;
  schema_version: typeof SCHEMA_VERSION;
  command: string;
  meta: EnvelopeMeta;
  data: unknown[] | Record<string, unknown> | null;
  error: EnvelopeError | null;
  content?: EnvelopeContent[];
}

/** Build a success envelope from context + payload. */
export function makeEnvelope(
  ctx: EnvelopeContext,
  data: unknown[] | Record<string, unknown>,
): AgentEnvelope {
  const count = Array.isArray(data) ? data.length : undefined;
  return {
    ok: true,
    schema_version: SCHEMA_VERSION,
    command: ctx.command,
    meta: {
      duration_ms: ctx.duration_ms,
      ...(count !== undefined ? { count } : {}),
      ...(ctx.adapter_version ? { adapter_version: ctx.adapter_version } : {}),
      ...(ctx.surface ? { surface: ctx.surface } : {}),
      ...(ctx.operator ? { operator: ctx.operator } : {}),
      ...(ctx.pagination ? { pagination: ctx.pagination } : {}),
    },
    data,
    error: null,
  };
}

/** Build an error envelope. `data` is forced to null. */
export function makeError(
  ctx: EnvelopeContext,
  err: EnvelopeError,
): AgentEnvelope {
  return {
    ok: false,
    schema_version: SCHEMA_VERSION,
    command: ctx.command,
    meta: {
      duration_ms: ctx.duration_ms,
      ...(ctx.adapter_version ? { adapter_version: ctx.adapter_version } : {}),
      ...(ctx.surface ? { surface: ctx.surface } : {}),
      ...(ctx.operator ? { operator: ctx.operator } : {}),
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
  if (!env.command || typeof env.command !== "string") {
    throw new Error("envelope.command must be a non-empty string");
  }
  if (typeof env.meta.duration_ms !== "number") {
    throw new Error("envelope.meta.duration_ms must be a number");
  }
}
