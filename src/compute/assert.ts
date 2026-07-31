/**
 * @owner       src::compute::assert
 * @does        Evaluate a UI assertion against the latest Uni-CLI-owned ref generation without opening a GUI provider.
 * @needs       RefStore, bound ElementRef, and transport envelopes.
 * @feeds       compute assert across CLI, pipelines, and MCP.
 * @breaks      Treating cached refs as fresh live state would overstate verification.
 * @invariants  Assertions inspect only current RefStore generations; every requested predicate must match one ref; output identifies the observed ref and its capture time.
 * @side-effects None.
 * @perf        O(n) without a bound ref and O(1) with one.
 * @concurrency Pure over one synchronous RefStore snapshot.
 * @test        tests/unit/compute-assert.test.ts
 * @stability   experimental
 * @since       2026-07-31
 */

import { err, exitCodeFor, ok } from "../core/envelope.js";
import type { ActionResult } from "../transport/types.js";
import type { ElementRef, RefStore, RefStoreMatch } from "../transport/refs.js";

export function assertComputeRefs(
  refs: RefStore,
  params: Readonly<Record<string, unknown>>,
  bound?: RefStoreMatch,
): ActionResult<unknown> {
  const text = nonEmptyString(params.text);
  const state = nonEmptyString(params.state)?.toLocaleLowerCase();
  const requestedRef = nonEmptyString(params.ref);
  if (!requestedRef && !text && !state) {
    return invalidAssertion(
      "assert requires at least one of ref, text, or state",
    );
  }

  const candidates = bound
    ? [bound]
    : requestedRef
      ? refs.matches(requestedRef)
      : refs.listMatches();
  const match = candidates.find(({ ref }) => matches(ref, text, state));
  if (!match) {
    return err({
      transport: "local-runtime",
      step: 0,
      action: "compute_assert",
      reason:
        "No current Uni-CLI ref satisfies every requested assertion predicate",
      suggestion:
        "take a fresh snapshot of the exact target, then assert against its stable ref or observed text/state",
      minimum_capability: "compute.compute_assert.current-ref",
      exit_code: exitCodeFor("empty_result"),
    });
  }

  return ok({
    asserted: true,
    evidence: "latest-ref-generation",
    observed_at: new Date(match.bucket.createdAt).toISOString(),
    ref: match.ref.alias,
    stable: match.ref.stable,
    role: match.ref.role,
    ...(match.ref.name ? { name: match.ref.name } : {}),
    ...(match.ref.value ? { value: match.ref.value } : {}),
    ...(match.ref.states ? { states: match.ref.states } : {}),
  });
}

function matches(
  ref: ElementRef,
  text: string | undefined,
  state: string | undefined,
): boolean {
  if (text) {
    const haystack = [ref.name, ref.value, ref.role]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .normalize("NFKC")
      .toLocaleLowerCase();
    if (!haystack.includes(text.normalize("NFKC").toLocaleLowerCase())) {
      return false;
    }
  }
  if (state) {
    const states = new Set(
      (ref.states ?? []).map((value) => value.toLocaleLowerCase()),
    );
    if (!states.has(state)) return false;
  }
  return true;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function invalidAssertion(reason: string): ActionResult<unknown> {
  return err({
    transport: "local-runtime",
    step: 0,
    action: "compute_assert",
    reason,
    suggestion: "pass --ref, --text, or --state",
    minimum_capability: "compute.compute_assert.invalid_input",
    exit_code: exitCodeFor("usage_error"),
  });
}
