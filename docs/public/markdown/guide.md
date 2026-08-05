<!-- Generated from docs/guide/index.md. Do not edit this copy directly. -->

# Find An Operation

- Canonical: https://olo-dot-io.github.io/Uni-CLI/guide/
- Markdown: https://olo-dot-io.github.io/Uni-CLI/markdown/guide.md
- Section: Use Uni-CLI

Describe the result you want. Uni-CLI searches its local catalog and returns the closest commands with their interface, effect, and target.

```bash
unicli search "top Hacker News stories"
```

A result includes a command you can run directly:

```text
hackernews top  Hacker News top stories
unicli hackernews top
```

## Inspect the command

Use `describe` to see arguments, authentication, execution surface, and examples.

```bash
unicli describe hackernews top
```

Add `--full` when you need the complete operation contract.

```bash
unicli describe hackernews top --full -f json
```

## Run it

```bash
unicli hackernews top --limit 5 -f json
```

Output is Markdown in a terminal or pipe. Use `-f json`, `yaml`, `csv`, or `compact` when another program will read it.

## Narrow the search

Search can filter results before they reach the agent context.

```bash
unicli search "send a message" --effect send_message
unicli search "inspect a desktop app" --surface desktop
unicli search "read through an API" --operator structured-api
```

See the [operation catalog](/reference/sites) to browse by site, command, or interface.
