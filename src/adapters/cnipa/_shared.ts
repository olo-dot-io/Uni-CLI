/**
 * @owner       src::adapters::cnipa::_shared
 * @does        Shared helpers for CNIPA browser-driven adapter commands using the registry-owned browser page.
 * @needs       src/adapters/_shared/browser-tools.ts, src/engine/normalizer/patent-envelope.ts, src/types/patent.ts
 * @feeds       src/adapters/cnipa/search.ts, src/adapters/cnipa/get.ts, src/adapters/cnipa/legal-status.ts
 * @breaks      Browser navigation/evaluation errors bubble to the registry command boundary.
 * @invariants  Browser ownership stays with the invocation; no ambient outbound MCP resolver or implicit provider switch.
 * @side-effects Navigates and evaluates the registry-owned browser page.
 * @perf        n/a
 * @concurrency safe
 * @test        covered transitively by src/adapters/cnipa/*.test.ts
 * @stability   experimental
 * @since       2026-05-18
 * @verification browser-only
 */

import {
  evaluateDom,
  type BrowserDomResult,
} from "../_shared/browser-tools.js";
import { throwPatentAdapterError } from "../../engine/normalizer/patent-envelope.js";
import type { IPage } from "../../types.js";
import type { PatentErrorCode } from "../../types/patent.js";

export function cnipaEnvelope(
  code: PatentErrorCode,
  adapter_path: string,
  step: string,
  suggestion: string,
  alternatives: string[] = [],
): never {
  return throwPatentAdapterError({
    code,
    adapter_path,
    step,
    suggestion,
    alternatives,
    retryable: false,
  });
}

export async function navigateAndExtract<T>(
  page: IPage,
  url: string,
  expression: string,
): Promise<BrowserDomResult<T>> {
  return evaluateDom<T>(page, url, expression);
}

/**
 * Heuristic — CNIPA public-search captcha is a 验证码 iframe. When the
 * evaluator returns a zero-length result array, the safest assumption is
 * captcha; emit a structured envelope rather than a "no results" message
 * the agent cannot disambiguate.
 */
export function looksLikeCaptcha(
  rowCount: number,
  htmlMarker?: string,
): boolean {
  if (rowCount > 0) return false;
  if (!htmlMarker) return true; // empty result on a browser path = assume captcha
  const lowered = htmlMarker.toLowerCase();
  return (
    lowered.includes("captcha") ||
    lowered.includes("验证码") ||
    lowered.includes("verifycode")
  );
}
