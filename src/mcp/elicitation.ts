/**
 * MCP Elicitation — request user input during tool execution.
 *
 * Elicitation allows a tool call to pause and ask the user a question
 * (e.g. "Which account?" or "Please authorize at this URL"). The client
 * collects the answer and returns it via `elicitation/response`.
 *
 * Two modes:
 *   - **Form mode**: `requestedSchema` defines a JSON Schema form the
 *     client should render. The response contains `content` matching
 *     that schema.
 *   - **URL mode** (SEP-1036): `url` redirects the user to a URL for
 *     out-of-band input (e.g. OAuth consent). The response signals
 *     completion via `action: 'accept'`.
 *
 * Current scope: capability declaration + protocol types + pending
 * request store. Actual triggering from adapters is a future task.
 */

// ── Protocol Types ─────────────────────────────────────────────────────────

export interface ElicitationSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

export interface ElicitationSchema {
  type: "object";
  properties: Record<string, ElicitationSchemaProperty>;
  required?: string[];
}

export interface ElicitationRequestParams {
  message: string;
  requestedSchema?: ElicitationSchema;
  /** URL mode (SEP-1036): redirect user for out-of-band input */
  url?: string;
}

export interface ElicitationRequest {
  method: "elicitation/request";
  params: ElicitationRequestParams;
}

export type ElicitationAction = "accept" | "decline" | "cancel";

export interface ElicitationResponse {
  content?: Record<string, unknown>;
  action: ElicitationAction;
}

// ── Pending Request Store ──────────────────────────────────────────────────

/**
 * In-flight elicitation requests awaiting user response.
 *
 * Key: request ID (matches the JSON-RPC id of the elicitation/request).
 * Value: resolve callback that the waiting tool call is blocked on.
 */
const pendingElicitations = new Map<
  string | number,
  (response: ElicitationResponse) => void
>();

/**
 * Register a pending elicitation. Returns a promise that resolves when
 * the client sends `elicitation/response` with the matching ID.
 */
const ELICITATION_TIMEOUT_MS = 300_000; // 5 minutes

export function registerElicitation(
  id: string | number,
): Promise<ElicitationResponse> {
  return new Promise<ElicitationResponse>((resolve) => {
    pendingElicitations.set(id, resolve);
    setTimeout(() => {
      if (pendingElicitations.has(id)) {
        pendingElicitations.delete(id);
        resolve({ action: "cancel" });
      }
    }, ELICITATION_TIMEOUT_MS).unref();
  });
}

/**
 * Resolve a pending elicitation with the client's response.
 * Returns `true` if the ID matched a pending request, `false` otherwise.
 */
export function resolveElicitation(
  id: string | number,
  response: ElicitationResponse,
): boolean {
  const resolver = pendingElicitations.get(id);
  if (!resolver) return false;
  pendingElicitations.delete(id);
  resolver(response);
  return true;
}

/**
 * Number of elicitations currently awaiting a response.
 * Useful for diagnostics / health checks.
 */
export function pendingElicitationCount(): number {
  return pendingElicitations.size;
}
