/**
 * Public error barrel for plugin authors.
 *
 * Stable surface since v0.213 — prefer importing from
 * `@zenalexa/unicli/errors` over reaching into private modules.
 *
 * Exposes both the thrown error classes (`PipelineError`,
 * `NoTransportForStepError`) and the envelope construction helpers
 * (`err`, `ok`, `EnvelopeExit`, `exitCodeFor`) so plugins can build
 * uniform `Envelope<T>` payloads without reaching into internals.
 */

export { PipelineError } from "./engine/executor.js";
export { NoTransportForStepError } from "./transport/bus.js";
export type { PipelineErrorDetail } from "./types.js";

// Envelope construction surface.
export { err, ok, exitCodeFor, EnvelopeExit } from "./core/envelope.js";
export type {
  Envelope,
  EnvelopeOk,
  EnvelopeErr,
  EnvelopeError,
  EnvelopeMeta,
  EnvelopeExitCode,
  ErrInput,
} from "./core/envelope.js";
