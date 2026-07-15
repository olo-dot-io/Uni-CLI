/**
 * @owner       src/browser/invocation-context.ts
 * @does        Define and validate transport-independent identity for one browser invocation.
 * @needs       node:crypto
 * @feeds       src/browser/runtime-session.ts, src/browser/runtime-protocol.ts, src/mcp/handler.ts, src/commands/browser/runtime.ts
 * @breaks      BrowserInvocationContextError on malformed or conflicting caller identity.
 * @invariants  Agent-session and turn ids are non-empty bounded strings; transport metadata never enters command arguments.
 * @side-effects Uses the operating-system random source when a caller does not declare identity.
 * @perf        O(1) validation with at most three UUID allocations per anonymous invocation.
 * @concurrency Pure except for thread-safe random UUID generation.
 * @test        tests/unit/browser-invocation-context.test.ts, tests/unit/browser-runtime-session.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

export type BrowserInvocationTransport =
  | "cli"
  | "mcp-stdio"
  | "mcp-http"
  | "plugin"
  | "native-host"
  | "broker";

export interface BrowserInvocationContext {
  agent_session_id: string;
  turn_id: string;
  transport: BrowserInvocationTransport;
  profile_partition_id?: string;
}

export interface BrowserInvocationContextInput {
  transport: BrowserInvocationTransport;
  agentSessionId?: string;
  turnId?: string;
  profilePartitionId?: string;
  mcpSessionId?: string;
  metadata?: unknown;
}

export class BrowserInvocationContextError extends Error {
  readonly code = "browser_invocation_invalid";
  readonly suggestion =
    "Pass non-empty --session and --turn values, or use a client that forwards MCP session/turn metadata.";

  constructor(message: string) {
    super(message);
    this.name = "BrowserInvocationContextError";
  }
}

export function createBrowserInvocationContext(
  input: BrowserInvocationContextInput,
): BrowserInvocationContext {
  const codex = readCodexTurnMetadata(input.metadata);
  const agentSessionId = validateIdentity(
    input.agentSessionId ??
      codex?.thread_id ??
      codex?.session_id ??
      input.mcpSessionId ??
      `cli:${randomUUID()}`,
    "agent session",
  );
  const turnId = validateIdentity(
    input.turnId ?? codex?.turn_id ?? `turn:${randomUUID()}`,
    "turn",
  );
  const profilePartitionId = input.profilePartitionId
    ? validateIdentity(input.profilePartitionId, "profile partition")
    : undefined;

  return {
    agent_session_id: agentSessionId,
    turn_id: turnId,
    transport: input.transport,
    ...(profilePartitionId ? { profile_partition_id: profilePartitionId } : {}),
  };
}

interface CodexTurnMetadata {
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
}

function readCodexTurnMetadata(metadata: unknown): CodexTurnMetadata | null {
  if (!isRecord(metadata)) return null;
  const encoded = metadata["x-codex-turn-metadata"];
  if (encoded === undefined) return null;
  const parsed =
    typeof encoded === "string" ? parseJsonObject(encoded) : encoded;
  if (!isRecord(parsed)) {
    throw new BrowserInvocationContextError(
      "x-codex-turn-metadata must be an object or a JSON object string",
    );
  }
  return {
    session_id: optionalIdentity(parsed.session_id, "Codex session"),
    thread_id: optionalIdentity(parsed.thread_id, "Codex thread"),
    turn_id: optionalIdentity(parsed.turn_id, "Codex turn"),
  };
}

function parseJsonObject(encoded: string): unknown {
  try {
    return JSON.parse(encoded) as unknown;
  } catch (error) {
    throw new BrowserInvocationContextError(
      `x-codex-turn-metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function optionalIdentity(
  candidate: unknown,
  label: string,
): string | undefined {
  if (candidate === undefined || candidate === null) return undefined;
  if (typeof candidate !== "string") {
    throw new BrowserInvocationContextError(`${label} id must be a string`);
  }
  return validateIdentity(candidate, label);
}

function validateIdentity(candidate: string, label: string): string {
  const normalized = candidate.trim();
  if (normalized.length === 0) {
    throw new BrowserInvocationContextError(`${label} id must not be empty`);
  }
  if (normalized.length > 512) {
    throw new BrowserInvocationContextError(
      `${label} id exceeds the 512-character protocol limit`,
    );
  }
  if (/\p{Cc}/u.test(normalized)) {
    throw new BrowserInvocationContextError(
      `${label} id must not contain control characters`,
    );
  }
  return normalized;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate)
  );
}
