# Contributing a Transport Adapter

A **TransportAdapter** is a delivery channel for agent↔Uni-CLI traffic —
CLI stdio, MCP stdio, MCP streamable HTTP, ACP (Agent Client Protocol),
CUA (Computer Use API) backends, and plugin extensions. Each transport
translates between an external wire format and Uni-CLI's internal
`resolveCommand` + `runPipeline` core.

Today Uni-CLI ships five transports (see `src/mcp/`, `src/runtime/`, and
`src/plugin/`). The unifying contract formalized in Phase 1 is:

```typescript
interface TransportAdapter {
  name: string;
  capabilities: TransportCapability[]; // tools | prompts | resources | ...
  start(options: TransportOptions): Promise<TransportHandle>;
}
```

## When to add a new transport

Add one when an agent platform exposes a wire format Uni-CLI does not speak
natively. Examples: WebSocket JSON-RPC for a bespoke IDE, a gRPC service,
an SSE stream over Cloudflare Workers.

Do **not** add one for small flag differences to an existing transport —
prefer extending the existing handler.

## Directory layout

```
src/transport/
├── index.ts        # Registry: registerTransport / getTransport
├── capability.ts   # Step → capability matrix (lint uses this)
├── cli.ts          # Tier 0: stdio tty / pipe (primary)
├── mcp-stdio.ts    # MCP JSON-RPC over stdio
├── mcp-http.ts     # MCP streamable HTTP
├── acp.ts          # ACP shim (see contributing/acp.md)
└── <new>.ts        # Your new transport lives here
```

A new transport must:

1. Declare capabilities in `capabilities.ts`.
2. Register via `registerTransport(adapter)` at module load time.
3. Translate the wire format into `ResolvedCommand` (see
   `src/types.ts:206`) and delegate execution to `runPipeline`.
4. Translate pipeline output back to the wire format.

## Wire-to-core translation

```typescript
export const mcpStdioTransport: TransportAdapter = {
  name: "mcp-stdio",
  capabilities: ["tools", "prompts", "resources"],
  async start({ stdin, stdout }) {
    for await (const frame of readJsonRpc(stdin)) {
      if (frame.method === "tools/call") {
        const { name, arguments: args } = frame.params;
        const [site, cmd] = name.split("/");
        const resolved = resolveCommand(site, cmd, args);
        const result = await runPipeline(
          resolved.command.pipeline!,
          resolved.args,
        );
        writeJsonRpc(stdout, {
          id: frame.id,
          result: { content: formatResult(result) },
        });
      }
    }
  },
};
```

## Error translation

Every transport lowers `PipelineError` (see `src/types.ts:216` —
`PipelineErrorDetail`) to a wire-appropriate error shape. Stick to the
machine-actionable fields: `step`, `action`, `errorType`, `suggestion`,
`retryable`. Transports MUST NOT swallow errors silently.

Exit codes from `src/types.ts:239` (`ExitCode`) map to:

| Wire                 | Exit code               |
| -------------------- | ----------------------- |
| JSON-RPC error -32xx | `GENERIC_ERROR`         |
| HTTP 4xx             | `USAGE_ERROR` / 77 auth |
| HTTP 5xx             | `TEMP_FAILURE`          |
| empty result         | `EMPTY_RESULT` (66)     |

## Testing

- Unit-test the wire translator in isolation. Mock stdin/stdout streams
  (see `tests/unit/mcp-server.test.ts:60` for the pattern).
- Integration-test the round-trip: spawn the transport, send a real
  request, assert the response.
- Add the transport's capability surface to the capability matrix so
  `unicli lint` knows its steps exist (`src/engine/capability.ts`).

## Register in CLI discovery

Add your transport to `src/cli.ts`'s `createCli` so users can pick it:

```typescript
program
  .command("serve")
  .option("--transport <name>", "stdio | mcp | acp | <your-name>")
  .action(async (opts) => {
    const transport = getTransport(opts.transport);
    await transport.start({ stdin: process.stdin, stdout: process.stdout });
  });
```

## Checklist

- [ ] New transport file under `src/transport/`.
- [ ] `registerTransport(...)` called at module load.
- [ ] `capability.ts` updated.
- [ ] Error translation preserves `PipelineErrorDetail`.
- [ ] Unit + integration tests added.
- [ ] CLI flag or env toggle to select it.
- [ ] Changeset added.
