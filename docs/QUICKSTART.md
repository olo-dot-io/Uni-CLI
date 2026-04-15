# Quickstart

Five worked examples. Each one runs end-to-end in under a minute.

> Install once:
>
> ```bash
> npm install -g @zenalexa/unicli
> unicli --version
> ```

Every `unicli` command follows the same shape: `unicli <site> <command> [--flags]`. Piped output auto-switches to JSON (no `--json` flag needed). Errors emit structured JSON to stderr with the adapter path, the failing step, and a fix suggestion.

---

## 1. Reddit — zero-config web API

Goal: pull 5 hot posts from `r/popular` and see the minimum viable Uni-CLI call.

```bash
unicli reddit hot --limit 5
```

Expected output (TTY):

```
title                                         score   num_comments   subreddit
─────────────────────────────────────────────  ──────  ─────────────  ──────────
Show HN: I wrote a bilingual CLI for agents    12543   842            programming
NASA confirms Vostok-class orbit for new…      9880    512            space
…                                              …       …              …
```

Piped output is JSON automatically:

```bash
unicli reddit hot --limit 5 | jq '.[0].title'
# → "Show HN: I wrote a bilingual CLI for agents"
```

**Troubleshooting.** If Reddit returns HTTP 429, Uni-CLI retries with backoff. Persistent failure means the Reddit JSON endpoint changed; run `unicli repair reddit hot` — it prints the failing step and the adapter path (`src/adapters/reddit/hot.yaml`). Edit the 20-line YAML and retry.

---

## 2. Twitter — cookie-based auth

Goal: fetch a public profile timeline. Twitter requires authentication even for public reads, so Uni-CLI uses your browser cookies.

**Step 1 — configure cookies.** Run once:

```bash
unicli auth setup twitter
```

This prints the cookie fields Twitter needs (`auth_token`, `ct0`) and the target file path (`~/.unicli/cookies/twitter.json`). Copy the values from Chrome DevTools → Application → Cookies → `twitter.com`.

Cookie file format:

```json
{
  "auth_token": "paste-here",
  "ct0": "paste-here"
}
```

Verify:

```bash
unicli auth check twitter
# → twitter: ok (3 cookies, strategy=header)
```

**Step 2 — run the command:**

```bash
unicli twitter profile elonmusk
```

Expected output shape (JSON):

```json
[
  {
    "id": "179292…",
    "text": "Working on…",
    "created_at": "2026-04-15T…",
    "likes": 12840,
    "retweets": 1920
  }
]
```

**Troubleshooting.** Exit code `77` (`EX_NOPERM`) means the cookie file is missing or stale. Rotate cookies: sign out and back into Twitter, then copy the fresh `auth_token`. The auto-extracted CSRF token (`ct0`) must match the `auth_token` session — take both from the same browser session.

---

## 3. Hacker News — pipe and transform with jq

Goal: fetch the top 30 HN stories and extract only the titles. This is the canonical agent use case — Uni-CLI streams JSON, shell tools do the shaping.

```bash
unicli hackernews top --limit 30 --json | jq -r '.[].title'
```

Expected output (one title per line):

```
Show HN: I wrote a bilingual CLI for agents
Ask HN: What's your 2026 tech stack?
OpenAI's GPT-5 benchmarks land
…
```

Add a score filter:

```bash
unicli hackernews top --limit 100 --json | jq '[.[] | select(.score > 500)] | length'
# → 14
```

Combine multiple sources:

```bash
(unicli hackernews top --limit 10; unicli reddit hot --limit 10) \
  | jq -s 'add | sort_by(-.score)'
```

**Troubleshooting.** The `--json` flag is optional when piping — Uni-CLI detects non-TTY stdout and switches to JSON automatically. Force JSON in a TTY with `--json` when you want to inspect raw output during development. If `jq` isn't installed, `npm install -g node-jq` or `brew install jq`.

---

## 4. ACP — avante.nvim editor integration

Goal: drive Uni-CLI from inside Neovim using the Agent Client Protocol. Every Uni-CLI command becomes reachable as an avante provider prompt.

**Step 1 — verify the ACP subcommand:**

```bash
unicli acp --help
```

**Step 2 — configure avante.nvim (`~/.config/nvim/lua/plugins/avante.lua`):**

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

**Step 3 — prompt it:**

Inside Neovim, open the avante panel and type:

```
Show me the top 5 HN posts:
unicli hackernews top --limit 5
```

avante spawns `unicli acp`, speaks JSON-RPC 2.0 over stdio, and streams the result back into the buffer.

Expected response (`prompt/submit` result):

```json
{
  "sessionId": "a1b2…",
  "ok": true,
  "content": [{ "type": "text", "text": "unicli hackernews top: 5 result(s)" }],
  "data": [
    /* 5 HN rows */
  ],
  "count": 5
}
```

**Troubleshooting.** If avante reports "no response from provider", run `unicli acp` by hand in a terminal and send a handshake:

```
{"jsonrpc":"2.0","id":1,"method":"initialize"}
```

You should see a JSON response within one second. If nothing appears, re-run `npm install -g @zenalexa/unicli`. Full ACP protocol reference: [`docs/AVANTE.md`](./AVANTE.md).

---

## 5. MCP — serve every command to Claude Code or Cursor

Goal: run Uni-CLI as an MCP server so any MCP-aware agent can browse and invoke all 959 commands through 4 meta-tools (~200 tokens cold-start).

**Option A — stdio (default, lowest latency):**

```bash
# Claude Code one-liner:
claude mcp add unicli -- npx @zenalexa/unicli mcp serve

# Codex CLI (~/.codex/config.toml):
[mcp_servers.unicli]
command = "npx"
args = ["@zenalexa/unicli", "mcp", "serve"]
```

**Option B — Streamable HTTP on port 19826 (remote access, multi-client):**

```bash
unicli mcp serve --transport streamable --port 19826
```

Expected startup output (stderr):

```
[mcp] transport=streamable port=19826 endpoint=/mcp
[mcp] tools=4 (unicli_run, unicli_list, unicli_search, unicli_explore)
[mcp] ready
```

Point your client at `http://localhost:19826/mcp`. For remote deployment add OAuth 2.1 PKCE:

```bash
unicli mcp serve --transport streamable --port 19826 --auth
```

**Agent interaction pattern.** The agent calls `unicli_search` with a natural-language intent (bilingual EN/ZH), gets back the top 5 matching commands, then calls `unicli_run` with the chosen site + command. The search index is 50KB, queries complete in under 10ms.

```json
// Agent → unicli_search
{ "query": "hacker news frontpage" }

// Server →
{
  "results": [
    { "site": "hackernews", "command": "top", "score": 18.4 },
    { "site": "hackernews", "command": "new", "score": 12.1 }
  ]
}
```

**Troubleshooting.** If the port is busy, pick another with `--port 19827`. For Claude Code, confirm the server registered with `claude mcp list`. Streamable HTTP requires MCP spec 2025-11-25 — older clients that speak SSE can use `--transport sse --port 19826` instead.

---

## Where to go next

| You want to…                | Read                                                            |
| --------------------------- | --------------------------------------------------------------- |
| Write a new adapter         | [`docs/ADAPTER-FORMAT.md`](./ADAPTER-FORMAT.md)                 |
| Understand the architecture | [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)                     |
| See the theory + citations  | [`docs/THEORY.md`](./THEORY.md)                                 |
| Run your own benchmarks     | [`docs/BENCHMARK.md`](./BENCHMARK.md)                           |
| Migrate from OpenCLI        | [`docs/MIGRATING-FROM-OPENCLI.md`](./MIGRATING-FROM-OPENCLI.md) |
| Expose Uni-CLI over ACP     | [`docs/AVANTE.md`](./AVANTE.md)                                 |
