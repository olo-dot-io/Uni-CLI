<!-- Generated from docs/faq.md. Do not edit this copy directly. -->

# FAQ

- Canonical: https://olo-dot-io.github.io/Uni-CLI/faq
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/faq.md
- Section: Project
- Parent: Project (/ARCHITECTURE)

## What is Uni-CLI?

Uni-CLI is an open-source command runtime for AI agents. It lets an agent search and operate websites, browser sessions, desktop applications, local tools, files, and protocol servers through one command model.

## What should I run first?

```bash
npm install -g @zenalexa/unicli
unicli search "top Hacker News stories"
unicli hackernews top --limit 5 -f json
```

The [Quickstart](/guide/getting-started) explains each step.

## Which agents can use it?

Any agent that can start a process can use the CLI. Uni-CLI also provides MCP and ACP servers for clients that prefer protocol connections. See [Connect an agent](/guide/integrations).

## What does the catalog contain?

v1.0.3 ships <span><!-- STATS:site_count -->326<!-- /STATS --></span> sites in the static adapter catalog.

The same catalog contains <span><!-- STATS:command_count -->1853<!-- /STATS --></span> registered commands. Core commands and host-discovered tools join at runtime. Browse the [operation catalog](/reference/sites) or run `unicli list`.

## How do I know which arguments a command accepts?

Run:

```bash
unicli describe <site> <command>
```

Use `--full` for effect, interaction, approval, evaluation, and repair details.

## How does login work?

Each operation declares a public, cookie, header, intercept, or UI strategy. `unicli auth setup <site>` shows the required credentials. `unicli browser profiles --json` and `unicli auth import` can reuse a local browser login. See [Authentication](/guide/authentication).

## Where does output go?

Successful data goes to stdout. Structured errors go to stderr and set a meaningful process exit code. Terminal output defaults to Markdown. Add `-f json`, `yaml`, `csv`, or `compact` for other consumers.

## What happens when a site changes?

Adapter errors can include the source file, failed step, and a suggested repair command. Update the named adapter, preview verification with `unicli repair <site> <command> --dry-run`, then run the verifier. See [Self-repair](/guide/self-repair).

## Can I add a site?

Yes. `unicli init <site> <command>` creates a YAML adapter, and `unicli dev <path>` reloads it during development. Start with [Create an adapter](/guide/adapters).

## CLI or MCP?

Use the CLI when the host can start a process and benefits from pipes, files, and complete command coverage. Use MCP when the host manages tools through an MCP server. Both read from the same operation catalog.

## Is Uni-CLI free?

Yes. The project uses the Apache-2.0 license and publishes the CLI as [`@zenalexa/unicli`](https://www.npmjs.com/package/@zenalexa/unicli).
