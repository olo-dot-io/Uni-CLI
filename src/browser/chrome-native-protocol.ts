/**
 * @owner       src/browser/chrome-native-protocol.ts
 * @does        Define the versioned Chrome extension/native-host command, result, durable target inventory, tab, bounded content-search, and error contract shared by broker, host, extension, and tests.
 * @needs       src/browser/runtime-protocol.ts (type only)
 * @feeds       src/browser/chrome-provider.ts, native-host-main.ts, extension/src/background.ts, extension/src/chrome-controller.ts
 * @breaks      Consumers reject unknown product/protocol/version, malformed commands/results, mismatched request ids, and unsupported visibility states.
 * @invariants  Native messages are request-correlated; hello reports the extension's reconciled target ledger; background is explicit; provider-wide content search never claims a target; target allocation/claim/finalization is separate from page mutation; extension and host abandon a command generation before the broker's consumer deadline.
 * @side-effects none (constants and types only)
 * @perf        O(1) serialization shape; native framing enforces the byte limit separately.
 * @concurrency One native host executes commands sequentially while the broker preserves per-target ordering.
 * @test        tests/unit/chrome-native-framing.test.ts, tests/integration/browser-extension-background.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import type { BrowserPageCommand } from "./runtime-protocol.js";

export const CHROME_NATIVE_PRODUCT = "unicli";
export const CHROME_NATIVE_PROTOCOL = "unicli-chrome-native";
export const CHROME_NATIVE_PROTOCOL_VERSION = 3;
export const CHROME_NATIVE_HOST_NAME = "io.unicli.browser";
export const CHROME_EXTENSION_ID = "decklegbfaimflikbihddclmbiiaiakg";
export const CHROME_NATIVE_MAX_HOST_TO_EXTENSION_BYTES = 1024 * 1024;
export const CHROME_NATIVE_MAX_EXTENSION_TO_HOST_BYTES = 64 * 1024 * 1024;
export const CHROME_NATIVE_COMMAND_DEADLINE_MS = 110_000;
export const CHROME_CONTENT_SEARCH_DEFAULT_MAX_RESULTS = 20;
export const CHROME_CONTENT_SEARCH_DEFAULT_MAX_TABS = 50;
export const CHROME_CONTENT_SEARCH_DEFAULT_MAX_CHARS_PER_TAB = 120_000;
export const CHROME_CONTENT_SEARCH_MAX_RESULTS = 100;
export const CHROME_CONTENT_SEARCH_MAX_TABS = 200;
export const CHROME_CONTENT_SEARCH_MAX_CHARS_PER_TAB = 500_000;

export interface ChromeNativeHello {
  type: "hello";
  product: typeof CHROME_NATIVE_PRODUCT;
  protocol: typeof CHROME_NATIVE_PROTOCOL;
  version: typeof CHROME_NATIVE_PROTOCOL_VERSION;
  extension_id: string;
  extension_version: string;
  browser_session_id: string;
  targets: ChromeNativeTarget[];
}

export interface ChromeNativeTab {
  tab_id: number;
  window_id: number;
  url?: string;
  title?: string;
  active: boolean;
  last_accessed?: number;
}

export interface ChromeNativeTarget {
  target_id: string;
  tab_id: number;
  window_id: number;
  owned: boolean;
  visibility: "background" | "foreground";
  url?: string;
  title?: string;
}

export interface ChromeContentSearchQuery {
  query: string;
  include_history?: boolean;
  max_results?: number;
  max_tabs?: number;
  max_chars_per_tab?: number;
  history_start_time?: number;
  history_end_time?: number;
}

export type ChromeContentSearchSource = "open_tab" | "history";

export interface ChromeContentSearchMatch {
  sources: ChromeContentSearchSource[];
  url: string;
  title?: string;
  score: number;
  match_fields: Array<"title" | "url" | "content">;
  snippets?: string[];
  tab_id?: number;
  window_id?: number;
  active?: boolean;
  last_accessed?: number;
  last_visit_time?: number;
  visit_count?: number;
}

export interface ChromeContentSearchFailure {
  source: "open_tab";
  tab_id: number;
  url?: string;
  code: string;
  message: string;
}

export interface ChromeContentSearchResult {
  query: string;
  result_count: number;
  eligible_open_tabs: number;
  scanned_open_tabs: number;
  matched_open_tabs: number;
  failed_open_tabs: number;
  scanned_history_items: number;
  matched_history_items: number;
  ui_state_unchanged: true;
  truncated: boolean;
  limits: {
    max_results: number;
    max_tabs: number;
    max_chars_per_tab: number;
    tab_concurrency: number;
    max_frames_per_tab: number;
  };
  results: ChromeContentSearchMatch[];
  failures: ChromeContentSearchFailure[];
}

interface ChromeNativeCommandBase {
  type: "command";
  request_id: string;
}

export type ChromeNativeCommand =
  | (ChromeNativeCommandBase & { action: "tabs.list" })
  | (ChromeNativeCommandBase & {
      action: "content.search";
      search: ChromeContentSearchQuery;
    })
  | (ChromeNativeCommandBase & {
      action: "target.allocate";
      visibility: "background" | "foreground";
    })
  | (ChromeNativeCommandBase & {
      action: "target.claim";
      tab_id: number;
      visibility: "background" | "foreground";
    })
  | (ChromeNativeCommandBase & {
      action: "target.finalize";
      target_id: string;
      tab_id: number;
      visibility: "background" | "foreground";
      disposition: "close" | "release";
    })
  | (ChromeNativeCommandBase & {
      action: "page.command";
      target_id: string;
      tab_id: number;
      visibility: "background" | "foreground";
      command: BrowserPageCommand;
    });

export type ChromeNativeBrokerCommand =
  | ChromeNativeCommand
  | (ChromeNativeCommandBase & { action: "host.shutdown" });

export interface ChromeNativeError {
  code: string;
  message: string;
  suggestion: string;
  retryable: boolean;
  outcome_ambiguous?: boolean;
  target_unusable?: boolean;
}

interface ChromeNativeResultBase {
  type: "result";
  request_id: string;
}

export type ChromeNativeResult =
  | (ChromeNativeResultBase & {
      ok: true;
      data?: unknown;
      error?: never;
    })
  | (ChromeNativeResultBase & {
      ok: false;
      data?: never;
      error: ChromeNativeError;
    });

export type ChromeNativeMessage =
  | ChromeNativeHello
  | ChromeNativeCommand
  | ChromeNativeResult;

export function chromeTargetId(
  browserSessionId: string,
  tabId: number,
): string {
  return `chrome-target:${browserSessionId}:${String(tabId)}`;
}
