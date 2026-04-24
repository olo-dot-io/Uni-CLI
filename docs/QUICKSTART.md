# Quickstart

Install once:

```bash
npm install -g @zenalexa/unicli
unicli --version
```

Every command follows the same shape:

```bash
unicli SITE COMMAND [args] [-f json|md|yaml|csv|compact]
```

Non-TTY and agent runs default to structured Markdown. Use `-f json` when a
script needs JSON.

## 1. Discover A Command

Search by intent first. Search is bilingual and returns runnable command names.

```bash
unicli search "hacker news frontpage"
unicli search "微博热搜"
```

Then inspect a site or the whole catalog:

```bash
unicli list --site hackernews
unicli list
```

## 2. Run A Public API Adapter

```bash
unicli hackernews top --limit 5
```

JSON for scripts:

```bash
unicli hackernews top --limit 5 -f json | jq '.[0]'
```

## 3. Run An Auth-Required Adapter

Some sites need local cookies.

```bash
unicli auth setup twitter
unicli auth check twitter
unicli twitter search "coding agents" -f json
```

Cookie files live at `~/.unicli/cookies/SITE.json`. The command-specific
error envelope will tell you when auth is missing or stale.

## 4. Use MCP

Stdio:

```bash
npx @zenalexa/unicli mcp serve
```

Streamable HTTP:

```bash
npx @zenalexa/unicli mcp serve --transport streamable --port 19826
```

Default MCP tools:

- `unicli_search`
- `unicli_run`
- `unicli_list`
- `unicli_explore`

The normal pattern is search first, run second.

## 5. Use ACP

```bash
unicli acp
```

ACP is the compatibility path for editors and bridge tooling. For coding-agent
runtimes, inspect the route matrix:

```bash
unicli agents matrix
unicli agents recommend codex
```

## 6. Repair A Broken Adapter

When a command fails, read the structured error. It includes the file and step
that need attention.

```bash
unicli repair SITE COMMAND
```

Typical repair loop:

```text
1. Read error.adapter_path and error.step.
2. Patch the YAML adapter.
3. Save a local override under ~/.unicli/adapters/SITE/COMMAND.yaml.
4. Re-run unicli repair SITE COMMAND.
```

## Next

| You want to               | Read                                          |
| ------------------------- | --------------------------------------------- |
| Write an adapter          | [Adapter format](./ADAPTER-FORMAT.md)         |
| See pipeline steps        | [Pipeline reference](./reference/pipeline.md) |
| Understand runtime layout | [Architecture](./ARCHITECTURE.md)             |
| Expose Uni-CLI over ACP   | [AVANTE](./AVANTE.md)                         |
| Run benchmark scripts     | [Benchmark](./BENCHMARK.md)                   |
