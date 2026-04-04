# Changelog

All notable changes to Uni-CLI are documented here.
Releases are named after milestones in human spaceflight history.

## [Unreleased] — Sputnik

> *1957 — The first artificial satellite. First signal from orbit. Proof that it works.*

### Added

- Core adapter registry with dynamic command routing
- YAML adapter format supporting 5 adapter types: `web-api`, `desktop`, `browser`, `bridge`, `service`
- TypeScript adapter support via `cli()` registration helper
- Multi-format output: `table`, `json`, `yaml`, `csv`, `md`
- Auto-detection of piped output (switches to JSON for AI agents)
- Adapter discovery from `src/adapters/` and `~/.unicli/adapters/`
- Exit codes following `sysexits.h` conventions
- `unicli list` — list all available commands with filtering
- `unicli doctor` — system health diagnostics
- HackerNews adapter: `top`, `search` (public API, zero auth)
- Agent Skills: `unicli-usage`, `unicli-explorer`, `unicli-operate`, `unicli-oneshot`
- MCP server stub for AI agent integration
- AGENTS.md for cross-agent discoverability
- CLAUDE.md for Claude Code integration
