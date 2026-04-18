/**
 * Streamable HTTP transport — compatibility re-export shim.
 *
 * v0.213.3 P3 split the transport into `streamable-http/{session,
 * handle-post, index}.ts`. This file preserves the old import path
 * (`./streamable-http.js`) so existing tests and external consumers
 * keep working without churn. All logic lives in `streamable-http/`.
 */

export { startStreamableHttp, _test } from "./streamable-http/index.js";
export type {
  Handler,
  StreamableHttpOptions,
} from "./streamable-http/session.js";
