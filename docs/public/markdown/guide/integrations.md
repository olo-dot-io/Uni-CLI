<!-- Generated from docs/guide/integrations.md. Do not edit this copy directly. -->

# Connect An Agent

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/integrations
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide/integrations.md
- Section: Start
- Parent: Start (/)

Choose the connection that matches your agent host. Shell execution exposes the complete CLI. MCP and ACP provide protocol-native entry points.

## Shell

Any agent that can start a process can call Uni-CLI.

```bash
npm install -g @zenalexa/unicli
unicli search "list the latest Hacker News stories" -f json
```

Give the agent this short instruction:

```text
Use unicli search "<intent>" before operating a website, app, or local tool.
Use unicli describe <site> <command> to inspect arguments.
Run the selected command with -f json.
```

This path works well with Codex CLI, Claude Code, OpenCode, OpenClaw, Cursor agents, and CI jobs.

## Provider-native tools

Uni-CLI uses a provider-maintained CLI when it offers a stronger structured contract than the corresponding web surface. The selected executable remains visible in command metadata, and its JSON response passes through the normal Uni-CLI envelope.

The current first-party routes include Zhihu CLI, X `xurl`, Lark and Feishu `lark-cli`, and Bluesky `goat`.

```bash
unicli zhihu native-search "agent tools" -f json
unicli twitter native-search "from:XDevelopers MCP" -f json
unicli lark native-message-search "release" -f json
unicli bluesky native-resolve bsky.app -f json
```

Use `unicli ext list --tag social -f json` to inspect provider ownership, native surface, installation state, and scope. Reddit Devvit and the Slack CLI are marked as application-development tools so agents do not route workspace or community content requests through them. Slack content commands use the official Web API, while Slack's hosted MCP remains an external OAuth service.

Expanded MCP exposes the same typed `native-*` commands to MCP clients.

## MCP

Start the server with `npx`:

```json
{
  "mcpServers": {
    "unicli": {
      "command": "npx",
      "args": ["-y", "@zenalexa/unicli-mcp"]
    }
  }
}
```

The equivalent terminal command is:

```bash
npx -y @zenalexa/unicli mcp serve
```

Check the tools exposed by the selected profile:

```bash
unicli mcp health -f json
```

The default profile keeps discovery compact. Use `--expanded` when the client needs one MCP tool per adapter command.

## ACP

Start the Agent Client Protocol server:

```bash
unicli acp serve
```

Inspect available options with:

```bash
unicli help acp
```

## Authentication

Run authentication setup in the same user account and environment as the agent host:

```bash
unicli auth setup <site>
unicli browser profiles --json
unicli auth import <site> --browser chrome
```

See [Authentication](/guide/authentication) for stored credentials and live browser sessions.

## Verify the connection

Ask the client to perform a read-only call:

```text
Use Uni-CLI to list the top three Hacker News stories and return JSON.
```

The expected command is:

```bash
unicli hackernews top --limit 3 -f json
```
