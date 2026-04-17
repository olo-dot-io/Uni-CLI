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

/**
 * Default surface for v0.213.x. Will expand to "desktop" / "system" / "mobile"
 * when v0.214 Nikolayev lands Computer Use operators. Until then every adapter
 * execution path runs on a web surface (CDP browser + HTTP).
 */
export const DEFAULT_SURFACE: Surface = "web";

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

/**
 * Structured error payload following sysexits.h / self-repair contract.
 *
 * `code` is an open string to preserve forward compatibility. The canonical
 * 15-value enum emitted by the current codebase, grouped by category:
 *
 * Transport / network (5):
 *   - `network_error`      — TCP/TLS/DNS failure, socket closed, timeout at transport layer
 *   - `rate_limited`       — 429 or upstream quota exhausted
 *   - `upstream_error`     — 5xx or gateway returned malformed body
 *   - `api_error`          — 4xx non-auth response from upstream API
 *   - `not_authenticated`  — request rejected because no/expired credentials were sent
 *
 * Input / validation (3):
 *   - `invalid_input`      — caller-supplied args failed validation
 *   - `selector_miss`      — CSS/XPath selector didn't match any element
 *   - `not_found`          — HTTP 404 or upstream "no such resource"
 *
 * Authorization (2):
 *   - `auth_required`      — endpoint needs auth and cookie file is missing
 *   - `permission_denied`  — authenticated but lacks capability for this resource
 *
 * Runtime (2):
 *   - `internal_error`     — uncaught exception / invariant violation inside unicli
 *   - `quarantined`        — adapter is gated by `quarantine:` in YAML; fix + repair
 *
 * Ref-locator (3, added v0.213.1 per Task T1):
 *   - `stale_ref`          — snapshot ref exists but the element it mapped to has detached
 *   - `ambiguous`          — ref resolves to multiple elements (fingerprint non-unique)
 *   - `ref_not_found`      — snapshot ref does not appear in the fingerprint map at all;
 *                            deliberately distinct from the HTTP-404 `not_found` code
 */
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

/**
 * Build an {@link AgentContext} with conventional defaults.
 *
 * Every caller passes `command` plus a `startedAt` timestamp (typically
 * `Date.now()` captured before dispatch); most callers accept the
 * {@link DEFAULT_SURFACE}. `opts` lets specific surfaces (desktop, mcp) or
 * versioned adapters override the defaults.
 *
 * The returned context has `duration_ms = Date.now() - startedAt` evaluated
 * at call time, so invoke `makeCtx` at envelope-emit time (not at dispatch
 * entry) — one of the two points where the 10 pre-existing call sites
 * already built the `AgentContext` literal.
 */
export function makeCtx(
  command: string,
  startedAt: number,
  opts?: {
    surface?: Surface;
    adapterVersion?: string;
    operator?: string;
  },
): AgentContext {
  return {
    command,
    duration_ms: Date.now() - startedAt,
    surface: opts?.surface ?? DEFAULT_SURFACE,
    adapter_version: opts?.adapterVersion,
    operator: opts?.operator,
  };
}

/**
 * Build a success envelope from context + payload.
 *
 * Optional `content` plumbs Anthropic-compatible content blocks (text / image /
 * resource) alongside the structured `data` payload. Populated via the YAML
 * adapter opt-in `emit_content: true` (v0.213.1+) so download-step file
 * metadata surfaces as `{type:"resource", uri:"file://…"}` entries.
 */
export function makeEnvelope(
  ctx: AgentContext,
  data: unknown[] | Record<string, unknown>,
  content?: AgentContent[],
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
    ...(content !== undefined && content.length > 0 ? { content } : {}),
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
