/**
 * MCP origin guard — DNS-rebinding protection shared by every HTTP transport.
 *
 * A local MCP server bound to loopback is unreachable from the network but
 * still reachable from a browser the user is running: a malicious page can
 * issue a CORS "simple request" to http://127.0.0.1:<port>/mcp. The browser
 * attaches the page's `Origin` and the page's script cannot forge or suppress
 * it, so validating `Origin` is the spec-mandated defense against that pivot.
 *
 * This is the single source of truth for the policy. Both the legacy
 * `http-transport.ts` and the Streamable HTTP transport import it so the two
 * paths can never drift apart again.
 */

import type { IncomingMessage } from "node:http";

/** Origins explicitly trusted regardless of the loopback-hostname check. */
export const ALLOWED_ORIGINS = new Set([
  "http://localhost",
  "http://127.0.0.1",
]);

/**
 * Validate the `Origin` header for DNS-rebinding protection.
 *
 * Requests with no `Origin` are non-browser clients (CLI, MCP host, curl) and
 * are allowed — a browser cannot omit `Origin` on a cross-origin request, so
 * this does not weaken the browser-threat defense. Any loopback origin is
 * allowed regardless of port; everything else is rejected.
 */
export function isOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients omit Origin
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return true;
    }
  } catch {
    // Malformed origin — reject
  }
  return ALLOWED_ORIGINS.has(origin);
}
