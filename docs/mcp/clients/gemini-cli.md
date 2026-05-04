# Gemini CLI Computer Use

Add Uni-CLI's `computer-use` MCP profile to Gemini CLI settings:

```jsonc
// ~/.gemini/settings.json
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

Restart Gemini CLI after editing settings.

## Permissions

On macOS, grant Accessibility to the terminal that launches Gemini CLI. Grant
Screen Recording if screenshot fallback is needed. Windows and Linux use the
UIA and AT-SPI sidecars respectively.

## Verify

```bash
npx -y @zenalexa/unicli mcp serve --profile computer-use
```

The server banner should report `15 tools registered, mode=computer-use`.
