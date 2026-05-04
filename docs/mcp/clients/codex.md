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
Uni-CLI routes the calls through the cross-platform compute cascade: macOS AX,
Windows UIA, Linux AT-SPI, CDP for Electron targets, then configured fallbacks.

## Permissions

On macOS, grant Accessibility to Codex or to the terminal process that launches
the MCP server. Grant Screen Recording for screenshot fallback. Windows and
Linux require the platform accessibility services used by UIA and AT-SPI.

## Verify

```bash
npx -y @zenalexa/unicli mcp serve --profile computer-use
```

The server banner should report `15 tools registered, mode=computer-use`.
