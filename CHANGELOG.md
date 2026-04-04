# Changelog

All notable changes to Uni-CLI are documented here.
Version format: `MAJOR.MINOR.PATCH` — see [docs/TASTE.md](./docs/TASTE.md) for the codename system.

## [0.100.1] — Sputnik · Kedr

> *1957 — The first artificial satellite. First signal from orbit. Proof that it works.*
> *Kedr (Cedar) — Gagarin's call sign. The very first patch.*

### Added

- YAML pipeline execution engine: `fetch`, `select`, `map`, `filter`, `limit`
- 5 adapter types: `web-api`, `desktop`, `browser`, `bridge`, `service`
- TypeScript adapter support via `cli()` registration helper
- Multi-format output: `table`, `json`, `yaml`, `csv`, `md`
- Auto-detection of piped output (switches to JSON for AI agents)
- Adapter discovery from `src/adapters/` and `~/.unicli/adapters/`
- Exit codes following `sysexits.h` conventions
- Positional and option argument parsing from YAML adapter definitions

### Adapters (6 sites, 8 commands)

- **hackernews**: `top`, `search` — web-api, public
- **reddit**: `hot`, `search` — web-api, public
- **github-trending**: `daily` — web-api, public
- **blender**: `render` — desktop (requires blender)
- **ffmpeg**: `convert` — desktop (requires ffmpeg)
- **ollama**: `list` — service (requires ollama at localhost:11434)

### Agent Integration

- Agent Skills: `unicli-usage`, `unicli-explorer`, `unicli-operate`, `unicli-oneshot`
- AGENTS.md for cross-agent discoverability (Codex, Copilot, Cursor, OpenCode)
- CLAUDE.md for Claude Code integration
- MCP server stub for universal agent connectivity

### Community

- Apache-2.0 license
- CODE_OF_CONDUCT.md, GOVERNANCE.md, CODEOWNERS
- Issue templates: bug report, feature request, adapter request
- CI workflow: Node.js 20/22 matrix on Ubuntu
- Aerospace theme system: [docs/TASTE.md](./docs/TASTE.md)
- Full spaceflight codename registry: [docs/VERSION_CODENAMES.md](./docs/VERSION_CODENAMES.md)
