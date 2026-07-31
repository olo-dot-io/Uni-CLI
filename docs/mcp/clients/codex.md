# Codex Computer Use

Codex desktop can already have its own `computer-use` plugin. To swap the MCP
server name to Uni-CLI while keeping compatible tool names, configure:

```toml
# ~/.codex/mcp.toml
[mcp.servers.computer-use]
command = "npx"
args = ["-y", "@zenalexa/unicli", "mcp", "serve", "--profile", "computer-use"]
```

Existing prompts that call `computer-use.*` tools can keep the same prefix.
Uni-CLI plans one provider before execution: macOS AX, Windows UIA, or Linux
AT-SPI for native refs; CDP for exact browser/Electron targets; subprocess for
app launch; and visual coordinates only when the request explicitly selects
`via: visual`.

Append `--browser-provider chrome --browser-visibility background` to `args`
for non-focusing Chrome work. `browser_prepare` creates an inactive owned tab;
existing user tabs stay background-read-only and use explicit `tab_id` values.
Use `foreground` only for user-tab mutation, edge presence, or the virtual
cursor. The profile exposes 16 desktop and 16 direct browser tools.

## Permissions

On macOS, grant Accessibility to Codex or to the terminal process that launches
the MCP server. Grant Screen Recording for screenshot capture. Windows and
Linux require the platform accessibility services used by UIA and AT-SPI.

## Verify

```bash
npx -y @zenalexa/unicli mcp serve --profile computer-use
```

The server banner should report `32 tools registered, mode=computer-use`.
