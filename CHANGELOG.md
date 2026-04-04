# Changelog

All notable changes to Uni-CLI are documented here.
Version format: `MAJOR.MINOR.PATCH` — see [docs/TASTE.md](./docs/TASTE.md) for the codename system.

## [0.200.0] — Vostok · Chaika

> _1961 — First human in space. Yuri Gagarin orbited Earth in 108 minutes._
> _Chaika (Seagull) — Valentina Tereshkova's call sign. First woman in space._

### Engine

- Pipe filter system: 15 filters (join, urlencode, truncate, strip_html, slice, replace, split, first, last, length, trim, default, lowercase, uppercase)
- RSS/XML parsing: `fetch_text` + `parse_rss` pipeline steps
- Desktop exec: `exec` step with json/lines/csv/text output parsing
- Sort step: `sort` with by/order
- Resilient loader: skip malformed YAML gracefully

### Self-Repair Architecture

- Structured pipeline errors: JSON with adapter_path, step, action, suggestion
- `unicli repair <site> <command>` — diagnostic + fix suggestions
- `unicli test [site]` — smoke test runner
- User adapter overlay: `~/.unicli/adapters/` overrides built-in (survives updates)

### Adapters (21 sites, 74 commands)

New sites: lobsters (4), stackoverflow (4), bluesky (9), devto (3), dictionary (3), steam (1), bbc (1), wikipedia (4), arxiv (2), apple-podcasts (3), hf (1), bloomberg (9), v2ex (7), weread (2), xiaoyuzhou (1)
Completed: hackernews (8/8), reddit (8/8)
Pre-existing: github-trending (1), ollama (1), blender (1), ffmpeg (1)

### Infrastructure

- Build manifest: auto-generated dist/manifest.json
- Version bump: 0.100.1 → 0.200.0

## [0.100.1] — Sputnik · Kedr

> _1957 — The first artificial satellite. First signal from orbit. Proof that it works._
> _Kedr (Cedar) — Gagarin's call sign. The very first patch._

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
