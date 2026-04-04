# Uni-CLI — CLI IS ALL YOU NEED

> Universal CLI for AI agents. Turn any website, desktop app, cloud service, or system tool into a CLI command.

## Available Commands

```bash
unicli list                        # List all available commands
unicli <site> <command> [options]  # Run a command
unicli doctor                     # Check system health
```

## Output Formats

All commands support `--format` / `-f` with `table` (default), `json`, `yaml`, `csv`, `md`.
When stdout is piped (non-TTY), output defaults to `json` for agent consumption.

```bash
unicli hackernews top -f json      # Structured JSON for parsing
unicli hackernews top              # Human-readable table
```

## Exit Codes

| Code | Meaning              |
|------|----------------------|
| 0    | Success              |
| 1    | Generic error        |
| 2    | Usage error          |
| 66   | Empty result         |
| 69   | Service unavailable  |
| 75   | Temporary failure    |
| 77   | Auth required        |
| 78   | Config error         |

## Adding Adapters

Drop YAML or TS files into `src/adapters/<site>/` — auto-registered at startup.

See `docs/adapters/yaml-format.md` for the adapter schema.
