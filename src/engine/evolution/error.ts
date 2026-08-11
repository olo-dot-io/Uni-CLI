export type EvolutionErrorCode =
  | "invalid_session_id"
  | "session_not_found"
  | "invalid_session"
  | "io_error"
  | "run_not_found"
  | "run_target_mismatch"
  | "run_metadata_missing"
  | "adapter_not_editable"
  | "candidate_invalid"
  | "source_not_found"
  | "invalid_state"
  | "mutation_eval_blocked"
  | "replay_unavailable"
  | "eval_not_found"
  | "eval_adapter_mismatch"
  | "invalid_case"
  | "candidate_changed"
  | "destination_changed"
  | "not_eligible"
  | "not_promoted";

export class EvolutionError extends Error {
  constructor(
    public readonly code: EvolutionErrorCode,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "EvolutionError";
  }
}
