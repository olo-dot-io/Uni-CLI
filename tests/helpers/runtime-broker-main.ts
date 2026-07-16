import { mkdirSync, writeFileSync } from "node:fs";

import {
  BROWSER_BROKER_PRODUCT,
  BROWSER_BROKER_PROTOCOL,
  BROWSER_BROKER_PROTOCOL_VERSION,
} from "../../src/browser/runtime-protocol.js";
import { browserBrokerPaths } from "../../src/browser/runtime-transport.js";

const runtimeRoot = process.argv[2];
if (!runtimeRoot) throw new Error("stuck broker fixture requires runtime root");
const paths = browserBrokerPaths(runtimeRoot);
const runtimeId = "018f4f68-6f5b-7b01-8c02-abcdefabcdef";
const startedAt = new Date().toISOString();

mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
writeFileSync(
  paths.lockPath,
  `${JSON.stringify({
    pid: process.pid,
    runtime_id: runtimeId,
    created_at: startedAt,
  })}\n`,
  { mode: 0o600 },
);
writeFileSync(
  paths.descriptorPath,
  `${JSON.stringify({
    product: BROWSER_BROKER_PRODUCT,
    protocol: BROWSER_BROKER_PROTOCOL,
    version: Math.max(1, BROWSER_BROKER_PROTOCOL_VERSION - 1),
    runtime_id: runtimeId,
    pid: process.pid,
    socket_path: paths.socketPath,
    auth_token: "stuck-broker-auth-token-stuck-broker-auth-token",
    started_at: startedAt,
  })}\n`,
  { mode: 0o600 },
);

setInterval(() => undefined, 60_000);
