/**
 * Public error barrel for plugin authors.
 *
 * Stable surface since v0.213 — prefer importing from
 * `@zenalexa/unicli/errors` over reaching into private modules.
 */

export { PipelineError } from "./engine/executor.js";
export { NoTransportForStepError } from "./transport/bus.js";
export type { PipelineErrorDetail } from "./types.js";
export type {
  EnvelopeError,
  EnvelopeErr,
  EnvelopeOk,
  Envelope,
} from "./core/envelope.js";
