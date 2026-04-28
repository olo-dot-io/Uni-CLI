<!-- Generated from docs/index.md. Do not edit this copy directly. -->

# Overview

- Canonical: https://olo-dot-io.github.io/Uni-CLI/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/index.md
- Section: Start

## Software execution for agents

Agents are moving from chat assistance to task-running systems. They need to call CLIs, APIs, browsers, and desktop apps, while keeping audit trails, permission boundaries, and recovery paths. Uni-CLI turns those software surfaces into one searchable, executable, traceable, and repairable command interface.

## First Command

```bash
npm install -g @zenalexa/unicli
unicli search "twitter trending"
unicli twitter trending --limit 10 -f json
```

## Positioning

The gap is not another protocol. It is the engineering surface around agent execution. MCP improves interoperability. Browser and computer-use automation close API gaps. Production agent workflows still need a command catalog, policy, inspectable output, exit codes, and repair loops.

- **Unified entry.** One catalog covers public APIs, cookie sessions, browsers, desktop apps, external CLIs, and local capabilities.
- **Auditable execution.** Arguments, auth, policy profiles, output shape, and exit codes stay inspectable before and after a run.
- **Recoverable failure.** When a surface changes, the error names the adapter file, pipeline step, and verification command.

## Coverage

- Sites and tools: 235
- Commands: 1448
- Pipeline steps: 59
- Output contract: v2 AgentEnvelope

One call path spans public APIs, cookie sessions, browsers, desktop apps, external CLIs, and local system capabilities. Agents learn one call path.

## Entrypoints

- [First Run](/guide/getting-started): install, search, execute, authenticate, and read exit codes.
- [Command Catalog](/reference/sites): browse by site, surface type, auth strategy, and examples.
- [Adapters](/guide/adapters): YAML adapters, pipeline steps, self-repair, and verification.

## Current Version

Latest: v0.217.0 · Apollo · Lovell.

## Agent Index

- [/llms.txt](/llms.txt)
- [/llms-full.txt](/llms-full.txt)
