/**
 * @owner       src::transport::cdp-endpoint
 * @does        Parse and validate one explicit CDP renderer endpoint from compute request parameters.
 * @needs       WHATWG URL
 * @feeds       compute target routing and CDP adapter page acquisition.
 * @breaks      Treating a WebSocket URL or renderer id as advisory while ignoring it silently controls a different page.
 * @invariants  A returned endpoint has a valid TCP port, any WebSocket URL uses ws: or wss:, and any targetId is non-empty; invalid or contradictory explicit fields never become a target.
 * @side-effects none
 * @perf        O(length of one endpoint URL).
 * @concurrency Pure parsing over request-local values.
 * @test        tests/unit/transport/adapters/cdp-browser.test.ts, tests/unit/compute-dispatch.test.ts
 * @stability   stable
 * @since       0.400.2
 */

export interface CdpEndpoint {
  port: number;
  webSocketDebuggerUrl?: string;
  targetId?: string;
}

export function readCdpEndpoint(
  params: Readonly<Record<string, unknown>>,
): CdpEndpoint | undefined {
  const explicitPort = readPort(params.port);
  const webSocketDebuggerUrl = readWebSocketUrl(params.webSocketDebuggerUrl);
  const targetId = readTargetId(params.targetId);
  if (cdpEndpointValidationError(params)) return undefined;
  const websocketPort = webSocketDebuggerUrl
    ? portFromWebSocketUrl(webSocketDebuggerUrl)
    : undefined;
  if (
    explicitPort !== undefined &&
    websocketPort !== undefined &&
    explicitPort !== websocketPort
  ) {
    return undefined;
  }
  const port = explicitPort ?? websocketPort;
  if (port === undefined) return undefined;
  return {
    port,
    ...(webSocketDebuggerUrl ? { webSocketDebuggerUrl } : {}),
    ...(targetId ? { targetId } : {}),
  };
}

export function cdpEndpointValidationError(
  params: Readonly<Record<string, unknown>>,
): string | undefined {
  if (params.port !== undefined && readPort(params.port) === undefined) {
    return "port must be an integer from 1 through 65535";
  }
  if (
    params.webSocketDebuggerUrl !== undefined &&
    readWebSocketUrl(params.webSocketDebuggerUrl) === undefined
  ) {
    return "webSocketDebuggerUrl must be a non-empty ws: or wss: URL";
  }
  if (
    params.targetId !== undefined &&
    readTargetId(params.targetId) === undefined
  ) {
    return "targetId must be a non-empty string";
  }
  const explicitPort = readPort(params.port);
  const webSocketDebuggerUrl = readWebSocketUrl(params.webSocketDebuggerUrl);
  const websocketPort = webSocketDebuggerUrl
    ? portFromWebSocketUrl(webSocketDebuggerUrl)
    : undefined;
  return explicitPort !== undefined &&
    websocketPort !== undefined &&
    explicitPort !== websocketPort
    ? "port and webSocketDebuggerUrl identify different CDP endpoints"
    : undefined;
}

function readPort(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 65_535
    ? value
    : undefined;
}

function readWebSocketUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "ws:" || url.protocol === "wss:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function readTargetId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function portFromWebSocketUrl(value: string): number | undefined {
  const url = new URL(value);
  if (url.port) return readPort(Number(url.port));
  return url.protocol === "wss:"
    ? 443
    : url.protocol === "ws:"
      ? 80
      : undefined;
}
