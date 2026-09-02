/**
 * @owner       src::core::command-availability
 * @does        Evaluate declared command configuration prerequisites for discovery and execution.
 * @needs       Portable command availability types and a caller-provided environment snapshot.
 * @feeds       Registry, fast discovery, describe, retrieval, MCP, and invocation kernel.
 * @breaks      Provider commands can leak into discovery or reach the network without required configuration.
 * @invariants  Evaluation is local and side-effect free; provider availability is never inferred by probing a remote service.
 * @side-effects None.
 * @perf        O(required environment variables) per command.
 * @concurrency Pure evaluation is safe for concurrent callers.
 * @test        tests/unit/command-availability.test.ts
 * @stability   stable
 * @since       2026-08-21
 */

import type { AdapterCommand, CommandAvailability } from "../types.js";

export interface CommandAvailabilityState {
  state: "ready" | "missing_configuration";
  ready: boolean;
  discovery: "always" | "configured";
  required_environment: string[];
  missing_environment: string[];
  setup_url?: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function evaluateCommandAvailability(
  availability: CommandAvailability | undefined,
  environment: Environment = process.env,
): CommandAvailabilityState {
  const requiredEnvironment = [...(availability?.environment ?? [])];
  const missingEnvironment = requiredEnvironment.filter(
    (name) => !environment[name]?.trim(),
  );
  const ready = missingEnvironment.length === 0;
  return {
    state: ready ? "ready" : "missing_configuration",
    ready,
    discovery: availability?.discovery ?? "always",
    required_environment: requiredEnvironment,
    missing_environment: missingEnvironment,
    ...(availability?.setup_url ? { setup_url: availability.setup_url } : {}),
  };
}

export function isCommandDiscoverable(
  command: Pick<AdapterCommand, "availability">,
  environment: Environment = process.env,
): boolean {
  const state = evaluateCommandAvailability(command.availability, environment);
  return state.discovery === "always" || state.ready;
}

export class CommandUnavailableError extends Error {
  readonly code = "auth_required";
  readonly retryable = false;
  readonly alternatives: string[] = [];
  readonly suggestion: string;

  constructor(
    readonly command_ref: string,
    readonly availability: CommandAvailabilityState,
  ) {
    const variables = availability.missing_environment.join(", ");
    super(`${command_ref} requires environment configuration: ${variables}.`);
    this.name = "CommandUnavailableError";
    this.suggestion = [
      `Set ${variables} in the Uni-CLI process and retry.`,
      availability.setup_url
        ? `Provider setup: ${availability.setup_url}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  }
}

export function assertCommandAvailable(
  commandRef: string,
  command: Pick<AdapterCommand, "availability">,
  environment: Environment = process.env,
): void {
  const state = evaluateCommandAvailability(command.availability, environment);
  if (!state.ready) throw new CommandUnavailableError(commandRef, state);
}
