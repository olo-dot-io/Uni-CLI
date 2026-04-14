# avante.nvim Integration

Uni-CLI ships an Agent Client Protocol (ACP) server at `unicli acp`.
avante.nvim, Zed, and any other ACP-compatible editor can treat Uni-CLI as
an agent provider — every invocation flows through the same pipeline
runner the CLI uses, so 200+ sites and 950+ commands are reachable from
inside your editor with zero extra wiring.

## What is ACP?

The Agent Client Protocol is the JSON-RPC 2.0 contract the Zed team and
Google's Gemini CLI adopted in March 2026 for editor ↔ agent
communication. The canonical spec lives at
[zed-industries/agent-client-protocol](https://github.com/zed-industries/agent-client-protocol).

ACP is strictly narrower than MCP:

- ACP carries a user **prompt** plus a stream of **content chunks**.
- MCP carries **tool calls** plus **structured JSON results**.

Uni-CLI speaks both. Use ACP when you want natural-language prompts
dispatched to Uni-CLI commands; use MCP when you want your agent to pick
from the tool catalog directly.

## Install

```bash
npm install -g @zenalexa/unicli
```

Verify the `acp` subcommand is present:

```bash
unicli acp --help
```

## Configure avante.nvim

avante.nvim's `acp` provider type spawns a subprocess and speaks JSON-RPC
2.0 over stdio. The minimum configuration is:

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

Add `--debug` to the args list when investigating dispatch issues — it
logs every method name to stderr without polluting the JSON-RPC frames on
stdout.

## Example prompts

ACP prompts are plain strings. The Uni-CLI ACP server looks for a
`unicli <site> <command>` invocation anywhere in the prompt and executes
it; everything else is ignored. Typical prompts:

```text
Show me the top 10 HN posts:
unicli hackernews top --limit 10
```

```text
Search Twitter for "claude code":
unicli twitter search "claude code"
```

```text
Fetch my Xiaohongshu feed:
unicli xiaohongshu feed
```

The server streams progress over `content/updated` notifications and
returns a final JSON payload in the `prompt/submit` response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "a1b2…",
    "ok": true,
    "content": [
      { "type": "text", "text": "unicli hackernews top: 10 result(s)…" }
    ],
    "data": [
      /* 10 HN rows */
    ],
    "count": 10
  }
}
```

When the prompt has no `unicli` invocation, the server returns a set of
suggestions derived from a lightweight substring match over the adapter
catalog. Agents should fall back to `unicli list` (or the MCP
`unicli_search` tool) for richer discovery.

## Sessions

ACP sessions are optional. If the client omits `sessionId` in
`prompt/submit`, the server generates a fresh UUID and returns it in the
response. The server keeps the last prompt + result per session so a
client can call `session/list` or `session/cancel` mid-flight.

```text
session/create     → { sessionId }
session/cancel     → { cancelled: true }
session/list       → { sessions: [...] }
```

## Troubleshooting

| Symptom                                                   | Fix                                                                                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| avante.nvim reports "no response from provider"           | Run `unicli acp` by hand in a terminal and send `{"jsonrpc":"2.0","id":1,"method":"initialize"}\n` on stdin — you should see a JSON response within a second. If nothing appears, run `npm install -g @zenalexa/unicli` again. |
| Server exits immediately                                  | Check stderr in your Neovim log; the most common cause is a missing Node.js 20+ runtime. `node --version` should print ≥ 20.                                                                                                   |
| Commands return `Unknown command`                         | The prompt format is `unicli <site> <command>` — make sure both tokens appear and match the registry. `unicli list --site <name>` shows the exact commands available.                                                          |
| Auth-gated commands (Twitter, Xiaohongshu, Bilibili) fail | Run `unicli auth setup <site>` once in a terminal. Cookies persist in `~/.unicli/cookies/<site>.json` and every invocation (CLI, MCP, ACP) reads the same file.                                                                |
| You want to see which method was dispatched               | Restart with `args = { "acp", "--debug" }`. Every request logs `[acp] → <method>` on stderr.                                                                                                                                   |

## Design notes

- All protocol framing is newline-delimited JSON on stdout; stderr is
  free-form log text.
- The server advertises `protocolVersion: 2026-03-27` in `initialize`
  (the version pinned by Gemini CLI). Clients that speak an older spec
  can still talk to us — we accept the canonical method names
  (`prompt/submit`, `session/create`) plus a couple of Zed aliases
  (`sendUserMessage`, `newSession`) for forward compatibility.
- No authentication is performed at the ACP layer. Cookie-backed
  adapters resolve credentials from `~/.unicli/cookies` on each
  pipeline execution, identical to the behaviour of `unicli <site>
<command>` in a terminal.
