# Claude Code Computer Use

Register Uni-CLI as the `computer-use` MCP server for Claude Code:

```bash
claude mcp add computer-use \
  -- npx -y @zenalexa/unicli mcp serve --profile computer-use
```

The profile exposes 32 bounded computer-control tools:
`computer-use.apps`, `computer-use.windows`, `computer-use.capture`,
`computer-use.snapshot`, `computer-use.find`, `computer-use.click`,
`computer-use.type`, `computer-use.press`, `computer-use.scroll`,
`computer-use.launch`, `computer-use.screenshot`, `computer-use.attach`,
`computer-use.evaluate`, `computer-use.wait`, `computer-use.observe`, and
`computer-use.assert`; plus `computer-use.browser_tabs`,
`computer-use.browser_prepare`, `computer-use.browser_state`,
`computer-use.browser_screenshot`, `computer-use.browser_navigate`,
`computer-use.browser_click`, `computer-use.browser_type`,
`computer-use.browser_press`, `computer-use.browser_scroll`,
`computer-use.browser_search`, `computer-use.browser_claim`,
`computer-use.browser_dialogs`, `computer-use.browser_dialog`,
`computer-use.browser_downloads`, `computer-use.browser_presence`, and
`computer-use.browser_cursor`.

Add `--browser-provider chrome --browser-visibility background` for non-focusing
Chrome work. `browser_prepare` creates an inactive Uni-CLI-owned tab; existing
user tabs remain background-read-only and require an explicit `tab_id` for
observation. Use `foreground` only when user-tab mutation, edge presence, or the
virtual cursor is required. Snapshot refs are invalid after navigation or a
newer snapshot.

## Permissions

On macOS, grant Accessibility to the terminal or app that launches Claude Code.
Grant Screen Recording if you want screenshot capture. Windows and Linux use
the UIA and AT-SPI sidecars respectively.

## Verify

```bash
npx -y @zenalexa/unicli mcp serve --profile computer-use
```

The server banner should report `32 tools registered, mode=computer-use`.
