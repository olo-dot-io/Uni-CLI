<!-- Generated from docs/guide/getting-started.md. Do not edit this copy directly. -->

# Getting Started

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/getting-started
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide/getting-started.md
- Section: Start
- Parent: Start (/)

Uni-CLI turns websites, desktop apps, services, and local tools into commands
that agents can search, run, and repair.

## Install

```bash
npm install -g @zenalexa/unicli
unicli --version
```

Requires Node.js 20 or later.

Every command follows the same shape:

```bash
unicli SITE COMMAND [args] [-f json|md|yaml|csv|compact]
```

Markdown is the default output format. Use `-f json` when a script or other
machine-oriented consumer needs JSON.

## Find A Command

```bash
unicli search "hacker news frontpage"
unicli search "github trending"
unicli list --site hackernews
```

## Run A Command

Run the selected command:

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

## Repair A Broken Command

When a command fails, read the structured error. It includes the adapter path
and pipeline step that need attention.

```bash
unicli repair SITE COMMAND
```

Typical loop:

```text
1. Read error.adapter_path and error.step.
2. Patch the YAML adapter.
3. Save a local override under ~/.unicli/adapters/SITE/COMMAND.yaml.
4. Re-run unicli repair SITE COMMAND.
```

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
- [Integrations](/guide/integrations)
- [Self-Repair](/guide/self-repair)
- [Pipeline Steps](/reference/pipeline)
- [Exit Codes](/reference/exit-codes)
