# Getting Started

Uni-CLI turns websites, desktop apps, services, and local tools into commands
that agents can search, run, and repair.

## Install

```bash
npm install -g @zenalexa/unicli
unicli --version
# 0.215.1
```

Requires Node.js 20 or later.

## Find A Command

```bash
unicli search "hacker news frontpage"
unicli search "小红书 搜索"
unicli list --site hackernews
```

## Run A Command

```bash
unicli hackernews top --limit 5
```

Use JSON when a script needs it:

```bash
unicli hackernews top --limit 5 -f json | jq '.[0]'
```

Supported formats:

```bash
unicli hackernews top -f md
unicli hackernews top -f json
unicli hackernews top -f yaml
unicli hackernews top -f csv
unicli hackernews top -f compact
```

## Authentication

Some adapters need local cookies:

```bash
unicli auth setup bilibili
unicli auth check bilibili
unicli bilibili feed
```

Cookies live at `~/.unicli/cookies/SITE.json`. Auth failures return exit
code `77` and a structured error with the next command to run.

## Browser Automation

Browser adapters use Chrome/CDP when HTTP is not enough.

```bash
unicli operate goto "https://example.com"
unicli operate snapshot
unicli operate click --ref 42
unicli operate type --ref 7 --text "hello"
unicli operate screenshot --path ./page.png
```

## Protocol Servers

MCP:

```bash
npx @zenalexa/unicli mcp serve
npx @zenalexa/unicli mcp serve --transport streamable --port 19826
```

ACP:

```bash
unicli acp
```

ACP is an editor compatibility gateway. For coding-agent runtime routing:

```bash
unicli agents matrix
unicli agents recommend codex
```

## Exit Codes

| Code | Meaning             | Agent action                             |
| ---- | ------------------- | ---------------------------------------- |
| 0    | Success             | Use the data                             |
| 66   | Empty result        | Try different parameters                 |
| 69   | Service unavailable | Retry later                              |
| 75   | Temporary failure   | Retry with backoff                       |
| 77   | Auth required       | Run `unicli auth setup SITE`             |
| 78   | Config error        | Read the error envelope and adapter YAML |

## Next Steps

- [Adapters](/guide/adapters)
- [Self-Repair](/guide/self-repair)
- [Pipeline Steps](/reference/pipeline)
- [Exit Codes](/reference/exit-codes)
