<!-- Generated from docs/guide/getting-started.md. Do not edit this copy directly. -->

# Quickstart

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/getting-started
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide/getting-started.md
- Section: Start
- Parent: Start (/)

Install Uni-CLI, search for the result you want, then run the selected operation.

## Prerequisites

- Node.js 22.19 or later
- npm

## 1. Install

```bash
npm install -g @zenalexa/unicli
```

Confirm the version.

```bash
unicli --version
```

Check for future releases without installing anything.

```bash
unicli upgrade --check -f json
```

## 2. Search by intent

```bash
unicli search "top Hacker News stories"
```

Uni-CLI ranks matching operations and shows the command, interface, effect, and target surface.

Search results also include the exact invocation, inspection command, authentication state, and setup command when login is required.

## 3. Plan from one goal

Use `do` when an agent needs the selected operation, argument schema, and next action in one response.

```bash
unicli do "show my saved Xiaohongshu notes" -f json
```

`do` plans the call. The agent reviews the selected effect and arguments, then runs the returned `next_action`.

## 4. Inspect the match

```bash
unicli describe hackernews top
```

`describe` shows the accepted arguments and an example invocation. It is the fastest way to prepare a reliable agent call.

## 5. Run the operation

```bash
unicli hackernews top --limit 5 -f json
```

A successful call returns a v2 envelope.

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

Paste this into an agent that can run shell commands.

```text
Install Uni-CLI with npm install -g @zenalexa/unicli.
Before using a website, app, or local tool, run unicli search "<intent>" or unicli do "<goal>".
Inspect the selected command with unicli describe <site> <command>, then run it with -f json.
When meta.update appears, run its unattended_command and retry the original task.
If authentication is required, follow the suggestion in the error envelope.
```

For MCP, Claude Desktop, Cursor, Codex, and other clients, continue to [Connect an agent](/guide/integrations).

## Find personal and account data

Personalized operations cover the signed-in user's feed, saved library, network, account, and activity surfaces. Filter the catalog when the intent contains terms such as `my`, `saved`, `following`, or `recommendations`.

```bash
unicli list --personalized
unicli list --site xiaohongshu --personalized
unicli search "my saved Xiaohongshu notes" --personalized
unicli describe xiaohongshu saved
unicli xiaohongshu saved --limit 20 -f json
```

The [operation catalog](/reference/sites) has matching Personalized and Auth required filters. Expand a site to inspect every registered command.

## When a site needs login

The error envelope names the next command. A typical setup follows.

```bash
unicli auth setup <site>
unicli auth import <site> --browser chrome
unicli auth check <site>
```

Browser-backed operations use Uni-CLI browser profiles and sessions. See [Authentication](/guide/authentication) and [Browser and desktop](/guide/browser-desktop).

## When an operation breaks

Read the error first. Adapter failures can include the source file, failed step, and a repair command.

```bash
unicli repair <site> <command> --dry-run
unicli repair <site> <command>
```

See [Self-repair](/guide/self-repair) for the complete workflow.

## Next steps

- [Find an operation](./)
- [Connect an agent](/guide/integrations)
- [Keep Uni-CLI current](/guide/upgrading)
- [Try common recipes](/RECIPES)
- [Browse the operation catalog](/reference/sites)
