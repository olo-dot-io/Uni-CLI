# Integrations

Uni-CLI is designed to be called directly from a shell. Agent clients that need
a protocol server can use the same catalog over MCP, ACP, or generated platform
configuration while keeping adapter behavior identical.

## Choose A Path

| Client need                         | Use                                       |
| ----------------------------------- | ----------------------------------------- |
| Any agent can run shell commands    | Native `unicli` CLI                       |
| Tool-calling clients that speak MCP | `unicli mcp serve`                        |
| Editor clients that speak ACP       | `unicli acp`                              |
| Platform-specific setup             | `unicli agents generate`                  |
| Runtime/backend selection           | `unicli agents matrix` / `recommend`      |
| Skill-native adapter discovery      | `unicli skills export` / `skills publish` |

Prefer the native CLI when the agent has shell access. It keeps discovery lazy,
outputs compact, and preserves Unix composition.

## Native CLI

```bash
unicli search "hacker news frontpage"
unicli hackernews top --limit 5 -f json
```

Add this short contract to `AGENTS.md`, `CLAUDE.md`, or the equivalent agent
context file:

```markdown
Use `unicli search "intent"` before choosing a command. Run commands as
`unicli SITE COMMAND [args]`. Prefer `-f json` for scripts and structured
Markdown for human-readable agent output.
```

For higher-risk runs, inspect before execution:

```bash
unicli describe SITE COMMAND
unicli SITE COMMAND --dry-run
unicli SITE COMMAND --record
```

## MCP

Start a stdio server:

```bash
npx @zenalexa/unicli mcp serve
```

Start a Streamable HTTP server:

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

Default MCP tools:

| Tool             | Purpose                                     |
| ---------------- | ------------------------------------------- |
| `unicli_search`  | Search commands by natural-language intent. |
| `unicli_run`     | Run a selected site command.                |
| `unicli_list`    | List sites and commands.                    |
| `unicli_explore` | Inspect a page before authoring an adapter. |

`mcp serve` and `acp` keep raw stdio protocol behavior. Normal command surfaces
return the v2 `AgentEnvelope`.

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

## ACP

ACP is an editor compatibility path for clients such as avante.nvim and Zed.
MCP fits structured tool calls. ACP fits prompt/session frames.

```bash
unicli acp
```

Minimal avante.nvim provider:

```lua
require("avante").setup({
  providers = {
    {
      name = "unicli",
      command = "unicli",
      args = { "acp" },
      type = "acp",
    },
  },
})
```

ACP prompts should include an explicit command:

```text
Show the top 10 HN posts:
unicli hackernews top --limit 10
```

## Agent Platform Recipes

Generate config where possible instead of hand-writing it:

```bash
unicli agents matrix
unicli agents recommend codex
unicli agents generate --for claude
unicli agents generate --for codex
unicli agents generate --for opencode
```

Backend recommendations model native CLI, JSON stream, MCP, ACP, HTTP API,
OpenAI-compatible routes, bridge CLIs, and CUA candidates explicitly.

## Skills

Export adapter commands as `SKILL.md` files when the agent runtime has a local
skills directory:

```bash
unicli skills export
unicli skills publish --to ~/.cursor/skills/uni-cli/
unicli skills catalog --out /tmp/unicli-skills.json
```

The generated files include command name, when-to-use text, auth notes, and a
call example. They complement runtime discovery for agents that load skills at
startup.

Manual examples:

```bash
# Claude Code MCP
claude mcp add unicli -- npx @zenalexa/unicli mcp serve
```

```jsonc
// OpenCode
{
  "mcp": {
    "unicli": {
      "type": "local",
      "command": ["npx", "-y", "@zenalexa/unicli", "mcp", "serve"],
      "enabled": true,
    },
  },
}
```

```yaml
# Hermes Agent
mcp_servers:
  unicli:
    command: "npx"
    args: ["-y", "@zenalexa/unicli", "mcp", "serve"]
```

## Auth

All integration paths use the same local credentials as the CLI:

```bash
unicli auth setup SITE
unicli auth check SITE
```

Cookie path:

```text
~/.unicli/cookies/SITE.json
```

## Verify

```bash
unicli list
unicli search "hacker news frontpage"
unicli hackernews top --limit 5
```
