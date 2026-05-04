# Claude Desktop Computer Use

Use the `computer-use` MCP profile when Claude Desktop should control local
apps through Uni-CLI's compute layer.

```jsonc
// macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
// Windows: %APPDATA%\Claude\claude_desktop_config.json
{
  "mcpServers": {
    "computer-use": {
      "command": "npx",
      "args": [
        "-y",
        "@zenalexa/unicli",
        "mcp",
        "serve",
        "--profile",
        "computer-use",
        "--transport",
        "stdio",
      ],
    },
  },
}
```

Restart Claude Desktop after editing the config.

## Permissions

macOS requires Accessibility for structured app control. Screenshot fallback
also requires Screen Recording. Grant both to Claude Desktop, Terminal, or the
launcher that starts the MCP server.

Windows uses UI Automation through the Uni-CLI sidecar. Linux uses AT-SPI and
requires the desktop accessibility bus to be available.

## Verify

Run this outside Claude first:

```bash
npx -y @zenalexa/unicli mcp serve --profile computer-use
```

The server banner should report `15 tools registered, mode=computer-use`.
