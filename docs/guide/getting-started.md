---
title: Quickstart
description: Install Uni-CLI, find an operation, and run your first command in a few minutes.
---

# Quickstart

Install Uni-CLI, search for the result you want, then run the selected operation.

## Prerequisites

- Node.js 22.19 or later
- npm

## 1. Install

```bash
npm install -g @zenalexa/unicli
```

Confirm the version:

```bash
unicli --version
```

## 2. Search by intent

```bash
unicli search "top Hacker News stories"
```

Uni-CLI ranks matching operations and shows the command, interface, effect, and target surface.

## 3. Inspect the match

```bash
unicli describe hackernews top
```

`describe` shows the accepted arguments and an example invocation. It is the fastest way to prepare a reliable agent call.

## 4. Run the operation

```bash
unicli hackernews top --limit 5 -f json
```

A successful call returns a v2 envelope:

```json
{
  "ok": true,
  "schema_version": "2",
  "command": "hackernews.top",
  "data": [{ "rank": "1", "title": "...", "url": "https://..." }],
  "error": null
}
```

## Use Uni-CLI from an agent

Paste this into an agent that can run shell commands:

```text
Install Uni-CLI with npm install -g @zenalexa/unicli.
Before using a website, app, or local tool, run unicli search "<intent>".
Inspect the selected command with unicli describe <site> <command>, then run it with -f json.
If authentication is required, follow the suggestion in the error envelope.
```

For MCP, Claude Desktop, Cursor, Codex, and other clients, continue to [Connect an agent](./integrations).

## When a site needs login

The error envelope names the next command. A typical setup is:

```bash
unicli auth setup <site>
unicli auth import <site> --browser chrome
unicli auth check <site>
```

Browser-backed operations use Uni-CLI browser profiles and sessions. See [Authentication](./authentication) and [Browser and desktop](./browser-desktop).

## When an operation breaks

Read the error first. Adapter failures can include the source file, failed step, and a repair command.

```bash
unicli repair <site> <command> --dry-run
unicli repair <site> <command>
```

See [Self-repair](./self-repair) for the complete workflow.

## Next steps

- [Find an operation](./)
- [Connect an agent](./integrations)
- [Try common recipes](/RECIPES)
- [Browse the operation catalog](/reference/sites)
