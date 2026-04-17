/**
 * Agent-Native Markdown renderer — turns an AgentEnvelope into a
 * frontmatter + sectioned markdown document for LLM consumption.
 *
 * Task 2 will implement the body. Task 1 only stubs the signature
 * so callers can start importing and Task 3 can wire formatter.ts.
 */

import type { AgentEnvelope } from "./envelope.js"; // AgentEnvelope is the discriminated union

export function renderMd(_envelope: AgentEnvelope): string {
  throw new Error("TODO: Task 2 — implement renderMd()");
}
