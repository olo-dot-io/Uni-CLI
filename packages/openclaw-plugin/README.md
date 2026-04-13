# @zenalexa/openclaw-unicli

OpenClaw plugin that exposes Uni-CLI as agent tools — 200 sites, 969 commands.

## Install

```bash
openclaw plugins install @zenalexa/openclaw-unicli
```

Or add manually to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": ["@zenalexa/openclaw-unicli"]
}
```

Requires `unicli` installed globally:

```bash
npm i -g @zenalexa/unicli
```

## Tools

| Tool | Description |
|------|-------------|
| `unicli_run` | Execute any Uni-CLI command (site + command + args) |
| `unicli_list` | List available sites and commands, filter by site or type |
| `unicli_discover` | Auto-discover API endpoints for any URL |

### unicli_run

```json
{
  "site": "hackernews",
  "command": "top",
  "limit": 10
}
```

### unicli_list

```json
{
  "site": "twitter",
  "type": "web-api"
}
```

### unicli_discover

```json
{
  "url": "https://example.com",
  "goal": "get trending posts"
}
```

## License

Apache-2.0
