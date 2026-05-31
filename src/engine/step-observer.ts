/**
 * @owner       src::engine::step-observer
 * @does        Per-step observation record + sink contract so a pipeline run is
 *              auditable step-by-step without changing the result/error envelope.
 * @needs       none (pure types + summarizer)
 * @feeds       src::engine::executor (emits), src::engine::session (persists)
 * @breaks      never throws; summarizeOutput is total over all inputs
 * @invariants  one observation per executed step; record() must not throw
 * @side-effects none (pure)
 * @perf        O(1) per observation; summarizeOutput does not deep-traverse data
 * @concurrency pure data; observer implementations own their own synchronization
 * @test        tests/unit/engine/step-observer.test.ts
 * @stability   experimental
 * @since       2026-05-30
 */

/**
 * A bounded, leak-free description of a step's output. We record the SHAPE of
 * `ctx.data`, never the data itself — raw payloads can be large and carry
 * secrets (the full replay payload lives behind the recorder's `secret`
 * channel, not here). `size` is the array length, string length, or object key
 * count; absent for scalars.
 */
export interface StepOutputSummary {
  kind: "array" | "object" | "string" | "number" | "boolean" | "empty";
  size?: number;
}

/**
 * One executed pipeline step's auditable outcome. Additive side-channel: it
 * never alters the AgentEnvelope contract, it only makes the black box between
 * steps observable.
 */
export interface StepObservation {
  /** Zero-based index in the pipeline `steps[]` array. */
  index: number;
  /** The step action name (e.g. "fetch", "select"). */
  action: string;
  status: "ok" | "error";
  /** Wall-clock duration of the step, milliseconds (monotonic clock). */
  durationMs: number;
  /** Shape of `ctx.data` after the step ran. Present when status === "ok". */
  output?: StepOutputSummary;
  /** PipelineError errorType (or coarse class) when status === "error". */
  errorType?: string;
  /** Human/agent-readable failure message when status === "error". */
  errorMessage?: string;
}

/**
 * Sink for step observations. Implementations MUST NOT throw — observation is a
 * side channel that can never break or alter a run (same invariant the run
 * recorder documents). Callers are still expected to guard against a
 * misbehaving observer.
 */
export interface StepObserver {
  record(observation: StepObservation): void;
}

/**
 * Classify the shape of pipeline data without traversing or copying it.
 * Total: every input maps to exactly one summary. Pipeline data is JSON-shaped
 * in practice; non-JSON references (function/symbol) are reported as "object".
 */
export function summarizeOutput(data: unknown): StepOutputSummary {
  if (data === null || data === undefined) return { kind: "empty" };
  if (Array.isArray(data)) return { kind: "array", size: data.length };
  const t = typeof data;
  if (t === "string") return { kind: "string", size: (data as string).length };
  if (t === "number" || t === "bigint") return { kind: "number" };
  if (t === "boolean") return { kind: "boolean" };
  if (t === "object") {
    return { kind: "object", size: Object.keys(data as object).length };
  }
  return { kind: "object" };
}
