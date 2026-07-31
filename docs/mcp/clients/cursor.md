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

Append `--browser-provider chrome --browser-visibility background` to `args`
for non-focusing Chrome work. `browser_prepare` creates an inactive owned tab;
existing user tabs stay background-read-only and use explicit `tab_id` values.
Use `foreground` only for user-tab mutation, edge presence, or the virtual
cursor. The profile exposes 16 desktop and 16 direct browser tools.

## Permissions

macOS requires Accessibility for AX control and Screen Recording for screenshot
capture. Grant permissions to Cursor if it launches the server directly, or to
the terminal/shell process that starts the MCP server. Windows and Linux use the
UIA and AT-SPI sidecars.

## Verify

```bash
npx -y @zenalexa/unicli mcp serve --profile computer-use
```

The server banner should report `32 tools registered, mode=computer-use`.
