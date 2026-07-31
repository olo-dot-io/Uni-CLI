/**
 * @owner       src::adapters::fips::_shared
 * @does        Shared helpers for the Rospatent FIPS browser adapter (www.fips.ru) — no public API for Russian patents; the FIPS portal search is the only programmatic surface.
 * @needs       src/adapters/_shared/browser-tools.ts, src/engine/normalizer/patent-envelope.ts, src/types/patent.ts
 * @feeds       src/adapters/fips/*.ts
 * @breaks      none — pure helpers
 * @invariants  every error path surfaces as a PatentEnvelope row
 * @side-effects none
 * @perf        n/a
 * @concurrency safe
 * @test        covered transitively
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

export function fipsEnvelope(
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

export async function fipsNavigateAndExtract<T>(
  page: IPage,
  url: string,
  expression: string,
): Promise<BrowserDomResult<T>> {
  return evaluateDom<T>(page, url, expression);
}
