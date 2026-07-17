/**
 * Core type definitions for unicli adapter system.
 * @owner       src::types
 * @does        Define adapter manifests, browser-page operations, pipeline steps, and shared output/network contracts.
 * @needs       TypeScript standard types only.
 * @feeds       Every adapter, engine, browser provider, command, and transport.
 * @breaks      Compile-time contract mismatches across public Uni-CLI surfaces.
 * @invariants  Every potentially blocking page operation and TypeScript command function accepts caller-owned request cancellation without making cleanup cancellable.
 * @side-effects none
 * @perf        Type-only declarations.
 * @concurrency AbortSignal parameters carry caller ownership across asynchronous page and command operations.
 * @test        npm run typecheck and browser/engine behavior suites
 * @stability   stable
 * @since       2026-04-01
 *
 * Five adapter types cover the full spectrum:
 *   web-api   → REST API calls (public or authenticated via browser cookies)
 *   desktop   → Local desktop software via subprocess
 *   browser   → Full browser automation (navigate, interact, extract)
 *   bridge    → Passthrough to existing CLI tools (gh, docker, etc.)
 *   service   → Local/remote HTTP services (Ollama, ComfyUI, etc.)
 */

export enum AdapterType {
  WEB_API = "web-api",
  DESKTOP = "desktop",
  BROWSER = "browser",
  BRIDGE = "bridge",
  SERVICE = "service",
}

export enum Strategy {
  PUBLIC = "public",
  COOKIE = "cookie",
  HEADER = "header",
  INTERCEPT = "intercept",
  UI = "ui",
}

export type TargetSurface = "web" | "desktop" | "system" | "mobile";
export type BrowserSessionPreference = "auto" | "user" | "cdp";

export interface CommandExecutionContext {
  signal?: AbortSignal;
}

export type SocialCapability =
  | "read"
  | "search"
  | "trends"
  | "comments"
  | "comment_replies"
  | "write_comment"
  | "write_post"
  | "reactions"
  | "shares"
  | "saves"
  | "messages"
  | "lists"
  | "moderation"
  | "media"
  | "download"
  | "subtitles"
  | "author"
  | "user_content"
  | "relations"
  | "notifications"
  | "analytics";

export interface AdapterArg {
  name: string;
  type?: "str" | "int" | "float" | "bool";
  default?: unknown;
  required?: boolean;
  positional?: boolean;
  choices?: string[];
  description?: string;
  /**
   * JSON Schema draft-2020-12 `format:` vocabulary (standard). Validated
   * fail-closed via ajv's format-assertion vocabulary — a declared `format`
   * is a hard precondition, not an annotation. See v0.213.3 spec §D5.
   */
  format?:
    | "uri"
    | "uuid"
    | "date"
    | "date-time"
    | "email"
    | "hostname"
    | "ipv4"
    | "ipv6"
    | "regex";
  /**
   * Bespoke `x-unicli-kind:` extension — dispatches to the harden-step
   * validators that have no standard JSON Schema equivalent.
   *
   * - `path`          → filesystem sandbox (no traversal, NUL, or CWD/$HOME escape)
   * - `adapter-ref`   → `<site>/<command>` shaped token
   * - `selector`      → CSS/XPath-ish; reject `<script` or unescaped backtick
   * - `shell-safe`    → reject `$` `` ` `` `;` `|` `&` `>` (command-injection vector)
   * - `id`            → bare resource token (no URL punctuation `?` `#` or
   *                     `%XX` percent-escapes); pair with `x-unicli-accepts:
   *                     [url]` on adapters (zhihu, douban, jike…) whose `id`
   *                     arg also accepts a full URL.
   */
  "x-unicli-kind"?: "path" | "adapter-ref" | "selector" | "shell-safe" | "id";
  /**
   * Dual-accept fallback — if the primary kind fails validation, try each
   * listed secondary kind before rejecting. Used by adapters whose `id` arg
   * legitimately accepts URL slugs (zhihu, twitter) or vice versa.
   */
  "x-unicli-accepts"?: Array<"url" | "id">;
}

export interface OutputSchema {
  type?: "array" | "object" | "string";
  items?: Record<string, string>;
  agentHint?: string;
  maxItems?: number;
  compact?: boolean;
}

export interface PipelineStep {
  [action: string]: unknown;
}

export interface AdapterCommand {
  name: string;
  description?: string;
  /** Source adapter file used in repair and evidence-bearing error envelopes. */
  adapter_path?: string;
  /**
   * Runtime target surface. TS helper commands can operate on desktop apps
   * even when their registration helper keeps the site in a web-api manifest.
   */
  target_surface?: TargetSurface;

  /**
   * When true, the adapter is quarantined: skipped by `unicli test` and the
   * CI conformance suite, and shown with a `[quarantined]` tag in `unicli list`.
   * Use this to park adapters whose upstream API changed until an agent repairs
   * them — keeps CI green without hiding the adapter from discovery.
   */
  quarantine?: boolean;
  /** Human-readable reason for quarantine, surfaced in `unicli list`. */
  quarantineReason?: string;

  /**
   * Schema-v2 capability token the dispatcher must support to run this
   * command (e.g. `http.fetch`, `desktop-ax.applescript`). Shape is
   * `<transport>.<step>`. Used by the adapter-health probe to gate
   * platform-specific adapters without invoking them, and by the
   * future runtime dispatcher for capability-aware routing.
   */
  minimum_capability?: string;

  /**
   * Schema-v2 capability tokens this command can execute. Carries pipeline
   * step names (`http.fetch`, `cdp-browser.evaluate`, …) and vertical
   * capability tags (`patent.search`, `patent.family`, …). The vertical
   * tags allow meta-commands to discover relevant adapters via the registry
   * without each meta-command hard-coding a site list.
   */
  capabilities?: string[];

  /**
   * Local executable names the command may invoke when it declares a
   * subprocess capability. This makes approval scopes and agent-facing command
   * contracts name the actual binary instead of falling back to the site name.
   */
  executables?: string[];

  /**
   * When true, the command accepts `--cursor <next_cursor>` for pagination
   * and surfaces `meta.pagination.next_cursor` in its envelope. The kernel
   * uses this flag to add a pagination hint to the success `next_actions`.
   */
  paginated?: boolean;

  // Execution — exactly one of these
  pipeline?: PipelineStep[];
  adapterArgs?: AdapterArg[];
  strategy?: Strategy;
  browser?: boolean;
  browserSession?: BrowserSessionPreference;
  domain?: string;
  base?: string;
  func?: (
    page: IPage,
    kwargs: Record<string, unknown>,
    context: CommandExecutionContext,
  ) => Promise<unknown>;

  // For web-api type
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path?: string;
  url?: string;
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;

  // For browser type
  navigate?: string;
  wait?: string;
  extract?: string;

  // For desktop type — subprocess args
  execArgs?: string[];

  // Output
  output?: string | OutputSchema;
  columns?: string[];
  socialCapabilities?: SocialCapability[];
  defaultFormat?: "table" | "json" | "yaml" | "csv" | "md";
  stream?: boolean;
}

export interface AdapterManifest {
  name: string;
  displayName?: string;
  type: AdapterType;
  description?: string;
  version?: string;

  // Connection
  domain?: string;
  base?: string;
  binary?: string;
  detect?: string;
  health?: string;

  // Auth
  strategy?: Strategy;
  auth?: "cookie" | "header" | "oauth2" | "apikey" | "none";
  authCookies?: string[];
  requires?: string;

  // Browser
  browser?: boolean;
  antiDetect?: boolean;

  // Auto-install for bridge type
  autoInstall?: string;
  passthrough?: boolean;

  // Commands
  commands: Record<string, AdapterCommand>;

  // Metadata
  category?: string;
  contributor?: string;
  contributorUrl?: string;
  deprecated?: boolean | string;
  replacedBy?: string;
}

/** Snapshot options for DOM accessibility tree */
export interface SnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
  maxRefs?: number;
  raw?: boolean;
}

/** Screenshot capture options */
export interface ScreenshotOptions {
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
  path?: string;
}

/** Captured network request */
export interface NetworkRequest {
  url: string;
  method: string;
  status: number;
  type: string;
  size: number;
  timestamp: number;
  remoteIPAddress?: string;
  remotePort?: number;
}

/** Download result merged into each item */
export interface DownloadResult {
  status: "success" | "skipped" | "failed";
  path?: string;
  size?: number;
  error?: string;
  duration?: number;
}

/** Browser page abstraction for browser-type adapters */
export interface IPage {
  // Navigation
  goto(
    url: string,
    options?: { settleMs?: number; waitUntil?: string },
    signal?: AbortSignal,
  ): Promise<void>;

  // Evaluation
  evaluate(script: string, signal?: AbortSignal): Promise<unknown>;

  // Waiting
  wait(seconds: number, signal?: AbortSignal): Promise<void>;
  waitForSelector(
    selector: string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<void>;
  waitFor(
    condition: number | string,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<void>;

  // Interaction
  click(selector: string, signal?: AbortSignal): Promise<void>;
  type(selector: string, text: string, signal?: AbortSignal): Promise<void>;
  press(key: string, modifiers?: string[], signal?: AbortSignal): Promise<void>;
  insertText(text: string, signal?: AbortSignal): Promise<void>;
  scroll(
    direction: "down" | "up" | "bottom" | "top",
    signal?: AbortSignal,
  ): Promise<void>;
  autoScroll(
    opts?: { maxScrolls?: number; delay?: number },
    signal?: AbortSignal,
  ): Promise<void>;

  // Native CDP input (coordinate-based)
  nativeClick(x: number, y: number, signal?: AbortSignal): Promise<void>;
  nativeKeyPress(
    key: string,
    modifiers?: string[],
    signal?: AbortSignal,
  ): Promise<void>;
  setFileInput(
    selector: string,
    files: string[],
    signal?: AbortSignal,
  ): Promise<void>;

  // Data extraction
  cookies(signal?: AbortSignal): Promise<Record<string, string>>;
  title(signal?: AbortSignal): Promise<string>;
  url(signal?: AbortSignal): Promise<string>;
  snapshot(opts?: SnapshotOptions, signal?: AbortSignal): Promise<string>;
  screenshot(opts?: ScreenshotOptions, signal?: AbortSignal): Promise<Buffer>;
  networkRequests(signal?: AbortSignal): Promise<NetworkRequest[]>;

  // Lifecycle
  addInitScript(source: string, signal?: AbortSignal): Promise<void>;
  sendCDP(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  close(): Promise<void>;
  closeWindow(): Promise<void>;
}

/** Resolved command ready for execution */
export interface ResolvedCommand {
  adapter: AdapterManifest;
  command: AdapterCommand;
  args: Record<string, unknown>;
}

/**
 * Output format options.
 *
 * v0.212: `table` is deprecated — callers passing `-f table` get a
 * stderr warning and fall back to `md`. The type still lists `table`
 * during the deprecation window so existing call-sites keep compiling.
 * `compact` is the new agent-token-optimized format.
 */
export type OutputFormat = "table" | "json" | "yaml" | "csv" | "md" | "compact";

/** Structured error detail for AI agent consumption */
export interface PipelineErrorDetail {
  step: number;
  action: string;
  config: unknown;
  errorType:
    | "http_error"
    | "selector_miss"
    | "empty_result"
    | "parse_error"
    | "network_error"
    | "timeout"
    | "expression_error"
    | "assertion_failed"
    | "stale_ref"
    | "ambiguous"
    | "ref_not_found";
  url?: string;
  statusCode?: number;
  responsePreview?: string;
  suggestion: string;
  /** true for transient failures (timeout, 429, 5xx), false for permanent (404, auth, config) */
  retryable?: boolean;
  /** Fallback commands the agent can try when this command fails */
  alternatives?: string[];
}

/** Exit codes following sysexits.h */
export const ExitCode = {
  SUCCESS: 0,
  GENERIC_ERROR: 1,
  USAGE_ERROR: 2,
  EMPTY_RESULT: 66,
  SERVICE_UNAVAILABLE: 69,
  TEMP_FAILURE: 75,
  AUTH_REQUIRED: 77,
  CONFIG_ERROR: 78,
} as const;
