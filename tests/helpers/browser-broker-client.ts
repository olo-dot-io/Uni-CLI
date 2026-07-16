import { randomUUID } from "node:crypto";

import type { BrowserInvocationContext } from "../../src/browser/invocation-context.js";
import type { BrowserTargetCommandResult } from "../../src/browser/runtime-protocol.js";
import { BrowserRuntimeBrokerClient } from "../../src/browser/runtime-transport.js";

interface ClientInput {
  runtime_root: string;
  agent_session_id: string;
  turn_id: string;
  profile_partition_id: string;
  barrier_url: string;
}

async function main(): Promise<void> {
  const encoded = process.argv[2];
  if (!encoded) throw new Error("Browser broker client input is required");
  const input = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as ClientInput;
  const context: BrowserInvocationContext = {
    agent_session_id: input.agent_session_id,
    turn_id: input.turn_id,
    transport: "cli",
    profile_partition_id: input.profile_partition_id,
  };
  const client = new BrowserRuntimeBrokerClient({
    runtimeRoot: input.runtime_root,
    requestTimeoutMs: 20_000,
  });
  await client.requestOrThrow({
    id: randomUUID(),
    action: "session.start",
    context,
  });
  const command = await client.requestOrThrow<BrowserTargetCommandResult>({
    id: randomUUID(),
    action: "target.command",
    context,
    provider: "managed",
    visibility: "hidden",
    profile_partition_id: input.profile_partition_id,
    isolated: true,
    ephemeral: true,
    command: {
      method: "evaluate",
      expression: `fetch(${JSON.stringify(input.barrier_url)}).then(async response => ({ status: response.status, body: await response.text() }))`,
    },
  });
  process.stdout.write(`${JSON.stringify(command)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
