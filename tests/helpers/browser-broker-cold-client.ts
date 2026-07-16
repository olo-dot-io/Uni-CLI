import { ensureBrowserRuntimeBroker } from "../../src/browser/runtime-launch.js";

const runtimeRoot = process.argv[2];
if (!runtimeRoot)
  throw new Error("browser broker cold client requires runtime root");

const connection = await ensureBrowserRuntimeBroker({
  runtimeRoot,
  startupTimeoutMs: 15_000,
});
process.stdout.write(
  `${JSON.stringify({
    runtime_id: connection.status.runtime_id,
    broker_pid: connection.status.broker_pid,
  })}\n`,
);
