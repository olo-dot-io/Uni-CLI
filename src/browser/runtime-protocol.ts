/**
 * @owner       src/browser/runtime-protocol.ts
 * @does        Define the authenticated Browser Runtime Broker request, response, lifecycle, command, status, and refusal wire contracts.
 * @needs       src/browser/invocation-context.ts, src/browser/runtime-session.ts, src/browser/managed-browser.ts
 * @feeds       src/browser/runtime-broker.ts, src/browser/runtime-transport.ts, native browser host and CLI/MCP clients
 * @breaks      Protocol consumers reject unknown versions, malformed identities, unknown actions, and structured broker errors.
 * @invariants  Authentication is outside tool arguments; every request has one id; hidden/background/foreground and provider selection are explicit.
 * @side-effects none (types and constants only)
 * @perf        O(1) serialization shape.
 * @concurrency Request ids allow independent in-flight clients; target ordering is broker-owned, not encoded in transport.
 * @test        tests/unit/browser-runtime-protocol.test.ts, tests/integration/browser-runtime-broker.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import type { BrowserInvocationContext } from "./invocation-context.js";
import type { ManagedBrowserRuntimeStatus } from "./managed-browser.js";
import type {
  BrowserRuntimeRegistryStatus,
  BrowserTargetLease,
  BrowserVisibility,
} from "./runtime-session.js";
import { z } from "zod";

export const BROWSER_BROKER_PRODUCT = "unicli";
export const BROWSER_BROKER_PROTOCOL = "unicli-browser-runtime";
export const BROWSER_BROKER_PROTOCOL_VERSION = 1;
export const BROWSER_BROKER_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const BROWSER_BROKER_DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000;

export type BrowserPageCommand =
  | { method: "navigate"; url: string; settle_ms?: number }
  | { method: "evaluate"; expression: string }
  | { method: "click"; selector: string }
  | { method: "type"; selector: string; text: string }
  | { method: "press"; key: string; modifiers?: string[] }
  | { method: "insert_text"; text: string }
  | { method: "scroll"; direction: "down" | "up" | "bottom" | "top" }
  | { method: "cookies" }
  | { method: "title" }
  | { method: "url" }
  | { method: "snapshot"; options?: Record<string, unknown> }
  | {
      method: "screenshot";
      format?: "png" | "jpeg" | "webp";
      quality?: number;
      full_page?: boolean;
    }
  | {
      method: "cdp";
      cdp_method: string;
      params?: Record<string, unknown>;
      session_id?: string;
    }
  | { method: "set_file_input"; selector: string; files: string[] }
  | { method: "network_capture_start"; pattern?: string }
  | { method: "network_capture_read" };

interface BrowserBrokerRequestBase {
  id: string;
}

export interface BrowserBrokerStatusRequest extends BrowserBrokerRequestBase {
  action: "broker.status";
}

export interface BrowserBrokerShutdownRequest extends BrowserBrokerRequestBase {
  action: "broker.shutdown";
}

export interface BrowserSessionStartRequest extends BrowserBrokerRequestBase {
  action: "session.start";
  context: BrowserInvocationContext;
}

export interface BrowserTurnEndRequest extends BrowserBrokerRequestBase {
  action: "turn.end";
  context: BrowserInvocationContext;
}

export interface BrowserSessionEndRequest extends BrowserBrokerRequestBase {
  action: "session.end";
  agent_session_id: string;
}

export interface BrowserTargetCommandRequest extends BrowserBrokerRequestBase {
  action: "target.command";
  context: BrowserInvocationContext;
  target_id?: string;
  provider: "managed";
  visibility: BrowserVisibility;
  profile_partition_id: string;
  isolated: boolean;
  ephemeral: boolean;
  profile_id?: string;
  command: BrowserPageCommand;
}

export interface BrowserTargetHandoffRequest extends BrowserBrokerRequestBase {
  action: "target.handoff";
  target_id: string;
  from: BrowserInvocationContext;
  to: BrowserInvocationContext;
}

export type BrowserBrokerRequest =
  | BrowserBrokerStatusRequest
  | BrowserBrokerShutdownRequest
  | BrowserSessionStartRequest
  | BrowserTurnEndRequest
  | BrowserSessionEndRequest
  | BrowserTargetCommandRequest
  | BrowserTargetHandoffRequest;

export interface BrowserBrokerWireRequest {
  product: typeof BROWSER_BROKER_PRODUCT;
  protocol: typeof BROWSER_BROKER_PROTOCOL;
  version: typeof BROWSER_BROKER_PROTOCOL_VERSION;
  auth_token: string;
  request: BrowserBrokerRequest;
}

export interface BrowserBrokerError {
  code: string;
  message: string;
  suggestion: string;
  retryable: boolean;
}

export interface BrowserBrokerResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: BrowserBrokerError;
}

export interface BrowserTargetCommandResult {
  target_id: string;
  runtime_id: string;
  browser_pid: number;
  visibility: BrowserVisibility;
  data?: unknown;
}

export interface BrowserBrokerStatus {
  ok: true;
  product: typeof BROWSER_BROKER_PRODUCT;
  protocol: typeof BROWSER_BROKER_PROTOCOL;
  version: typeof BROWSER_BROKER_PROTOCOL_VERSION;
  runtime_id: string;
  broker_pid: number;
  uptime_ms: number;
  session_ttl_ms: number;
  sessions: BrowserRuntimeRegistryStatus;
  providers: {
    managed: ManagedBrowserRuntimeStatus[];
    chrome_connected: boolean;
  };
}

export interface BrowserBrokerEndpointDescriptor {
  product: typeof BROWSER_BROKER_PRODUCT;
  protocol: typeof BROWSER_BROKER_PROTOCOL;
  version: typeof BROWSER_BROKER_PROTOCOL_VERSION;
  runtime_id: string;
  pid: number;
  socket_path: string;
  auth_token: string;
  started_at: string;
}

export interface BrowserSessionEndResult {
  agent_session_id: string;
  released_targets: BrowserTargetLease[];
}

const invocationContextSchema = z
  .object({
    agent_session_id: z.string().trim().min(1).max(512),
    turn_id: z.string().trim().min(1).max(512),
    transport: z.enum([
      "cli",
      "mcp-stdio",
      "mcp-http",
      "native-host",
      "broker",
    ]),
    profile_partition_id: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

const recordSchema = z.record(z.string(), z.unknown());

const pageCommandSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("navigate"),
      url: z.url(),
      settle_ms: z.number().finite().nonnegative().optional(),
    })
    .strict(),
  z.object({ method: z.literal("evaluate"), expression: z.string() }).strict(),
  z
    .object({ method: z.literal("click"), selector: z.string().min(1) })
    .strict(),
  z
    .object({
      method: z.literal("type"),
      selector: z.string().min(1),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      method: z.literal("press"),
      key: z.string().min(1),
      modifiers: z.array(z.string()).optional(),
    })
    .strict(),
  z.object({ method: z.literal("insert_text"), text: z.string() }).strict(),
  z
    .object({
      method: z.literal("scroll"),
      direction: z.enum(["down", "up", "bottom", "top"]),
    })
    .strict(),
  z.object({ method: z.literal("cookies") }).strict(),
  z.object({ method: z.literal("title") }).strict(),
  z.object({ method: z.literal("url") }).strict(),
  z
    .object({ method: z.literal("snapshot"), options: recordSchema.optional() })
    .strict(),
  z
    .object({
      method: z.literal("screenshot"),
      format: z.enum(["png", "jpeg", "webp"]).optional(),
      quality: z.number().int().min(0).max(100).optional(),
      full_page: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("cdp"),
      cdp_method: z.string().min(1),
      params: recordSchema.optional(),
      session_id: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("set_file_input"),
      selector: z.string().min(1),
      files: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      method: z.literal("network_capture_start"),
      pattern: z.string().optional(),
    })
    .strict(),
  z.object({ method: z.literal("network_capture_read") }).strict(),
]);

const requestIdSchema = z.string().trim().min(1).max(512);

const brokerRequestSchema = z.discriminatedUnion("action", [
  z
    .object({ id: requestIdSchema, action: z.literal("broker.status") })
    .strict(),
  z
    .object({ id: requestIdSchema, action: z.literal("broker.shutdown") })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("session.start"),
      context: invocationContextSchema,
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("turn.end"),
      context: invocationContextSchema,
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("session.end"),
      agent_session_id: z.string().trim().min(1).max(512),
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("target.command"),
      context: invocationContextSchema,
      target_id: z.string().trim().min(1).max(512).optional(),
      provider: z.literal("managed"),
      visibility: z.enum(["hidden", "background", "foreground"]),
      profile_partition_id: z.string().trim().min(1).max(512),
      isolated: z.boolean(),
      ephemeral: z.boolean(),
      profile_id: z.string().trim().min(1).max(512).optional(),
      command: pageCommandSchema,
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("target.handoff"),
      target_id: z.string().trim().min(1).max(512),
      from: invocationContextSchema,
      to: invocationContextSchema,
    })
    .strict(),
]);

export const browserBrokerWireRequestSchema = z
  .object({
    product: z.literal(BROWSER_BROKER_PRODUCT),
    protocol: z.literal(BROWSER_BROKER_PROTOCOL),
    version: z.literal(BROWSER_BROKER_PROTOCOL_VERSION),
    auth_token: z.string().min(32).max(256),
    request: brokerRequestSchema,
  })
  .strict() satisfies z.ZodType<BrowserBrokerWireRequest>;

export const browserBrokerEndpointDescriptorSchema = z
  .object({
    product: z.literal(BROWSER_BROKER_PRODUCT),
    protocol: z.literal(BROWSER_BROKER_PROTOCOL),
    version: z.literal(BROWSER_BROKER_PROTOCOL_VERSION),
    runtime_id: z.string().uuid(),
    pid: z.number().int().positive(),
    socket_path: z.string().min(1),
    auth_token: z.string().min(32).max(256),
    started_at: z.iso.datetime(),
  })
  .strict() satisfies z.ZodType<BrowserBrokerEndpointDescriptor>;
