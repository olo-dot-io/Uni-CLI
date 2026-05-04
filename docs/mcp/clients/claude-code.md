# Claude Code Computer Use

Register Uni-CLI as the `computer-use` MCP server for Claude Code:

```bash
claude mcp add computer-use \
  -- npx -y @zenalexa/unicli mcp serve --profile computer-use
```

The profile exposes only the 15 local computer-control tools:
`computer-use.apps`, `computer-use.windows`, `computer-use.snapshot`,
`computer-use.find`, `computer-use.click`, `computer-use.type`,
`computer-use.press`, `computer-use.scroll`, `computer-use.launch`,
`computer-use.screenshot`, `computer-use.attach`, `computer-use.evaluate`,
`computer-use.wait`, `computer-use.observe`, and `computer-use.assert`.

## Permissions

On macOS, grant Accessibility to the terminal or app that launches Claude Code.
Grant Screen Recording if you want screenshot fallback. Windows and Linux use
the UIA and AT-SPI sidecars respectively.

## Verify

```bash
npx -y @zenalexa/unicli mcp serve --profile computer-use
```

The server banner should report `15 tools registered, mode=computer-use`.
