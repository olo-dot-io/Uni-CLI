# @zenalexa/openclaw-unicli

OpenClaw Bundle MCP plugin that exposes Uni-CLI as an MCP server — 220 sites, 1283 commands.

## How It Works

This is a Bundle MCP plugin. OpenClaw reads `openclaw.plugin.json`, finds the `mcpServers` block, and launches `unicli mcp serve` as a child process. All four smart-default tools (`unicli_run`, `unicli_list`, `unicli_search`, `unicli_explore`) are available immediately inside OpenClaw without any extra configuration.

## Requirements

`unicli` must be installed globally before loading this plugin:

```bash
npm i -g @zenalexa/unicli
```

## Install

```bash
openclaw plugins install @zenalexa/openclaw-unicli
```

Or copy `openclaw.plugin.json` manually to `~/.openclaw/plugins/unicli/openclaw.plugin.json`.

## Tools

| Tool             | Description                                               |
| ---------------- | --------------------------------------------------------- |
| `unicli_run`     | Execute any Uni-CLI command (site + command + args)       |
| `unicli_list`    | List available sites and commands, filter by site or type |
| `unicli_search`  | Search commands by intent, including bilingual EN/ZH      |
| `unicli_explore` | Auto-discover API endpoints for any URL                   |

### unicli_run

```json
{ "site": "hackernews", "command": "top", "limit": 10 }
```

### unicli_list

```json
{ "site": "twitter", "type": "web-api" }
```

### unicli_search

```json
{ "query": "推特热门", "limit": 5 }
```

### unicli_explore

```json
{ "url": "https://example.com", "goal": "get trending posts" }
```

## License

Apache-2.0
