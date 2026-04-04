/**
 * Core type definitions for unicli adapter system.
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

export interface AdapterArg {
  name: string;
  type?: "str" | "int" | "float" | "bool";
  default?: unknown;
  required?: boolean;
  positional?: boolean;
  choices?: string[];
  description?: string;
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

  // Execution — exactly one of these
  pipeline?: PipelineStep[];
  adapterArgs?: AdapterArg[];
  func?: (page: IPage, kwargs: Record<string, unknown>) => Promise<unknown>;

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
  ): Promise<void>;

  // Evaluation
  evaluate(script: string): Promise<unknown>;

  // Waiting
  wait(seconds: number): Promise<void>;
  waitForSelector(selector: string, timeout?: number): Promise<void>;
  waitFor(condition: number | string, timeout?: number): Promise<void>;

  // Interaction
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  press(key: string, modifiers?: string[]): Promise<void>;
  insertText(text: string): Promise<void>;
  scroll(direction: "down" | "up" | "bottom" | "top"): Promise<void>;
  autoScroll(opts?: { maxScrolls?: number; delay?: number }): Promise<void>;

  // Native CDP input (coordinate-based)
  nativeClick(x: number, y: number): Promise<void>;
  nativeKeyPress(key: string, modifiers?: string[]): Promise<void>;
  setFileInput(selector: string, files: string[]): Promise<void>;

  // Data extraction
  cookies(): Promise<Record<string, string>>;
  title(): Promise<string>;
  url(): Promise<string>;
  snapshot(opts?: SnapshotOptions): Promise<string>;
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;
  networkRequests(): Promise<NetworkRequest[]>;

  // Lifecycle
  addInitScript(source: string): Promise<void>;
  sendCDP(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
  closeWindow(): Promise<void>;
}

/** Resolved command ready for execution */
export interface ResolvedCommand {
  adapter: AdapterManifest;
  command: AdapterCommand;
  args: Record<string, unknown>;
}

/** Output format options */
export type OutputFormat = "table" | "json" | "yaml" | "csv" | "md";

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
