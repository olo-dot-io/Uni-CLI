/**
 * @owner   src::core::update-notice
 * @does    Carries one process-local update recommendation into every Agent envelope.
 * @needs   Current and latest semantic versions plus public upgrade commands.
 * @feeds   output envelopes, Markdown rendering, CLI update checks, MCP and ACP responses.
 * @breaks  Missing update metadata leaves non-interactive Agents unaware that their installed command surface is stale.
 * @invariants The notice is informational, uses an exact target version, and never performs an update by itself.
 * @side-effects Stores one process-local immutable notice.
 * @perf    O(1) reads and writes.
 * @concurrency One CLI process owns one active release notice.
 * @test    tests/unit/update-notice.test.ts
 * @stability public Agent response metadata.
 * @since   2026-08-10
 */

import type { AutomaticUpdateDecision } from "../engine/update-auto.js";

export interface AgentUpdateNotice {
  status: "available";
  current: string;
  latest: string;
  interactive_command: string;
  unattended_command: string;
  decline_command: string;
  release_notes: string;
  automatic_update?: AutomaticUpdateDecision;
}

let activeNotice: AgentUpdateNotice | undefined;

export function setActiveUpdateNotice(notice: AgentUpdateNotice): void {
  activeNotice = Object.freeze({ ...notice });
}

export function getActiveUpdateNotice(): AgentUpdateNotice | undefined {
  return activeNotice ? { ...activeNotice } : undefined;
}

export function clearActiveUpdateNotice(): void {
  activeNotice = undefined;
}

export function buildAgentUpdateNotice(
  current: string,
  latest: string,
  automaticUpdate?: AutomaticUpdateDecision,
): AgentUpdateNotice {
  return {
    status: "available",
    current,
    latest,
    interactive_command: "unicli upgrade",
    unattended_command: "unicli upgrade --yes",
    decline_command: "unicli upgrade --no",
    release_notes: `https://github.com/olo-dot-io/Uni-CLI/releases/tag/v${latest}`,
    ...(automaticUpdate ? { automatic_update: automaticUpdate } : {}),
  };
}
