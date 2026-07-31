/**
 * @owner       src::adapters::cipo::_shared
 * @does        Shared helpers for the CIPO Canadian Patents Database browser adapter — emits structured envelopes for MCP-bus / not-found / schema-drift gaps.
 * @needs       src/adapters/_shared/browser-tools.ts, src/engine/normalizer/patent-envelope.ts, src/types/patent.ts
 * @feeds       src/adapters/cipo/*.ts
 * @breaks      none — pure helpers
 * @invariants  every error path emits a PatentEnvelope row
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

export function cipoEnvelope(
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

export async function cipoNavigateAndExtract<T>(
  page: IPage,
  url: string,
  expression: string,
): Promise<BrowserDomResult<T>> {
  return evaluateDom<T>(page, url, expression);
}
