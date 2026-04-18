/**
 * Invocation Complexity Score (ICS) — a scalar 0..10 capturing the TC0
 * state-tracking load that an LLM would need to reliably emit a given
 * shell invocation. The formula encodes the hypothesis in
 * `.claude/plans/sessions/2026-04-18-v213.2-tc0/task_plan.md` §2.1:
 *
 *   ICS = clip10(
 *       1.5 × max_quote_nest_depth    // mod-2 pairing is the TC0 bottleneck
 *     + 0.5 × backslash_escape_count  // escape pairing is also mod-2
 *     + 0.3 × nonascii_or_control_chars
 *     + 0.1 × total_arg_token_count
 *     + 2.0 × max_inline_json_depth    // worst case: nested JSON inline
 *   )
 *
 * Deterministic, cheap, and usable from both the bench harness and the
 * runtime `--explain-ics` debug path. No LLM calls, no fs access.
 */

export interface ICSBreakdown {
  quote_nest_depth: number;
  backslash_escape_count: number;
  nonascii_count: number;
  arg_token_count: number;
  inline_json_depth: number;
  /** The final clipped score. */
  score: number;
}

/** Maximum quote-nesting depth across both ' and " pairings in the source. */
function maxQuoteNestDepth(src: string): number {
  let max = 0;
  let cur = 0;
  const stack: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++; // skip escaped char, do not affect stack
      continue;
    }
    if (c === '"' || c === "'") {
      if (stack.length > 0 && stack[stack.length - 1] === c) {
        stack.pop();
        cur--;
      } else {
        stack.push(c);
        cur++;
        if (cur > max) max = cur;
      }
    }
  }
  return max;
}

/** Count backslash escape sequences. */
function countBackslashEscapes(src: string): number {
  let count = 0;
  for (let i = 0; i < src.length - 1; i++) {
    if (src[i] === "\\") {
      count++;
      i++; // skip the escaped char
    }
  }
  return count;
}

/** Count non-ASCII / control characters that agents hallucinate around. */
function countNonAsciiOrControl(src: string): number {
  let count = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c > 0x7e || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d)) {
      count++;
    }
  }
  return count;
}

/** Rough arg-token count by whitespace split, respecting quoting. */
function countArgTokens(src: string): number {
  let depth = 0;
  const tokens: string[] = [];
  let cur = "";
  for (const c of src) {
    if (c === '"' || c === "'") {
      depth = depth === 0 ? 1 : 0;
      cur += c;
    } else if (c === " " && depth === 0) {
      if (cur) tokens.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur) tokens.push(cur);
  return tokens.length;
}

/** Deepest inline JSON nesting `{…{…{…}}}`. Returns 0 if no braces. */
function maxInlineJsonDepth(src: string): number {
  let max = 0;
  let cur = 0;
  let inString = false;
  let stringDelim: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inString) {
      if (c === stringDelim) {
        inString = false;
        stringDelim = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringDelim = c;
      continue;
    }
    if (c === "{") {
      cur++;
      if (cur > max) max = cur;
    } else if (c === "}") {
      cur = Math.max(0, cur - 1);
    }
  }
  return max;
}

/** Compute the ICS for a given shell-level invocation string. */
export function computeICS(invocation: string): ICSBreakdown {
  const quote_nest_depth = maxQuoteNestDepth(invocation);
  const backslash_escape_count = countBackslashEscapes(invocation);
  const nonascii_count = countNonAsciiOrControl(invocation);
  const arg_token_count = countArgTokens(invocation);
  const inline_json_depth = maxInlineJsonDepth(invocation);

  const raw =
    1.5 * quote_nest_depth +
    0.5 * backslash_escape_count +
    0.3 * nonascii_count +
    0.1 * arg_token_count +
    2.0 * inline_json_depth;

  return {
    quote_nest_depth,
    backslash_escape_count,
    nonascii_count,
    arg_token_count,
    inline_json_depth,
    score: Math.min(10, Math.round(raw * 10) / 10),
  };
}

/** Bucket a score into the four bench categories. */
export function icsBucket(
  score: number,
): "trivial" | "moderate" | "hostile" | "pathological" {
  if (score < 2) return "trivial";
  if (score < 4) return "moderate";
  if (score < 6) return "hostile";
  return "pathological";
}
