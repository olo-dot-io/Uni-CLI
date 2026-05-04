# Cursor Computer Use

Use a project-level `.cursor/mcp.json` or global `~/.cursor/mcp.json` entry:

```jsonc
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
      ],
    },
  },
}
```

Restart Cursor or reload MCP servers after changing the file.

## Permissions

macOS requires Accessibility for AX control and Screen Recording for screenshot
fallback. Grant permissions to Cursor if it launches the server directly, or to
the terminal/shell process that starts the MCP server. Windows and Linux use the
UIA and AT-SPI sidecars.

## Verify

```bash
npx -y @zenalexa/unicli mcp serve --profile computer-use
```

The server banner should report `15 tools registered, mode=computer-use`.
