/**
 * @owner       src::core::effect-verdict
 * @does        Define and derive the uniform terminal verdict for an operation's external effect.
 * @needs       No runtime dependency.
 * @feeds       transport envelopes, invocation envelopes, MCP results, run evidence, and recovery policy.
 * @breaks      Treating dispatch completion as confirmed state can cause duplicate mutations; omitting a verdict makes successful writes impossible for agents to reason about safely.
 * @invariants  Confirmed requires authoritative response or observed postcondition evidence; mutation success without such evidence is unverifiable; pre-dispatch rejection is suspected-noop; reads are not-applicable.
 * @side-effects None.
 * @perf        O(1) immutable object construction.
 * @concurrency Pure request-local derivation.
 * @test        tests/unit/core/effect-verdict.test.ts, tests/unit/core/envelope.test.ts, tests/unit/engine/invoke.test.ts
 * @stability   experimental
 * @since       2026-07-30
 */

export type EffectVerdictStatus =
  | "not_applicable"
  | "confirmed"
  | "pending"
  | "unverifiable"
  | "suspected_noop";

export type EffectEvidenceKind =
  | "declared_read"
  | "pre_dispatch_rejection"
  | "dispatch_receipt"
  | "authoritative_response"
  | "postcondition_observation"
  | "accepted_deferred_observation"
  | "provider_noop_signal"
  | "provider_refusal"
  | "state_unchanged";

export interface EffectVerdict {
  status: EffectVerdictStatus;
  evidence: EffectEvidenceKind;
  reason: string;
  verification?: string;
}

export type EffectSettlementPhase =
  | "pre_dispatch"
  | "dispatched_failure"
  | "success";

export function defaultEffectVerdict(input: {
  canMutate: boolean;
  phase: EffectSettlementPhase;
  verification?: string;
}): EffectVerdict {
  if (!input.canMutate) {
    return {
      status: "not_applicable",
      evidence: "declared_read",
      reason: "the operation contract is read-only",
      ...(input.verification ? { verification: input.verification } : {}),
    };
  }
  if (input.phase === "pre_dispatch") {
    return {
      status: "suspected_noop",
      evidence: "pre_dispatch_rejection",
      reason: "the mutation was rejected before provider dispatch",
      ...(input.verification ? { verification: input.verification } : {}),
    };
  }
  return {
    status: "unverifiable",
    evidence: "dispatch_receipt",
    reason:
      input.phase === "success"
        ? "the provider returned successfully without authoritative postcondition evidence"
        : "the mutation reached provider dispatch but its external effect is not proven",
    ...(input.verification ? { verification: input.verification } : {}),
  };
}

export function confirmedEffectVerdict(
  evidence: Extract<
    EffectEvidenceKind,
    "authoritative_response" | "postcondition_observation"
  >,
  reason: string,
  verification?: string,
): EffectVerdict {
  return {
    status: "confirmed",
    evidence,
    reason,
    ...(verification ? { verification } : {}),
  };
}

export function suspectedNoopEffectVerdict(
  reason: string,
  verification?: string,
  evidence: Extract<
    EffectEvidenceKind,
    | "pre_dispatch_rejection"
    | "provider_noop_signal"
    | "provider_refusal"
    | "state_unchanged"
  > = "state_unchanged",
): EffectVerdict {
  return {
    status: "suspected_noop",
    evidence,
    reason,
    ...(verification ? { verification } : {}),
  };
}

export function pendingEffectVerdict(
  reason: string,
  verification?: string,
): EffectVerdict {
  return {
    status: "pending",
    evidence: "accepted_deferred_observation",
    reason,
    ...(verification ? { verification } : {}),
  };
}

export function readEffectVerdict(value: unknown): EffectVerdict | undefined {
  if (!isRecord(value)) return undefined;
  if (!isEffectVerdictStatus(value.status)) return undefined;
  if (!isEffectEvidenceKind(value.evidence)) return undefined;
  if (!isCompatibleStatusEvidence(value.status, value.evidence)) {
    return undefined;
  }
  if (typeof value.reason !== "string" || !value.reason.trim())
    return undefined;
  if (
    value.verification !== undefined &&
    (typeof value.verification !== "string" || !value.verification.trim())
  ) {
    return undefined;
  }
  return {
    status: value.status,
    evidence: value.evidence,
    reason: value.reason.trim(),
    ...(typeof value.verification === "string"
      ? { verification: value.verification.trim() }
      : {}),
  };
}

export function attachDefaultEffectVerdict<T>(
  value: T,
  input: {
    canMutate: boolean;
    phase?: EffectSettlementPhase;
    verification?: string;
  },
): T {
  if (!isEffectCarrier(value)) {
    return value;
  }
  if (value.effect_verdict !== undefined) {
    if (
      input.verification === undefined ||
      value.effect_verdict.verification !== undefined
    ) {
      return value;
    }
    return {
      ...value,
      effect_verdict: {
        ...value.effect_verdict,
        verification: input.verification,
      },
    };
  }
  return {
    ...value,
    effect_verdict: defaultEffectVerdict({
      canMutate: input.canMutate,
      phase:
        input.phase ?? (value.ok === true ? "success" : "dispatched_failure"),
      ...(input.verification ? { verification: input.verification } : {}),
    }),
  };
}

function isEffectCarrier(value: unknown): value is {
  ok: boolean;
  effect_verdict?: EffectVerdict;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEffectVerdictStatus(value: unknown): value is EffectVerdictStatus {
  return (
    value === "not_applicable" ||
    value === "confirmed" ||
    value === "pending" ||
    value === "unverifiable" ||
    value === "suspected_noop"
  );
}

function isEffectEvidenceKind(value: unknown): value is EffectEvidenceKind {
  return (
    value === "declared_read" ||
    value === "pre_dispatch_rejection" ||
    value === "dispatch_receipt" ||
    value === "authoritative_response" ||
    value === "postcondition_observation" ||
    value === "accepted_deferred_observation" ||
    value === "provider_noop_signal" ||
    value === "provider_refusal" ||
    value === "state_unchanged"
  );
}

function isCompatibleStatusEvidence(
  status: EffectVerdictStatus,
  evidence: EffectEvidenceKind,
): boolean {
  switch (status) {
    case "not_applicable":
      return evidence === "declared_read";
    case "confirmed":
      return (
        evidence === "authoritative_response" ||
        evidence === "postcondition_observation"
      );
    case "pending":
      return evidence === "accepted_deferred_observation";
    case "unverifiable":
      return evidence === "dispatch_receipt";
    case "suspected_noop":
      return (
        evidence === "pre_dispatch_rejection" ||
        evidence === "provider_noop_signal" ||
        evidence === "provider_refusal" ||
        evidence === "state_unchanged"
      );
  }
}
