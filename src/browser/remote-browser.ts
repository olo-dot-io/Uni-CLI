/**
 * @owner       src/browser/remote-browser.ts
 * @does        Own broker-lifetime remote browser contexts, targets, flattened CDP sessions, and expose their status lifecycle without local browser fallback.
 * @needs       node:crypto, src/browser/cdp-client.ts, page.ts
 * @feeds       src/browser/runtime-broker.ts, runtime-protocol.ts
 * @breaks      RemoteBrowserError on missing/malformed configuration, connection failure, unknown targets, and teardown failure.
 * @invariants  Remote endpoints are explicit browser-level CDP sockets, hidden-only, secret-redacted in status, never replaced by a local provider, and every target runs in its own owned BrowserContext and flattened session; malformed optional remote configuration disables only remote acquisition; a confirmed root disconnect disposes its disposeOnDetach context and supersedes lost cleanup acknowledgements.
 * @side-effects Opens authenticated remote WebSocket connections and closes them on target/session/broker teardown.
 * @perf        One remote CDP connection per owned target; status is O(targets).
 * @concurrency Distinct remote targets own distinct CDP clients; broker queues serialize commands per target.
 * @test        tests/unit/remote-browser.test.ts, tests/integration/browser-remote-provider.test.ts
 * @stability   experimental
 * @since       2026-07-15
 */

import { randomUUID } from "node:crypto";

import {
  CDPClient,
  CDPSessionClient,
  type CDPTarget,
  type RemoteEndpoint,
} from "./cdp-client.js";
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
  root: CDPClient;
  page: BrowserPage;
  session_id: string;
  cdp_target_id: string;
  browser_context_id: string;
  page_closed: boolean;
  context_disposed: boolean;
  root_closed: boolean;
}

type RemoteBrowserErrorCode =
  | "remote_browser_unavailable"
  | "remote_browser_configuration_invalid"
  | "remote_browser_connect_failed"
  | "remote_browser_endpoint_unsupported"
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
  private readonly configurationError: RemoteBrowserError | null;
  private readonly targets = new Map<string, RemoteTarget>();

  constructor(options: RemoteBrowserProviderOptions = {}) {
    let endpoint: RemoteEndpoint | null = null;
    let configurationError: RemoteBrowserError | null = null;
    try {
      endpoint =
        options.endpoint === undefined
          ? readRemoteEndpoint(options.env ?? process.env)
          : options.endpoint;
    } catch (error) {
      if (
        !(error instanceof RemoteBrowserError) ||
        error.code !== "remote_browser_configuration_invalid"
      ) {
        throw error;
      }
      configurationError = error;
    }
    this.endpoint = endpoint;
    this.configurationError = configurationError;
  }

  async acquireTarget(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.configurationError) throw this.configurationError;
    if (!this.endpoint) {
      throw new RemoteBrowserError(
        "remote_browser_unavailable",
        "The remote browser provider is not configured",
      );
    }
    let root: CDPClient;
    try {
      root = await CDPClient.connectToRemote(
        this.endpoint.endpoint,
        this.endpoint.headers,
        signal,
      );
    } catch (error) {
      throw new RemoteBrowserError(
        "remote_browser_connect_failed",
        `Remote CDP connection failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    let stage: "context" | "target" | "attach" | "page" = "context";
    let browserContextId: string | undefined;
    try {
      const context = (await root.send(
        "Target.createBrowserContext",
        { disposeOnDetach: true },
        undefined,
        signal,
      )) as { browserContextId?: string };
      if (!context.browserContextId) {
        throw new Error("Remote endpoint did not return a browserContextId");
      }
      browserContextId = context.browserContextId;
      stage = "target";
      const target = (await root.send(
        "Target.createTarget",
        {
          url: "about:blank",
          browserContextId,
        },
        undefined,
        signal,
      )) as { targetId?: string };
      if (!target.targetId) {
        throw new Error("Remote endpoint did not return a targetId");
      }
      stage = "attach";
      const attached = (await root.send(
        "Target.attachToTarget",
        {
          targetId: target.targetId,
          flatten: true,
        },
        undefined,
        signal,
      )) as { sessionId?: string };
      if (!attached.sessionId) {
        throw new Error("Remote endpoint did not return a flattened sessionId");
      }
      const connectedTarget: CDPTarget = {
        id: target.targetId,
        type: "page",
        title: "",
        url: "about:blank",
        webSocketDebuggerUrl: this.endpoint.endpoint,
      };
      const session = new CDPSessionClient(
        root,
        attached.sessionId,
        connectedTarget,
      );
      stage = "page";
      await session.send("Page.enable", undefined, undefined, signal);
      const targetId = `remote:${randomUUID()}`;
      this.targets.set(targetId, {
        root,
        page: new BrowserPage(session),
        session_id: attached.sessionId,
        cdp_target_id: target.targetId,
        browser_context_id: browserContextId,
        page_closed: false,
        context_disposed: false,
        root_closed: false,
      });
      return targetId;
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (browserContextId) {
        try {
          await root.send("Target.disposeBrowserContext", {
            browserContextId,
          });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        await root.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new RemoteBrowserError(
          "remote_browser_shutdown_failed",
          `Remote CDP allocation failed during ${stage} and cleanup was incomplete: ${errorMessage(cleanupErrors[0])}`,
          {
            cause: new AggregateError(
              [error, ...cleanupErrors],
              "Remote browser allocation and cleanup failed",
            ),
          },
        );
      }
      const code =
        stage === "context"
          ? "remote_browser_endpoint_unsupported"
          : "remote_browser_connect_failed";
      throw new RemoteBrowserError(
        code,
        stage === "context"
          ? `Remote CDP endpoint does not expose browser-level context ownership: ${errorMessage(error)}`
          : `Remote CDP target allocation failed during ${stage}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
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
    const cleanupErrors: unknown[] = [];
    if (!target.page_closed) {
      try {
        await target.page.close();
        target.page_closed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!target.context_disposed) {
      try {
        await target.root.send("Target.disposeBrowserContext", {
          browserContextId: target.browser_context_id,
        });
        target.context_disposed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!target.root_closed) {
      try {
        await target.root.close();
        target.root_closed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (target.root_closed) target.context_disposed = true;
    if (!target.context_disposed || !target.root_closed) {
      throw new RemoteBrowserError(
        "remote_browser_shutdown_failed",
        `Remote browser target ${targetId} remained partially owned after cleanup: ${errorMessage(cleanupErrors[0])}`,
        cleanupErrors.length > 0
          ? {
              cause: new AggregateError(
                cleanupErrors,
                "Remote target cleanup did not converge",
              ),
            }
          : undefined,
      );
    }
    this.targets.delete(targetId);
  }

  status(): RemoteBrowserStatus {
    return {
      configured: this.endpoint !== null,
      ...(this.configurationError
        ? { configuration_error: this.configurationError.message }
        : {}),
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
    case "remote_browser_endpoint_unsupported":
      return "Configure a browser-level CDP WebSocket endpoint that supports Target.createBrowserContext and flattened target sessions.";
    case "remote_browser_target_not_found":
      return "Start a new remote browser turn instead of reusing an ended target.";
    case "remote_browser_shutdown_failed":
      return "Inspect the remote service and broker status before retrying cleanup.";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
