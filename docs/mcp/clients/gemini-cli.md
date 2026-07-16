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

Append `--browser-provider chrome --browser-visibility background` to `args`
for non-focusing Chrome work. `browser_prepare` creates an inactive owned tab;
existing user tabs stay background-read-only and use explicit `tab_id` values.
Use `foreground` only for user-tab mutation, edge presence, or the virtual
cursor. The profile exposes 16 desktop and 16 direct browser tools.

## Permissions

On macOS, grant Accessibility to the terminal that launches Gemini CLI. Grant
Screen Recording if screenshot fallback is needed. Windows and Linux use the
UIA and AT-SPI sidecars respectively.

## Verify

```bash
npx -y @zenalexa/unicli mcp serve --profile computer-use
```

The server banner should report `32 tools registered, mode=computer-use`.
