/**
 * Observe — preview ranked candidate browser actions before executing.
 *
 * Modeled on Stagehand's `observe()` (packages/core/lib/v3/v3.ts:540): the
 * caller asks "what should I click to do X?" and gets back a small ranked
 * list of `{action, ref, selector, confidence}` candidates. The agent (or
 * human) then commits with `unicli operate click <ref>`.
 *
 * Why a separate verb (vs. just clicking the first match)?
 *   1. **Self-healing**: when a selector breaks, the next-best candidate
 *      is one ref away.
 *   2. **Auditability**: the candidates list goes into a JSONL cache so
 *      future runs can compare against past candidates and detect drift.
 *   3. **LLM grounding (future)**: the heuristic ranker is good for
 *      obvious cases; ambiguous queries can later route through an LLM.
 *
 * The ranker here is intentionally pure (no DOM access) so it can be
 * unit-tested. The browser-side code is responsible for snapshotting and
 * extracting the candidate list — this file scores it.
 */

export interface ObserveCandidate {
  /**
   * Imperative action to take next. Defaults to `click` for non-input
   * elements; the input verb is `type` for textboxes / textareas.
   */
  action: "click" | "type" | "select" | "press";
  /** Numeric ref from the snapshot — pass back to `operate click <ref>`. */
  ref: number;
  /** CSS selector for the same node. */
  selector: string;
  /** Original tag name (`a`, `button`, `input`, ...) */
  tag: string;
  /** Best human-readable label for the element (text or aria). */
  label: string;
  /** 0..1 confidence that this candidate matches the query. */
  confidence: number;
  /** Why we matched (token overlap, exact label, role match). */
  reason: string;
}

/** A snapshot ref entry as produced by `generateSnapshotJs({ raw: true })`. */
export interface SnapshotRef {
  ref: number;
  tag: string;
  text: string;
  /** Optional attribute bag — populated when the snapshot was extended. */
  attrs?: Record<string, string>;
}

/**
 * Tokenize a query / label into lowercased word tokens. Strips most
 * punctuation. Empty input returns []; the caller decides how to handle
 * a no-tokens query (we treat it as "match nothing", which falls through
 * to confidence 0).
 */
export function tokenize(s: string): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Score a single candidate against the query tokens. Returns a number in
 * 0..1 plus a short reason explaining the match strength.
 *
 * Scoring rules (additive, capped at 1):
 *   - Exact label match (case-insensitive)              → 0.95
 *   - All query tokens present in label                 → 0.85
 *   - Some query tokens present in label                → 0.4 + (matched/total) * 0.4
 *   - Query token matches the tag (e.g. "button")       → +0.15
 *   - Query token matches the role attribute            → +0.10
 */
export function scoreCandidate(
  ref: SnapshotRef,
  queryTokens: string[],
): { confidence: number; reason: string } {
  if (queryTokens.length === 0)
    return { confidence: 0, reason: "no query tokens" };

  const labelTokens = tokenize(ref.text);
  const labelStr = ref.text.toLowerCase().trim();
  const queryStr = queryTokens.join(" ");

  let confidence = 0;
  const reasons: string[] = [];

  // Exact match wins outright
  if (labelStr && labelStr === queryStr) {
    return { confidence: 0.95, reason: "exact label match" };
  }

  // All query tokens in label.
  //
  // Substring matching is only allowed for query tokens with length >= 3,
  // otherwise short tokens like "on" produce false positives against any
  // label containing "continue", "cancel", or similar. Short tokens fall
  // back to exact equality, which is the strictest possible match.
  const matched = queryTokens.filter((q) => {
    if (q.length < 3) {
      return labelTokens.some((l) => l === q);
    }
    return labelTokens.some(
      (l) => l === q || l.includes(q) || (l.length >= 3 && q.includes(l)),
    );
  });
  const ratio = matched.length / queryTokens.length;

  if (ratio === 1 && queryTokens.length > 0) {
    confidence = 0.85;
    reasons.push("all query tokens in label");
  } else if (ratio > 0) {
    confidence = 0.4 + ratio * 0.4;
    reasons.push(`${matched.length}/${queryTokens.length} tokens in label`);
  }

  // Tag bonus — "button submit" boosts <button>
  if (queryTokens.includes(ref.tag.toLowerCase())) {
    confidence += 0.15;
    reasons.push(`tag=${ref.tag}`);
  }

  // Role attr bonus
  const role = ref.attrs?.role;
  if (role && queryTokens.includes(role.toLowerCase())) {
    confidence += 0.1;
    reasons.push(`role=${role}`);
  }

  // Aria-label bonus — treat as label fallback
  const aria = ref.attrs?.["aria-label"];
  if (aria) {
    const ariaTokens = tokenize(aria);
    const ariaMatched = queryTokens.filter((q) => ariaTokens.includes(q));
    if (ariaMatched.length > 0) {
      confidence += 0.1;
      reasons.push("aria-label match");
    }
  }

  if (confidence > 1) confidence = 1;
  return {
    confidence,
    reason: reasons.length > 0 ? reasons.join(", ") : "no signal",
  };
}

/**
 * Pick the action verb based on tag. Inputs and textareas get `type`;
 * selects get `select`; everything else gets `click`.
 */
export function actionForTag(tag: string): ObserveCandidate["action"] {
  const t = tag.toLowerCase();
  if (t === "input" || t === "textarea") return "type";
  if (t === "select") return "select";
  return "click";
}

/**
 * Score every snapshot ref against the query and return top-K.
 * Candidates with confidence == 0 are dropped.
 */
export function rankCandidates(
  refs: SnapshotRef[],
  query: string,
  topK = 5,
): ObserveCandidate[] {
  const queryTokens = tokenize(query);
  const scored: ObserveCandidate[] = [];
  for (const ref of refs) {
    const { confidence, reason } = scoreCandidate(ref, queryTokens);
    if (confidence <= 0) continue;
    scored.push({
      action: actionForTag(ref.tag),
      ref: ref.ref,
      selector: `[data-unicli-ref="${ref.ref}"]`,
      tag: ref.tag,
      label: ref.text || ref.attrs?.["aria-label"] || `<${ref.tag}>`,
      confidence: Number(confidence.toFixed(3)),
      reason,
    });
  }
  scored.sort((a, b) => b.confidence - a.confidence);
  return scored.slice(0, topK);
}
