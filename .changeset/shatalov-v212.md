---
"@zenalexa/unicli": minor
---

v0.212.0 "Shatalov" — the execution layer for agent skills.

Destructive architecture rewrite introducing a unified `TransportAdapter` interface over 7 transports (http, cdp-browser, subprocess, desktop-ax, desktop-uia, desktop-atspi, cua), CUA integration with 4 backends (anthropic/trycua/opencua/scrapybara), ACP JSON-RPC distribution for avante.nvim and OpenCode, Changesets + OIDC npm publishing, Node×OS CI matrix, schema-v2 with `capabilities`/`minimum_capability`/`trust`/`confidentiality`/`quarantine` fields, and the retirement of the ~80-tokens claim in favor of measured p50/p95 benchmarks.

### Added
- `src/core/` (envelope, schema-v2, registry-v2), `src/transport/` (TransportAdapter + 46×7 capability matrix + bus), `src/protocol/` (acp, skill)
- `unicli acp` — Agent Client Protocol JSON-RPC stdio server
- `unicli lint` — schema + step validity + cycle detection
- `unicli migrate schema-v2` — mass migration tool for existing YAML adapters
- `unicli mcp serve` now exposes 3 transports (stdio/http/streamable)
- SKILL.md cross-vendor loader discovers skills from `skills/`, `$HOME/.unicli/skills`
- `docs/THEORY.md` v2 — softened decidability, Bimodal Agent Capability, Trilemma, Self-Repair Search-Space Contraction
- `docs/refs.bib` with 25+ verified arXiv citations + CI bibtex-resolve gate
- `docs/BENCHMARK.md` + `bench/` harness with measured p50/p95
- `docs/ADAPTER-FORMAT.md` v2 + `docs/MIGRATING-FROM-OPENCLI.md`
- `docs/AVANTE.md` integration guide
- `contributing/` per-domain guides (adapter, transport, cua, mcp, acp, release, schema, branch-protection)
- `.claude/commands/` and `skills/` committed as cross-vendor workflow surface
- Changesets workflow + `verify-changesets` CI gate
- `adapter-health` (PR-soft) + `adapter-health-strict` (push/nightly) gates
- Nightly conformance suite with artifact upload

### Changed
- Formatter rewritten: `table` dropped; added `compact` format (newline-delimited, token-efficient)
- `--json` global flag becomes deprecation alias for `-f json` with stderr warning
- stats.json is the single source of truth for counts; CI gate enforces marker consistency across README/AGENTS.md/TASTE.md/ROADMAP.md
- All GitHub Actions SHA-pinned (checkout/setup-node/upload-artifact/stale/gh-release)
- CI matrix expanded to Node 20/22 × macOS 14 × Windows × Ubuntu
- Retired "~80 tokens" claim; published honest measured-in-BENCHMARK.md decomposition

### Fixed
- Conflict resolved across Phase 0+8: unified verify chain runs format:check → typecheck → lint → lint:context → build:manifest → lint:adapters → test → build → stats:check
