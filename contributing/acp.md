# ACP Shim (Agent Client Protocol)

ACP is Zed's JSON-RPC protocol for bidirectional agent↔editor
communication. Uni-CLI includes a thin shim so agents running inside
Zed (or any ACP-compatible host) can drive `unicli` commands.

ACP is a specialized transport — see `contributing/transport.md` for the
generic `TransportAdapter` contract.

## Wire format

ACP frames are JSON-RPC 2.0 over stdio (like LSP):

```
Content-Length: 102\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"session/invoke","params":{…}}
```

Header-delimited, UTF-8 body. One frame per exchange. Uni-CLI reads from
stdin and writes to stdout. Diagnostics go to stderr.

## Methods we handle

| Method               | Role                                         |
| -------------------- | -------------------------------------------- |
| `initialize`         | Handshake; exchange protocol version         |
| `session/new`        | Create an agent session                      |
| `session/invoke`     | Run a unicli command; return final result    |
| `session/stream`     | Run a unicli command; stream partial results |
| `session/cancel`     | Cancel an in-flight invoke                   |
| `notifications/exit` | Shut down cleanly                            |

Unsupported methods return `-32601` (Method Not Found). Malformed frames
return `-32700` (Parse Error).

## Command mapping

ACP `session/invoke.params` carries a natural-language intent plus an
optional pre-resolved tool name. The shim routes:

1. If `params.tool` is set to `"<site>/<command>"`, call
   `resolveCommand(site, cmd, params.args)` and execute directly.
2. Otherwise, fall through to the planner hook (out of scope for this
   doc — see `src/runtime/planner.ts` when it lands in Phase 3).

## Streaming

`session/stream` replies use `notifications/session/progress` frames:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/session/progress",
  "params": {
    "sessionId": "...",
    "step": 3,
    "total": 5,
    "message": "fetch https://…"
  }
}
```

One frame per pipeline step. The final result lands in a normal
`session/stream` response once the pipeline completes.

## Error shape

ACP errors follow JSON-RPC. The `data` field carries our internal
`PipelineErrorDetail` (see `src/types.ts:216`):

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32000,
    "message": "fetch failed: 404",
    "data": {
      "step": 2,
      "action": "fetch",
      "errorType": "http_error",
      "suggestion": "Check URL template; API may have moved.",
      "retryable": false
    }
  }
}
```

`code` ∈ `{-32000..-32099}` is the JSON-RPC implementation-defined range.
We use -32000 for pipeline errors, -32001 for auth, -32002 for timeout.

## Session lifecycle

- Each `session/new` returns a fresh `sessionId`. Sessions are
  independent — a browser launched in session A is not visible to
  session B. Implementation: `src/runtime/session.ts`.
- Sessions auto-GC after 10 minutes idle (configurable via
  `UNICLI_ACP_SESSION_TTL`).
- `notifications/exit` tears down all sessions immediately.

## Testing

The shim itself lives at `src/transport/acp.ts` (Phase 2). Tests in
`tests/unit/acp.test.ts`:

- Handshake: `initialize` followed by `initialized` notification.
- Roundtrip: `session/new` → `session/invoke` → assert result.
- Error path: invalid `params.tool` returns `-32000` with populated
  `data`.
- Streaming: `session/stream` emits ≥1 progress notification before the
  final response.

## Checklist

- [ ] New `session/*` method handled explicitly; unknown methods return
      `-32601`.
- [ ] Error `data` populated with `PipelineErrorDetail`.
- [ ] Session state is per-session, not global.
- [ ] Diagnostics go to stderr, not stdout (stdout is ACP channel).
- [ ] Unit tests cover happy path, error path, streaming.
- [ ] Changeset added.
