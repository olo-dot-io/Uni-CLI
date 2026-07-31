import { describe, expect, it } from "vitest";

import {
  attachDefaultEffectVerdict,
  confirmedEffectVerdict,
  defaultEffectVerdict,
  pendingEffectVerdict,
  readEffectVerdict,
  suspectedNoopEffectVerdict,
} from "../../../src/core/effect-verdict.js";
import { ok } from "../../../src/core/envelope.js";
import { settleDispatchedAction } from "../../../src/transport/action-settlement.js";

describe("effect verdict", () => {
  it("distinguishes reads, pre-dispatch rejection, and unverified mutation success", () => {
    expect(
      defaultEffectVerdict({
        canMutate: false,
        phase: "success",
      }),
    ).toMatchObject({
      status: "not_applicable",
      evidence: "declared_read",
    });
    expect(
      defaultEffectVerdict({
        canMutate: true,
        phase: "pre_dispatch",
      }),
    ).toMatchObject({
      status: "suspected_noop",
      evidence: "pre_dispatch_rejection",
    });
    expect(
      defaultEffectVerdict({
        canMutate: true,
        phase: "success",
      }),
    ).toMatchObject({
      status: "unverifiable",
      evidence: "dispatch_receipt",
    });
  });

  it("requires explicit authoritative or postcondition evidence for confirmed", () => {
    expect(
      confirmedEffectVerdict(
        "postcondition_observation",
        "the target state matches",
        "dom-state",
      ),
    ).toEqual({
      status: "confirmed",
      evidence: "postcondition_observation",
      reason: "the target state matches",
      verification: "dom-state",
    });
    expect(suspectedNoopEffectVerdict("state did not change")).toMatchObject({
      status: "suspected_noop",
      evidence: "state_unchanged",
    });
    expect(
      suspectedNoopEffectVerdict(
        "the provider refused dispatch",
        "provider result",
        "provider_refusal",
      ),
    ).toMatchObject({
      status: "suspected_noop",
      evidence: "provider_refusal",
    });
  });

  it("requires fresh observation before retrying a deferred accepted effect", () => {
    const pending = pendingEffectVerdict(
      "provider accepted delivery but has not published the observed state",
      "provider-state",
    );
    expect(pending).toEqual({
      status: "pending",
      evidence: "accepted_deferred_observation",
      reason:
        "provider accepted delivery but has not published the observed state",
      verification: "provider-state",
    });
    expect(readEffectVerdict(pending)).toEqual(pending);
  });

  it("preserves a provider verdict and only enriches its missing verification channel", () => {
    const provider = ok(
      { id: "receipt" },
      {
        effect_verdict: confirmedEffectVerdict(
          "authoritative_response",
          "the service returned a committed resource id",
        ),
      },
    );
    expect(
      attachDefaultEffectVerdict(provider, {
        canMutate: true,
        verification: "protocol-result",
      }).effect_verdict,
    ).toMatchObject({
      status: "confirmed",
      verification: "protocol-result",
    });
  });

  it("settles successful mutating transport envelopes as unverifiable by default", async () => {
    const result = await settleDispatchedAction(
      "click",
      true,
      undefined,
      async () => ok({ clicked: true }),
    );
    expect(result.effect_verdict).toMatchObject({
      status: "unverifiable",
      evidence: "dispatch_receipt",
    });
  });

  it("accepts only complete provider verdicts and normalizes text", () => {
    expect(
      readEffectVerdict({
        status: "confirmed",
        evidence: "postcondition_observation",
        reason: "  fresh state matched  ",
        verification: "  accessibility-state  ",
      }),
    ).toEqual({
      status: "confirmed",
      evidence: "postcondition_observation",
      reason: "fresh state matched",
      verification: "accessibility-state",
    });
    expect(
      readEffectVerdict({
        status: "confirmed",
        evidence: "dispatch_receipt",
        reason: "a receipt alone does not confirm the effect",
      }),
    ).toBeUndefined();
  });
});
