# Getting Started

Uni-CLI turns websites, desktop apps, services, and local tools into commands
that agents can search, run, and repair.

The point is not "open a page for the agent." The point is a stable way for an
agent to call real software. A command keeps arguments, auth, surface type,
output shape, and error handling in one public contract. When an external page
or API changes, the failure points back to a repairable adapter and pipeline
step.

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

## Understand The Flow

The common path has three steps:

1. **Search**: `unicli search` finds candidate commands from natural language
   without touching the external surface.
2. **Execute**: `unicli SITE COMMAND` runs the selected command with inspectable
   arguments and auth boundaries.
3. **Repair**: structured failures include the adapter path, pipeline step,
   suggestion, and alternatives.

This differs from asking an agent to write a one-off browser script. Browser
automation, CDP, accessibility trees, subprocesses, service APIs, and CUA are
transport choices. The stable layer is the command catalog and adapter.

## Find A Command

```bash
unicli search "hacker news frontpage"
unicli search "github trending"
unicli list --site hackernews
```

Search narrows the candidate set. Before execution, the agent can still inspect
the command name, arguments, auth requirements, and surface type. That keeps
"found a possible operation" separate from "performed the operation."

## Run A Command

Run the selected command:

```bash
unicli hackernews top --limit 5
```

The default Markdown output contains data, context, and suggested next actions.
It is meant to stay readable in terminals, chat transcripts, and agent logs.

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

The goal is not to retry until it works. The goal is to make the command match
its public output shape again. YAML adapters are usually short enough for agents
to read, patch, diff, and verify; use TypeScript adapters only when the runtime
logic cannot stay declarative.

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
