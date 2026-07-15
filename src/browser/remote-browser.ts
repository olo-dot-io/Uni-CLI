/**
 * @owner       src/browser/remote-browser.ts
 * @does        Own broker-lifetime remote CDP page connections and expose their target/status lifecycle without local browser fallback.
 * @needs       node:crypto, src/browser/cdp-client.ts, page.ts
 * @feeds       src/browser/runtime-broker.ts, runtime-protocol.ts
 * @breaks      RemoteBrowserError on missing/malformed configuration, connection failure, unknown targets, and teardown failure.
 * @invariants  Remote endpoints are explicit, hidden-only, secret-redacted in status, and never replaced by a local provider.
 * @side-effects Opens authenticated remote WebSocket connections and closes them on target/session/broker teardown.
 * @perf        One remote CDP connection per owned target; status is O(targets).
 * @concurrency Distinct remote targets own distinct CDP clients; broker queues serialize commands per target.
 * @test        tests/unit/remote-browser.test.ts, tests/integration/browser-remote-provider.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import { CDPClient, type RemoteEndpoint } from "./cdp-client.js";
import { BrowserPage } from "./page.js";

export interface RemoteBrowserStatus {
  configured: boolean;
  endpoint_origin?: string;
  configuration_error?: string;
  target_count: number;
  visibility: "hidden";
}

interface RemoteBrowserProviderOptions {
  endpoint?: RemoteEndpoint | null;
  env?: NodeJS.ProcessEnv;
}

interface RemoteTarget {
  page: BrowserPage;
}

type RemoteBrowserErrorCode =
  | "remote_browser_unavailable"
  | "remote_browser_configuration_invalid"
  | "remote_browser_connect_failed"
  | "remote_browser_target_not_found"
  | "remote_browser_shutdown_failed";

export class RemoteBrowserError extends Error {
  readonly retryable: boolean;
  readonly suggestion: string;

  constructor(
    readonly code: RemoteBrowserErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RemoteBrowserError";
    this.retryable = code === "remote_browser_connect_failed";
    this.suggestion = suggestionFor(code);
  }
}

export class RemoteBrowserProvider {
  private readonly endpoint: RemoteEndpoint | null;
  private readonly targets = new Map<string, RemoteTarget>();

  constructor(options: RemoteBrowserProviderOptions = {}) {
    this.endpoint =
      options.endpoint === undefined
        ? readRemoteEndpoint(options.env ?? process.env)
        : options.endpoint;
  }

  async acquireTarget(): Promise<string> {
    if (!this.endpoint) {
      throw new RemoteBrowserError(
        "remote_browser_unavailable",
        "The remote browser provider is not configured",
      );
    }
    let client: CDPClient;
    try {
      client = await CDPClient.connectToRemote(
        this.endpoint.endpoint,
        this.endpoint.headers,
      );
    } catch (error) {
      throw new RemoteBrowserError(
        "remote_browser_connect_failed",
        `Remote CDP connection failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const targetId = `remote:${randomUUID()}`;
    this.targets.set(targetId, { page: new BrowserPage(client) });
    return targetId;
  }

  getPage(targetId: string): BrowserPage {
    const target = this.targets.get(targetId);
    if (target) return target.page;
    throw new RemoteBrowserError(
      "remote_browser_target_not_found",
      `Remote browser target not found: ${targetId}`,
    );
  }

  async releaseTarget(targetId: string): Promise<void> {
    const target = this.targets.get(targetId);
    if (!target) return;
    try {
      await target.page.close();
      this.targets.delete(targetId);
    } catch (error) {
      throw new RemoteBrowserError(
        "remote_browser_shutdown_failed",
        `Remote browser target ${targetId} did not close cleanly: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  status(): RemoteBrowserStatus {
    return {
      configured: this.endpoint !== null,
      ...(this.endpoint
        ? { endpoint_origin: redactEndpoint(this.endpoint.endpoint) }
        : {}),
      target_count: this.targets.size,
      visibility: "hidden",
    };
  }

  async close(): Promise<void> {
    let closeError: unknown;
    for (const targetId of this.targets.keys()) {
      try {
        await this.releaseTarget(targetId);
      } catch (error) {
        closeError ??= error;
      }
    }
    if (closeError) throw closeError;
  }
}

export function readRemoteEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): RemoteEndpoint | null {
  const endpoint = env.UNICLI_CDP_ENDPOINT?.trim();
  if (!endpoint) return null;
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch (error) {
    throw new RemoteBrowserError(
      "remote_browser_configuration_invalid",
      `UNICLI_CDP_ENDPOINT is not a valid URL: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (parsedEndpoint.protocol !== "ws:" && parsedEndpoint.protocol !== "wss:") {
    throw new RemoteBrowserError(
      "remote_browser_configuration_invalid",
      "UNICLI_CDP_ENDPOINT must use ws:// or wss://",
    );
  }
  const headers = readRemoteHeaders(env.UNICLI_CDP_HEADERS);
  return { endpoint: parsedEndpoint.href, headers };
}

function readRemoteHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new RemoteBrowserError(
      "remote_browser_configuration_invalid",
      `UNICLI_CDP_HEADERS is not valid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new RemoteBrowserError(
      "remote_browser_configuration_invalid",
      "UNICLI_CDP_HEADERS must be a JSON object of string values",
    );
  }
  const entries = Object.entries(decoded);
  if (entries.some(([, value]) => typeof value !== "string")) {
    throw new RemoteBrowserError(
      "remote_browser_configuration_invalid",
      "UNICLI_CDP_HEADERS values must all be strings",
    );
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function redactEndpoint(endpoint: string): string {
  const parsed = new URL(endpoint);
  return `${parsed.protocol}//${parsed.host}`;
}

function suggestionFor(code: RemoteBrowserErrorCode): string {
  switch (code) {
    case "remote_browser_unavailable":
      return "Set UNICLI_CDP_ENDPOINT to an explicit remote CDP WebSocket endpoint.";
    case "remote_browser_configuration_invalid":
      return "Correct UNICLI_CDP_ENDPOINT and UNICLI_CDP_HEADERS, then restart the broker.";
    case "remote_browser_connect_failed":
      return "Verify the remote endpoint, authentication headers, and network reachability.";
    case "remote_browser_target_not_found":
      return "Start a new remote browser turn instead of reusing an ended target.";
    case "remote_browser_shutdown_failed":
      return "Inspect the remote service and broker status before retrying cleanup.";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
