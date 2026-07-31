# MCP Protocol Eras

Uni-CLI serves two MCP protocol eras from one handler:

| Era    | Revision     | Request identity                                                  | Lifecycle                                            | Async work                                                                           |
| ------ | ------------ | ----------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Modern | `2026-07-28` | protocol version and client capabilities in every request `_meta` | stateless; `server/discover` replaces initialization | server-directed `io.modelcontextprotocol/tasks` with durable task handles            |
| Legacy | `2025-11-25` | version selected by `initialize`                                  | session-owned                                        | legacy core Tasks with `tasks/get`, `tasks/result`, `tasks/list`, and `tasks/cancel` |

The handler classifies a request from its wire contract. A modern request never
depends on a previous initialization call or an HTTP session id. A legacy
request continues through the established compatibility path.

## Modern request contract

Every modern request includes:

```json
{
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": {
      "name": "client-name",
      "version": "1.0.0"
    },
    "io.modelcontextprotocol/clientCapabilities": {}
  }
}
```

`server/discover` reports both supported revisions and the modern capability
surface. Every successful modern result carries `resultType: "complete"` and
server identity in `_meta`. `tools/list` and `prompts/list` include `ttlMs` and
`cacheScope`, and tool order remains deterministic.

Large callable surfaces are cursor-paginated before the synchronous 768 KiB
result budget is applied. `tools/list` returns at most 256 tools and exposes
the standard `nextCursor`; clients pass it back as `cursor` until absent. The
`unicli_list` meta-tool defaults to 200 commands, accepts `limit` from 1 to
256, and returns `next_cursor` with stable `total_sites`, `total_commands`, and
`returned_commands` fields. Cursors are opaque and list-specific. Malformed,
foreign-list, and out-of-range cursors fail explicitly rather than restarting
at page zero.

Modern Streamable HTTP additionally validates:

- `MCP-Protocol-Version` against request `_meta`;
- `Mcp-Method` against the JSON-RPC method;
- `Mcp-Name` against `params.name`, `params.uri`, or task `params.taskId` where
  required.

Header mismatches return `-32020`, missing modern request fields return
`-32602`, unsupported versions return `-32022` with supported revisions, and
unknown methods return HTTP 404 with `-32601`. Modern HTTP response-stream loss
cancels that request and mints no `MCP-Session-Id`.

## Compatibility boundary

`MCP_PROTOCOL_VERSION` remains the legacy revision so existing integrations
that import that constant or initialize normally keep their behavior.
`MCP_MODERN_PROTOCOL_VERSION` names the stateless revision, and
`MCP_SUPPORTED_PROTOCOL_VERSIONS` orders modern before legacy for discovery.

## Modern Tasks extension

`server/discover` advertises `io.modelcontextprotocol/tasks`. A client enables
it independently on each request:

```json
{
  "_meta": {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {
      "extensions": {
        "io.modelcontextprotocol/tasks": {}
      }
    }
  }
}
```

Task creation is server-directed. Uni-CLI selects a task for a tool whose
operation contract requires durable execution. It returns `-32003` with
`requiredCapabilities` when that tool cannot run safely without a task and the
request omitted the extension.

Task support follows the concrete effect boundary. The computer-use profile
exposes `computer-use.screenshot` as a read-only inline image tool and
`computer-use.screenshot_file` as a path-required write tool. The latter
requires a task; the former does not inherit that requirement merely because
both call the same capture primitive.

The creation result is a flat `resultType: "task"` object. The record is
atomically persisted before that handle is returned. `tasks/get` is a pure
lookup and includes the terminal tool result or JSON-RPC error. A tool result
with `isError: true` is still a completed task because it is a valid tool-level
result. `tasks/update` accepts responses to outstanding mid-flight input
requests. `tasks/cancel` acknowledges cancellation intent immediately and does
not claim that cooperative execution has already stopped.

Task files live under `~/.unicli/mcp/tasks-v2026` by default, use mode `0600`,
and are bounded by TTL and terminal-record retention. High-entropy task ids act
as bearer handles when the transport is unauthenticated. Authenticated HTTP
tasks are additionally bound to the OAuth principal. A worker lease prevents a
second server process from misclassifying live work as abandoned; an orphaned
record becomes a detailed failed task after its worker lease expires.

The modern extension never exposes the legacy `{task: ...}` wrapper,
`tasks/list`, or blocking `tasks/result` method.

## Principal isolation and capacity

Authenticated task and session ownership uses the verified OAuth principal,
not caller-provided metadata. Unauthenticated durable task ids remain
high-entropy bearer handles. Active modern tasks are admitted atomically up to
32 per principal and 200 for the server. Streamable HTTP sessions are limited
to 25 per principal and 100 globally. Completion and cancellation release task
capacity; session expiry or removal releases session capacity.

Principal exhaustion returns JSON-RPC `-32603` with HTTP `429` for session
admission and does not prevent another principal from using its share. Global
session exhaustion returns HTTP `503`. The two levels are checked separately,
so one client cannot monopolize the server while the global ceiling still
protects the process. Concurrent boundary tests create work at each exact
limit, verify cross-principal admission, and then verify release.

## Subscription streams

Modern `subscriptions/listen` is a real long-lived request rather than a
one-shot response. Stdio writes notifications on the shared output stream and
tags every one with the listen request id. Streamable HTTP keeps that POST's SSE
response open, disables proxy buffering, emits periodic comment keep-alives,
and serializes writes with backpressure.

The first stream message is always
`notifications/subscriptions/acknowledged`. Its filter contains only the
notification types Uni-CLI accepted. Tool, prompt, and resource catalogs are
currently static, so their list-change filters are omitted. The Tasks
extension adds `taskIds`; accepted ids are restricted to tasks visible to the
same bearer handle or OAuth principal. Every `notifications/tasks` message
contains the complete detailed task state. A task-to-subscription inverted
index makes delivery proportional to matching subscribers rather than every
open stream.

Closing an HTTP stream or cancelling the stdio request removes the
subscription without a stale final response. Server shutdown sends the
correlated empty `resultType: "complete"` response before closing a healthy
stream. HTTP task work remains independent of the subscription lifecycle.

## Source ownership

| Concern                                       | Source                                                          |
| --------------------------------------------- | --------------------------------------------------------------- |
| Protocol classification and result decoration | `src/mcp/handler.ts`                                            |
| Modern and legacy constants                   | `src/constants.ts`                                              |
| Stdio request lifecycle                       | `src/mcp/stdio-transport.ts`                                    |
| Dual-era HTTP validation and cancellation     | `src/mcp/streamable-http/handle-post.ts`                        |
| Legacy task state machine                     | `src/mcp/tasks.ts`                                              |
| Modern durable task state machine             | `src/mcp/modern-tasks.ts`                                       |
| Principal/session admission                   | `src/mcp/modern-tasks.ts`, `src/mcp/streamable-http/session.ts` |
| Subscription filtering and task fanout        | `src/mcp/subscriptions.ts`                                      |
| Modern protocol conformance tests             | `tests/unit/mcp/protocol-2026.test.ts`                          |
| Dual-era HTTP tests                           | `tests/unit/streamable-http.test.ts`                            |
| Principal and global quota tests              | `tests/unit/mcp/principal-quotas.test.ts`                       |

This compatibility layer changes protocol framing only. Task-to-operator
routing stays in command contracts and the compute route planner, so CLI and
MCP calls share the same execution boundary.
