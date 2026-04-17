/**
 * Structured errors for ref-backed locator verification.
 *
 * Ports the diagnostics layer from OpenCLI PR #1016 on top of our existing
 * numbered-ref snapshot primitive. Three failure modes:
 *
 *   stale_ref      — snapshot was consumed, page mutated, ref no longer binds
 *   ambiguous      — the selector resolves to more than one live element
 *   ref_not_found  — the selector resolves to zero live elements
 *
 * Each error carries a candidate list (from the latest fingerprint map)
 * so the caller can recover without taking a fresh snapshot.
 *
 * TargetError is a sibling of PipelineError, not a subclass. When a step
 * throws a TargetError, `executor.ts` re-wraps it into a PipelineError and
 * preserves `detail.code` as the PipelineError's `errorType`. `dispatch.ts`
 * then passes that `errorType` through verbatim as the v2 envelope's
 * `AgentError.code` — so the three codes above surface without re-mapping.
 *
 * NOTE: the `ref_not_found` code is deliberately distinct from the generic
 * HTTP-404 `not_found` code emitted by `dispatch.ts`. Ref-locator failures
 * describe a DOM state; `not_found` describes a server response.
 */

export type TargetErrorCode = "stale_ref" | "ambiguous" | "ref_not_found";

export interface TargetCandidate {
  ref: string;
  role: string;
  name?: string;
}

export interface TargetErrorDetail {
  code: TargetErrorCode;
  ref: string;
  message: string;
  candidates?: TargetCandidate[];
  snapshot_age_ms?: number;
}

export class TargetError extends Error {
  readonly detail: TargetErrorDetail;

  constructor(detail: TargetErrorDetail) {
    super(detail.message);
    this.name = "TargetError";
    this.detail = detail;
  }
}

export function staleRef(
  ref: string,
  ageMs?: number,
  candidates?: TargetCandidate[],
): TargetError {
  const agePart =
    ageMs !== undefined ? ` (snapshot age ${String(ageMs)}ms)` : "";
  return new TargetError({
    code: "stale_ref",
    ref,
    message: `ref ${ref} is stale — no entry in the current fingerprint map${agePart}. Take a fresh snapshot before acting.`,
    candidates,
    snapshot_age_ms: ageMs,
  });
}

export function ambiguous(
  ref: string,
  candidates: TargetCandidate[],
): TargetError {
  return new TargetError({
    code: "ambiguous",
    ref,
    message: `ref ${ref} resolves to ${String(candidates.length)} live elements. Disambiguate with a role- or name-qualified ref.`,
    candidates,
  });
}

export function notFound(
  ref: string,
  candidates?: TargetCandidate[],
): TargetError {
  return new TargetError({
    code: "ref_not_found",
    ref,
    message: `ref ${ref} resolves to zero live elements. The target may have been removed or re-rendered.`,
    candidates,
  });
}

export function isTargetError(err: unknown): err is TargetError {
  return err instanceof TargetError;
}
