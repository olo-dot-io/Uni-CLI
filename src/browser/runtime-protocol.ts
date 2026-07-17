/**
 * @owner       src/browser/runtime-protocol.ts
 * @does        Define and validate the authenticated Browser Runtime Broker request, response, lifecycle, command-effect, status, and refusal wire contracts.
 * @needs       src/browser/invocation-context.ts, runtime-session.ts, managed-browser.ts, remote-browser.ts, chrome-provider.ts, chrome-native-protocol.ts
 * @feeds       src/browser/runtime-broker.ts, src/browser/runtime-transport.ts, native browser host and CLI/MCP clients
 * @breaks      Protocol consumers reject unknown versions, malformed identities, unknown actions, and structured broker or Chrome extension errors.
 * @invariants  Authentication is outside tool arguments; every request has one id; Chrome extension errors use the shared strict bounded validator; active turns renew an explicit broker lease; every target response carries authoritative ownership and exact Chrome tab/window identity when applicable; provider-wide Chrome search is read-only and target-free; hidden/background/foreground, provider selection, cancellation effect classification, outcome ambiguity, and unusable targets are explicit.
 * @side-effects none
 * @perf        O(wire payload size) validation, with collection and string bounds enforced by the schemas.
 * @concurrency Request ids allow independent in-flight clients; target ordering is broker-owned, not encoded in transport.
 * @test        tests/unit/browser-runtime-protocol.test.ts, tests/integration/browser-runtime-broker.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import type { BrowserInvocationContext } from "./invocation-context.js";
import type { ChromeProviderStatus } from "./chrome-provider.js";
import {
  CHROME_CONTENT_SEARCH_MAX_CHARS_PER_TAB,
  CHROME_CONTENT_SEARCH_MAX_RESULTS,
  CHROME_CONTENT_SEARCH_MAX_TABS,
  CHROME_NATIVE_PRODUCT,
  CHROME_NATIVE_PROTOCOL,
  CHROME_NATIVE_PROTOCOL_VERSION,
  isChromeNativeError,
  type ChromeNativeError,
  type ChromeNativeHello,
  type ChromeNativeResult,
  type ChromeContentSearchQuery,
} from "./chrome-native-protocol.js";
import type { ManagedBrowserRuntimeStatus } from "./managed-browser.js";
import type { RemoteBrowserStatus } from "./remote-browser.js";
import type {
  BrowserRuntimeRegistryStatus,
  BrowserTargetLease,
  BrowserVisibility,
} from "./runtime-session.js";
import { z } from "zod";

export const BROWSER_BROKER_PRODUCT = "unicli";
export const BROWSER_BROKER_PROTOCOL = "unicli-browser-runtime";
export const BROWSER_BROKER_PROTOCOL_VERSION = 5;
export const BROWSER_BROKER_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const BROWSER_BROKER_MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
export const BROWSER_BROKER_DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000;
export const BROWSER_BROKER_SHUTDOWN_WAIT_MS = 150_000;

export type BrowserPageCommand =
  | { method: "navigate"; url: string; settle_ms?: number }
  | { method: "evaluate"; expression: string }
  | { method: "click"; selector: string; snapshot_id?: string }
  | { method: "native_click"; x: number; y: number }
  | {
      method: "type";
      selector: string;
      text: string;
      mode?: "insert_text" | "keystrokes";
      snapshot_id?: string;
    }
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
      clip?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
    }
  | {
      method: "cdp";
      cdp_method: string;
      params?: Record<string, unknown>;
      session_id?: string;
    }
  | { method: "set_file_input"; selector: string; files: string[] }
  | { method: "network_capture_start"; pattern?: string }
  | { method: "network_capture_read" }
  | { method: "downloads_read"; limit?: number }
  | { method: "dialog_read"; clear_recent?: boolean }
  | {
      method: "dialog_respond";
      action: "accept" | "dismiss";
      prompt_text?: string;
      dialog_id?: string;
    }
  | { method: "agent_presence"; visible: boolean; label?: string }
  | {
      method: "agent_cursor";
      x: number;
      y: number;
      visible?: boolean;
    };

export interface BrowserAgentPresenceResult {
  status: "visible" | "hidden" | "inactive" | "out_of_bounds";
  cursor_visible: boolean;
  viewport_width: number;
  viewport_height: number;
  x?: number;
  y?: number;
}

export function isBrowserAgentPresenceResult(
  value: unknown,
): value is BrowserAgentPresenceResult {
  if (!isUnknownRecord(value)) return false;
  const status = value.status;
  const cursorVisible = value.cursor_visible;
  const width = value.viewport_width;
  const height = value.viewport_height;
  const x = value.x;
  const y = value.y;
  if (
    (status !== "visible" &&
      status !== "hidden" &&
      status !== "inactive" &&
      status !== "out_of_bounds") ||
    typeof cursorVisible !== "boolean" ||
    !nonnegativeFinite(width) ||
    !nonnegativeFinite(height) ||
    !optionalNonnegativeFinite(x) ||
    !optionalNonnegativeFinite(y) ||
    (x === undefined) !== (y === undefined)
  ) {
    return false;
  }
  if (status === "hidden" || status === "inactive") {
    return cursorVisible === false && x === undefined;
  }
  if (status === "out_of_bounds") {
    return x !== undefined && y !== undefined && (x >= width || y >= height);
  }
  if (x !== undefined && (x >= width || y! >= height)) return false;
  return cursorVisible === false || x !== undefined;
}

function nonnegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalNonnegativeFinite(
  value: unknown,
): value is number | undefined {
  return value === undefined || nonnegativeFinite(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const READ_ONLY_BROWSER_PAGE_COMMANDS = new Set<BrowserPageCommand["method"]>([
  "cookies",
  "downloads_read",
  "screenshot",
  "snapshot",
  "title",
  "url",
]);

export function browserPageCommandCanMutate(
  command: BrowserPageCommand,
): boolean {
  if (command.method === "network_capture_read") return true;
  if (command.method === "dialog_read") {
    return command.clear_recent === true;
  }
  return !READ_ONLY_BROWSER_PAGE_COMMANDS.has(command.method);
}

export function browserPageCommandRequiresForegroundChrome(
  command: BrowserPageCommand,
): boolean {
  return (
    command.method === "agent_presence" || command.method === "agent_cursor"
  );
}

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

export interface BrowserTurnTouchRequest extends BrowserBrokerRequestBase {
  action: "turn.touch";
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

interface BrowserTargetCommandRequestBase extends BrowserBrokerRequestBase {
  action: "target.command";
  context: BrowserInvocationContext;
  target_id?: string;
  visibility: BrowserVisibility;
  profile_partition_id: string;
  command: BrowserPageCommand;
}

export interface ManagedBrowserTargetCommandRequest extends BrowserTargetCommandRequestBase {
  provider: "managed";
  visibility: "hidden";
  isolated: boolean;
  ephemeral: boolean;
  profile_id?: string;
}

export interface ChromeBrowserTargetCommandRequest extends BrowserTargetCommandRequestBase {
  provider: "chrome";
  visibility: "background" | "foreground";
}

export interface RemoteBrowserTargetCommandRequest extends BrowserTargetCommandRequestBase {
  provider: "remote";
  visibility: "hidden";
}

export type BrowserTargetCommandRequest =
  | ManagedBrowserTargetCommandRequest
  | ChromeBrowserTargetCommandRequest
  | RemoteBrowserTargetCommandRequest;

export interface BrowserTargetDiscardRequest extends BrowserBrokerRequestBase {
  action: "target.discard";
  context: BrowserInvocationContext;
  target_id: string;
}

export interface BrowserTargetHandoffRequest extends BrowserBrokerRequestBase {
  action: "target.handoff";
  target_id: string;
  from: BrowserInvocationContext;
  to: BrowserInvocationContext;
}

export interface BrowserChromeTabsListRequest extends BrowserBrokerRequestBase {
  action: "chrome.tabs.list";
  context: BrowserInvocationContext;
}

export interface BrowserChromeContentSearchRequest extends BrowserBrokerRequestBase {
  action: "chrome.content.search";
  context: BrowserInvocationContext;
  search: ChromeContentSearchQuery;
}

export interface BrowserChromeTargetClaimRequest extends BrowserBrokerRequestBase {
  action: "chrome.target.claim";
  context: BrowserInvocationContext;
  tab_id: number;
  visibility: "background" | "foreground";
  profile_partition_id: string;
}

export interface BrowserChromeTargetFinalizeRequest extends BrowserBrokerRequestBase {
  action: "chrome.target.finalize";
  context: BrowserInvocationContext;
  target_id: string;
  disposition?: "close" | "release";
}

export interface BrowserChromeHostRegisterRequest extends BrowserBrokerRequestBase {
  action: "chrome.host.register";
  host_instance_id: string;
  hello: ChromeNativeHello;
}

export interface BrowserChromeHostPollRequest extends BrowserBrokerRequestBase {
  action: "chrome.host.poll";
  host_instance_id: string;
}

export interface BrowserChromeHostHeartbeatRequest extends BrowserBrokerRequestBase {
  action: "chrome.host.heartbeat";
  host_instance_id: string;
}

export interface BrowserChromeHostResultRequest extends BrowserBrokerRequestBase {
  action: "chrome.host.result";
  host_instance_id: string;
  result: ChromeNativeResult;
}

export interface BrowserChromeHostDisconnectRequest extends BrowserBrokerRequestBase {
  action: "chrome.host.disconnect";
  host_instance_id: string;
}

export type BrowserBrokerRequest =
  | BrowserBrokerStatusRequest
  | BrowserBrokerShutdownRequest
  | BrowserSessionStartRequest
  | BrowserTurnTouchRequest
  | BrowserTurnEndRequest
  | BrowserSessionEndRequest
  | BrowserTargetCommandRequest
  | BrowserTargetDiscardRequest
  | BrowserTargetHandoffRequest
  | BrowserChromeTabsListRequest
  | BrowserChromeContentSearchRequest
  | BrowserChromeTargetClaimRequest
  | BrowserChromeTargetFinalizeRequest
  | BrowserChromeHostRegisterRequest
  | BrowserChromeHostPollRequest
  | BrowserChromeHostHeartbeatRequest
  | BrowserChromeHostResultRequest
  | BrowserChromeHostDisconnectRequest;

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
  outcome_ambiguous?: true;
  target_unusable?: true;
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
  provider: "managed" | "chrome" | "remote";
  browser_pid?: number;
  visibility: BrowserVisibility;
  owned: boolean;
  tab_id?: number;
  window_id?: number;
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
  lifecycle: "running" | "shutting_down";
  sessions: BrowserRuntimeRegistryStatus;
  providers: {
    managed: ManagedBrowserRuntimeStatus[];
    chrome: ChromeProviderStatus;
    remote: RemoteBrowserStatus;
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

export interface BrowserSessionStartResult {
  agent_session_id: string;
  turn_id: string;
  session_ttl_ms: number;
}

const invocationContextSchema = z
  .object({
    agent_session_id: z.string().trim().min(1).max(512),
    turn_id: z.string().trim().min(1).max(512),
    transport: z.enum([
      "cli",
      "mcp-stdio",
      "mcp-http",
      "plugin",
      "native-host",
      "broker",
    ]),
    profile_partition_id: z.string().trim().min(1).max(512).optional(),
    upstream_turn_id: z.string().trim().min(1).max(512).optional(),
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
    .object({
      method: z.literal("click"),
      selector: z.string().min(1),
      snapshot_id: z.string().uuid().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("native_click"),
      x: z.number().finite().nonnegative(),
      y: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      method: z.literal("type"),
      selector: z.string().min(1),
      text: z.string(),
      mode: z.enum(["insert_text", "keystrokes"]).optional(),
      snapshot_id: z.string().uuid().optional(),
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
      clip: z
        .object({
          x: z.number().finite().nonnegative(),
          y: z.number().finite().nonnegative(),
          width: z.number().finite().positive(),
          height: z.number().finite().positive(),
        })
        .strict()
        .optional(),
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
  z
    .object({
      method: z.literal("downloads_read"),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("dialog_read"),
      clear_recent: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("dialog_respond"),
      action: z.enum(["accept", "dismiss"]),
      prompt_text: z.string().optional(),
      dialog_id: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("agent_presence"),
      visible: z.boolean(),
      label: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("agent_cursor"),
      x: z.number().finite().nonnegative(),
      y: z.number().finite().nonnegative(),
      visible: z.boolean().optional(),
    })
    .strict(),
]);

const requestIdSchema = z.string().trim().min(1).max(512);

const chromeNativeTargetSchema = z
  .object({
    target_id: z.string().trim().min(1).max(512),
    tab_id: z.number().int().nonnegative(),
    window_id: z.number().int().nonnegative(),
    owned: z.boolean(),
    visibility: z.enum(["background", "foreground"]),
    url: z.string().optional(),
    title: z.string().optional(),
  })
  .strict();

const chromeNativeHelloSchema = z
  .object({
    type: z.literal("hello"),
    product: z.literal(CHROME_NATIVE_PRODUCT),
    protocol: z.literal(CHROME_NATIVE_PROTOCOL),
    version: z.literal(CHROME_NATIVE_PROTOCOL_VERSION),
    extension_id: z.string().trim().min(1).max(128),
    extension_version: z.string().trim().min(1).max(128),
    browser_session_id: z.string().uuid(),
    targets: z.array(chromeNativeTargetSchema).max(10_000),
  })
  .strict();

const chromeNativeErrorSchema = z.custom<ChromeNativeError>(
  isChromeNativeError,
  "Invalid Chrome native error",
);

const chromeNativeResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      type: z.literal("result"),
      request_id: requestIdSchema,
      ok: z.literal(true),
      data: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("result"),
      request_id: requestIdSchema,
      ok: z.literal(false),
      error: chromeNativeErrorSchema,
    })
    .strict(),
]);

const brokerRequestSchema = z.union([
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
      action: z.literal("turn.touch"),
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
      visibility: z.literal("hidden"),
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
      action: z.literal("target.discard"),
      context: invocationContextSchema,
      target_id: z.string().trim().min(1).max(512),
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("target.command"),
      context: invocationContextSchema,
      target_id: z.string().trim().min(1).max(512).optional(),
      provider: z.literal("remote"),
      visibility: z.literal("hidden"),
      profile_partition_id: z.string().trim().min(1).max(512),
      command: pageCommandSchema,
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("target.command"),
      context: invocationContextSchema,
      target_id: z.string().trim().min(1).max(512).optional(),
      provider: z.literal("chrome"),
      visibility: z.enum(["background", "foreground"]),
      profile_partition_id: z.string().trim().min(1).max(512),
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
  z
    .object({
      id: requestIdSchema,
      action: z.literal("chrome.tabs.list"),
      context: invocationContextSchema,
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("chrome.content.search"),
      context: invocationContextSchema,
      search: z
        .object({
          query: z.string().trim().min(1).max(512),
          include_history: z.boolean().optional(),
          max_results: z
            .number()
            .int()
            .min(1)
            .max(CHROME_CONTENT_SEARCH_MAX_RESULTS)
            .optional(),
          max_tabs: z
            .number()
            .int()
            .min(1)
            .max(CHROME_CONTENT_SEARCH_MAX_TABS)
            .optional(),
          max_chars_per_tab: z
            .number()
            .int()
            .min(1_024)
            .max(CHROME_CONTENT_SEARCH_MAX_CHARS_PER_TAB)
            .optional(),
          history_start_time: z.number().finite().nonnegative().optional(),
          history_end_time: z.number().finite().nonnegative().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("chrome.target.claim"),
      context: invocationContextSchema,
      tab_id: z.number().int().nonnegative(),
      visibility: z.enum(["background", "foreground"]),
      profile_partition_id: z.string().trim().min(1).max(512),
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("chrome.target.finalize"),
      context: invocationContextSchema,
      target_id: z.string().trim().min(1).max(512),
      disposition: z.enum(["close", "release"]).optional(),
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("chrome.host.register"),
      host_instance_id: z.string().uuid(),
      hello: chromeNativeHelloSchema,
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("chrome.host.poll"),
      host_instance_id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("chrome.host.heartbeat"),
      host_instance_id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("chrome.host.result"),
      host_instance_id: z.string().uuid(),
      result: chromeNativeResultSchema,
    })
    .strict(),
  z
    .object({
      id: requestIdSchema,
      action: z.literal("chrome.host.disconnect"),
      host_instance_id: z.string().uuid(),
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
