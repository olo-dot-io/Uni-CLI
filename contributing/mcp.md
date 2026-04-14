# MCP Server Surface

Uni-CLI ships an MCP (Model Context Protocol) server that exposes every
registered adapter command as an MCP tool. Agents that only speak MCP
(Claude Desktop, Cline, OpenCode, etc.) can call `unicli` commands
without knowing the CLI exists.

## Surfaces

| File                         | Role                              |
| ---------------------------- | --------------------------------- |
| `src/mcp/server.ts`          | Transport startup (stdio + HTTP)  |
| `src/mcp/schema.ts`          | JSON Schema generation for tools  |
| `src/mcp/capabilities.ts`    | Capability negotiation            |
| `src/mcp/streamable-http.ts` | HTTP + SSE implementation         |
| `src/mcp/oauth.ts`           | OAuth 2.1 PKCE for authed servers |
| `src/commands/mcp.ts`        | `unicli mcp` CLI command          |

Spec target: **MCP 2025-11-25** (current stable). Streaming HTTP is per
the 2025-11-25 revision; we reconsider on each draft spec release.

## Tool registration

Every adapter command surfaces as a tool. Name encoding:

```
<site>__<command>     # double-underscore to avoid collisions with site names containing dashes
```

Generated at server start from `getAllAdapters()` (`src/registry.ts`).

Input schema comes from `buildInputSchema(cmd)` (`src/mcp/schema.ts:40`).
Output schema: `buildOutputSchema(cmd, "flat")` (same file, line 80+).

## Adding a new MCP tool that is NOT an adapter

MCP servers occasionally need tools with no adapter (e.g. a diagnostic
tool, a config read/write tool). Register under `src/mcp/builtin-tools.ts`:

```typescript
export const builtinTools: McpTool[] = [
  {
    name: "list_sites",
    description: "List all registered adapter sites",
    inputSchema: {
      /* … */
    },
    handler: async () => ({
      content: [{ type: "text", text: /* … */ }],
    }),
  },
];
```

Load them in `server.ts` next to the adapter-derived tools. Prefer
adapter-as-tool for anything touching the outside world — it keeps the
agent-visible surface symmetric with the CLI.

## Capability flags

`src/mcp/capabilities.ts` advertises what the server supports:

```typescript
{
  tools: { listChanged: true },
  prompts: {},
  resources: {},
  logging: {}
}
```

Only flip `listChanged: true` if the transport genuinely re-emits
`notifications/tools/list_changed` on change. Lying here breaks clients
that cache the tool list aggressively.

## OAuth 2.1 PKCE (authed servers)

`src/mcp/oauth.ts` implements the 2025-11-25 auth flow. Key rules:

- Store the device flow token in the user's OS keychain — never in
  plaintext JSON. `node-keytar` abstractions go through
  `src/runtime/secrets.ts`.
- Tokens are scoped per `sessionId`; a logout invalidates the server's
  session cache.
- Refresh tokens rotate on every use (RFC 6819 §5.2.2.3).

## Testing

- `tests/unit/mcp-server.test.ts` — stdio round-trips.
- `tests/unit/mcp-server-expanded.test.ts` — adapter tool surface.
- `tests/unit/mcp-oauth.test.ts` — PKCE flow.
- `tests/unit/streamable-http.test.ts` — HTTP + SSE.

All four run on every CI cell (Node 20/22 x 3 OSes).

## Local dev

```bash
# Stdio (for Claude Desktop, Cline):
npm run mcp

# Streamable HTTP on a random port:
UNICLI_MCP_HTTP=1 npm run mcp

# Verbose with full JSON-RPC trace:
UNICLI_MCP_DEBUG=1 npm run mcp
```

## Checklist

- [ ] Tool registered in `server.ts` with full JSON Schema.
- [ ] Handler delegates to `runPipeline` — no duplicated logic.
- [ ] Error shape maps to MCP `isError: true` with `content[0].text`
      containing the `PipelineErrorDetail` JSON.
- [ ] At least one happy-path and one error-path test in
      `tests/unit/mcp-server.test.ts`.
- [ ] No secrets in log output; no PII in tool name/description.
- [ ] Changeset added.
