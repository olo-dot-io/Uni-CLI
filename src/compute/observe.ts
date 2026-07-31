/**
 * @owner       src::compute::observe
 * @does        Rank the latest provider-owned compute refs for one natural-language goal without opening a GUI provider.
 * @needs       RefStore, bounded Top-K, and transport envelopes.
 * @feeds       compute observe across macOS, Windows, Linux, CLI, pipelines, and MCP.
 * @breaks      Provider-specific ranking creates platform drift; stale alias guessing can target a different window.
 * @invariants  Reads only the latest RefStore generations; optional app scope is exact; stable tie order follows RefStore order.
 * @side-effects None.
 * @perf        O(n log k) time and O(k + q) space for n live refs, k requested results, and q goal terms.
 * @concurrency Pure over the synchronous RefStore snapshot.
 * @test        tests/unit/compute-observe.test.ts, tests/unit/compute-dispatch.test.ts
 * @stability   experimental
 * @since       2026-07-31
 */

import { BoundedTopK } from "../core/bounded-top-k.js";
import { err, exitCodeFor, ok } from "../core/envelope.js";
import type { ActionResult } from "../transport/types.js";
import type { ElementRef, RefStore } from "../transport/refs.js";

export interface ComputeObserveCandidate {
  ref: string;
  stable: string;
  role: string;
  name?: string;
  value?: string;
  states?: readonly string[];
  app?: string;
  pid?: number;
  windowId?: number | string;
  score: number;
  matched: string[];
}

interface ScoredRef {
  candidate: ComputeObserveCandidate;
  ordinal: number;
}

export function observeComputeRefs(
  refs: RefStore,
  params: Readonly<Record<string, unknown>>,
): ActionResult<unknown> {
  const goal =
    typeof params.goal === "string"
      ? params.goal.trim()
      : String(params.goal ?? "").trim();
  if (!goal) {
    return invalidObserveInput(
      "goal must be a non-empty string",
      "pass the task intent to `unicli compute observe <goal>`",
    );
  }

  const topK = readTopK(params.topK);
  if (topK === undefined) {
    return invalidObserveInput(
      "topK must be an integer from 1 to 50",
      "pass --top-k between 1 and 50",
    );
  }
  const app =
    typeof params.app === "string" && params.app.trim()
      ? params.app.trim().toLocaleLowerCase()
      : undefined;
  const goalTerms = tokenize(goal);
  const ranked = new BoundedTopK<ScoredRef>(topK, compareBestRef);
  let evaluated = 0;

  for (const [ordinal, ref] of refs.list().entries()) {
    if (app && ref.app?.trim().toLocaleLowerCase() !== app) continue;
    evaluated += 1;
    const score = scoreRef(ref, goal, goalTerms);
    if (score.score <= 0) continue;
    ranked.add({
      candidate: {
        ref: ref.alias,
        stable: ref.stable,
        role: ref.role,
        ...(ref.name ? { name: ref.name } : {}),
        ...(ref.value ? { value: ref.value } : {}),
        ...(ref.states ? { states: ref.states } : {}),
        ...(ref.app ? { app: ref.app } : {}),
        ...(ref.pid !== undefined ? { pid: ref.pid } : {}),
        ...(ref.windowId !== undefined ? { windowId: ref.windowId } : {}),
        score: score.score,
        matched: score.matched,
      },
      ordinal,
    });
  }

  return ok({
    goal,
    ...(app ? { app } : {}),
    evaluated,
    candidates: ranked.values().map(({ candidate }) => candidate),
  });
}

function scoreRef(
  ref: ElementRef,
  goal: string,
  goalTerms: ReadonlySet<string>,
): { score: number; matched: string[] } {
  const normalizedGoal = normalize(goal);
  const fields = [
    ["name", ref.name, 6],
    ["role", ref.role, 4],
    ["value", ref.value, 3],
    ["state", ref.states?.join(" "), 2],
  ] as const;
  let score = 0;
  const matched = new Set<string>();

  for (const [field, raw, weight] of fields) {
    if (!raw) continue;
    const normalized = normalize(raw);
    if (normalized === normalizedGoal) {
      score += weight * 4;
      matched.add(`${field}:exact`);
    } else if (normalized.includes(normalizedGoal)) {
      score += weight * 2;
      matched.add(`${field}:phrase`);
    }
    const fieldTerms = tokenize(normalized);
    let hits = 0;
    for (const term of goalTerms) {
      if (fieldTerms.has(term)) hits += 1;
    }
    if (hits > 0) {
      score += weight * hits;
      matched.add(`${field}:tokens=${String(hits)}`);
    }
  }
  return { score, matched: [...matched] };
}

function compareBestRef(left: ScoredRef, right: ScoredRef): number {
  return (
    right.candidate.score - left.candidate.score || left.ordinal - right.ordinal
  );
}

function tokenize(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length > 0),
  );
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function readTopK(value: unknown): number | undefined {
  const number = value === undefined ? 5 : value;
  return typeof number === "number" &&
    Number.isSafeInteger(number) &&
    number >= 1 &&
    number <= 50
    ? number
    : undefined;
}

function invalidObserveInput(
  reason: string,
  suggestion: string,
): ActionResult<unknown> {
  return err({
    transport: "local-runtime",
    step: 0,
    action: "compute_observe",
    reason,
    suggestion,
    minimum_capability: "compute.compute_observe.invalid_input",
    exit_code: exitCodeFor("usage_error"),
  });
}
