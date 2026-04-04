# Uni-CLI — CLI is all agents need

> Agent infrastructure for touching, sensing, understanding, modifying, and controlling any internet application and local software via CLI.

## Quick Reference

```bash
unicli list                        # All available commands (JSON when piped)
unicli <site> <command> [options]  # Run a command
unicli doctor                     # System health + adapter count
unicli repair <site> <command>    # Diagnose broken adapter
unicli test [site]                # Smoke test adapters
```

## Agent Output Protocol

- **Piped output** → auto-JSON (no flag needed)
- **Errors** → structured JSON to stderr:
  ```json
  {
    "error": "HTTP 403",
    "adapter": "src/adapters/twitter/search.yaml",
    "step": 0,
    "action": "fetch",
    "suggestion": "API requires cookie auth. Change strategy to cookie."
  }
  ```
- **Exit codes**: 0=ok, 1=error, 2=usage, 66=empty, 69=unavailable, 77=auth, 78=config

## Self-Repair Protocol

When a command fails:

1. Read the structured error (includes `adapter` path)
2. Read the YAML adapter file (20 lines, no imports)
3. Edit the YAML to fix the issue (URL, selector, params)
4. Save fix to `~/.unicli/adapters/<site>/<command>.yaml` (persists across updates)
5. Verify: `unicli repair <site> <command>` or `unicli test <site>`

## Output Formats

All commands: `--format` / `-f` → `table` (default), `json`, `yaml`, `csv`, `md`

## Available Sites (0.201.0)

43 sites, 141 commands. Run `unicli list -f json` for full inventory.

## Adding Adapters

Drop YAML files into `src/adapters/<site>/` or `~/.unicli/adapters/<site>/`.
User adapters in `~/.unicli/adapters/` override built-in ones.
