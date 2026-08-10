<!-- Generated from docs/index.md. Do not edit this copy directly. -->

# Overview

- Canonical: https://olo-dot-io.github.io/Uni-CLI/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/index.md
- Section: Start

## One command interface for agents

Uni-CLI gives agents one command model for searching and operating websites, browser sessions, desktop apps, local tools, files, and protocol services.

## First Run

```bash
npm install -g @zenalexa/unicli
unicli search "list the top Hacker News stories"
unicli describe hackernews top
unicli hackernews top --limit 5 -f json
```

## How It Works

1. Describe the result with `unicli search`.
2. Inspect arguments, authentication, and output with `unicli describe`.
3. Run the selected command. Use `-f json` for agents and scripts.
4. If a command fails, read the structured error on stderr and use `unicli repair` to inspect the repair path.

## Interfaces

- Websites and public APIs
- Logged-in browser sessions
- Desktop apps and macOS capabilities
- Local CLIs, files, and protocol services
- MCP and ACP clients

## Coverage

- Static adapter sites: 337
- Registered adapter operations: 1890
- Built-in actions: 113 (58 registered + 55 transport-native)
- Tests: 10314

These totals come from the current static adapter catalog. Core commands and host-discovered tools join at runtime.

## Entrypoints

- [Quickstart](/guide/getting-started): install Uni-CLI and run the first command.
- [Connect an Agent](/guide/integrations): choose CLI, MCP, or ACP.
- [Operation Catalog](/reference/sites): browse the current sites and commands.
- [Create an Adapter](/guide/adapters): add a new software interface.
- [CLI Reference](/reference/cli): see the complete command entry points.

## Current Version

Local release: v1.1.1 · Artemis · Koch.

## Agent Index

- [/llms.txt](/llms.txt)
- [/llms-full.txt](/llms-full.txt)
