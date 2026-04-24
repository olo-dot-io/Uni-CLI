# MCP Gateway

`unicli mcp serve` exposes Uni-CLI to MCP-aware clients through a small set of
meta-tools. The client searches the catalog first, then runs the selected
command.

## Start

```bash
npx @zenalexa/unicli mcp serve
```

Streamable HTTP:

```bash
npx @zenalexa/unicli mcp serve --transport streamable --port 19826
```

SSE compatibility:

```bash
npx @zenalexa/unicli mcp serve --transport sse --port 19826
```

Remote deployments can enable OAuth 2.1 PKCE:

```bash
npx @zenalexa/unicli mcp serve --transport streamable --port 19826 --auth
```

## Tools

| Tool             | Purpose                                                |
| ---------------- | ------------------------------------------------------ |
| `unicli_search`  | Search commands by natural-language intent.            |
| `unicli_run`     | Run a selected site command.                           |
| `unicli_list`    | List sites and commands.                               |
| `unicli_explore` | Inspect a page or surface before authoring an adapter. |

This keeps the MCP handshake small. It avoids registering every adapter command
as a separate tool.

## Client Config

Claude-style stdio config:

```json
{
  "mcpServers": {
    "unicli": {
      "command": "npx",
      "args": ["@zenalexa/unicli", "mcp", "serve"]
    }
  }
}
```

Codex CLI config:

```toml
[mcp_servers.unicli]
command = "npx"
args = ["@zenalexa/unicli", "mcp", "serve"]
```

HTTP clients should connect to:

```text
http://127.0.0.1:19826/mcp
```

## Auth

Adapters that require cookies read the same files as the CLI:

```bash
unicli auth setup SITE
unicli auth check SITE
```

Cookie path:

```text
~/.unicli/cookies/SITE.json
```

## Recommended Agent Flow

```json
{ "tool": "unicli_search", "arguments": { "query": "hacker news frontpage" } }
```

Then:

```json
{
  "tool": "unicli_run",
  "arguments": {
    "site": "hackernews",
    "command": "top",
    "args": { "limit": 5 },
    "format": "json"
  }
}
```

The run result uses the same v2 envelope as the CLI.
