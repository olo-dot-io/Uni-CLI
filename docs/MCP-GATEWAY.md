# MCP Gateway

> Run Uni-CLI as an MCP server for Claude Desktop, Cursor, Cline, or any MCP-aware client.

## What it does

`unicli mcp serve` starts an MCP (Model Context Protocol) server that auto-registers one tool per Uni-CLI adapter command. Tools follow the naming convention `unicli_<site>_<command>` (e.g. `unicli_hackernews_top`, `unicli_bilibili_ranking`). The input schema is derived from the adapter's `args` definition; the output schema mirrors the `columns` array.

## Why

goose, codex, hermes-agent, and most agent frameworks now treat MCP as the canonical tool-discovery protocol. Without a gateway, an MCP-only client cannot reach Uni-CLI's 700+ commands. With it, any MCP client gets the entire catalog at zero integration cost.

## Modes

### Default — expanded mode

Every adapter command becomes its own MCP tool. The handshake is heavier (700+ tool entries) but the agent sees the full surface area immediately.

```bash
unicli mcp serve
```

### Lazy mode (compatibility)

Only `list_adapters` + `run_command` are registered. Use this when an MCP client has a hard tool-count limit.

```bash
unicli mcp serve --lazy
```

## Transports

### stdio (default)

Newline-delimited JSON-RPC over stdin/stdout. This is what Claude Desktop / Cursor / Cline expect.

```bash
unicli mcp serve              # stdio, expanded
unicli mcp serve --lazy       # stdio, lazy
```

### HTTP

JSON-RPC over `POST /mcp`. Useful for self-hosted environments and quick browser-based testing.

```bash
unicli mcp serve --transport http --port 19826
# server: http://127.0.0.1:19826/mcp
# health: GET http://127.0.0.1:19826/  (returns server info)
```

The HTTP transport accepts a single JSON-RPC envelope per request and returns a single JSON response. There is no SSE streaming yet.

## Health check

Pre-flight your tool registration before connecting from an MCP client:

```bash
unicli mcp health
# unicli MCP gateway v0.210.0
#   sites:    134
#   commands: 711
#   tools:    712 (1 core + 711 per-command)
#
# Sample tools:
#   list_adapters: List all Uni-CLI adapters and their commands
#   unicli_hackernews_top: [hackernews] Hacker News top stories
#   …
```

JSON output for scripts:

```bash
unicli mcp health --json
```

## Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%AppData%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "unicli": {
      "command": "unicli",
      "args": ["mcp", "serve"]
    }
  }
}
```

## Cursor config

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "unicli": {
      "command": "unicli",
      "args": ["mcp", "serve"]
    }
  }
}
```

## Auth

Adapters that require cookies (twitter, instagram, …) read them from the same `~/.unicli/cookies/<site>.json` files the CLI uses. Run `unicli auth setup <site>` once before connecting from an MCP client.

## Calling tools

In expanded mode the tool name is `unicli_<site>_<command>`:

```jsonrpc
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "unicli_hackernews_top",
    "arguments": { "limit": 5 }
  }
}
```

In lazy mode the tool name is `run_command`:

```jsonrpc
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "run_command",
    "arguments": {
      "site": "hackernews",
      "command": "top",
      "args": { "limit": 5 }
    }
  }
}
```

Both return `{ count, results }` payloads in `content[0].text`.
