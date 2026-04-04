# Uni-CLI Taste Guide

> Internal design philosophy and naming conventions.
> This document governs aesthetics, tone, and thematic decisions across the project.

## Core Identity

**Uni-CLI** — Universal CLI. CLI IS ALL YOU NEED.

The name carries two layers:
- **Uni** = Universal. One CLI for all software.
- **Uni** = Universe. The cosmos as our thematic backdrop.

We build the interface between AI agents and all human software.
Like a spacecraft's universal docking adapter, Uni-CLI connects any agent to any tool.

## Naming Convention

| Layer | Format | Example |
|-------|--------|---------|
| GitHub repo | `Uni-CLI` | github.com/ZenAlexa/Uni-CLI |
| Display name | `Uni-CLI` | Used in prose, titles, documentation headers |
| npm package | `unicli` | `npm install -g unicli` |
| CLI binary | `unicli` | `unicli hackernews top` |
| Code identifiers | `unicli` | function names, config paths, variables |
| Config directory | `~/.unicli/` | user-level configuration |
| Skill names | `unicli-*` | `unicli-usage`, `unicli-explorer` |
| Plugin prefix | `unicli-plugin-*` | `unicli-plugin-github-trending` |
| Environment vars | `UNICLI_*` | `UNICLI_BROWSER_PORT` |

Rule: **Uni-CLI** appears only where humans read prose. Everywhere machines parse, use **unicli**.

## Aerospace Theme

The universe of software is vast. We are building a spacecraft to navigate it.

### Version Codenames — Human Spaceflight Milestones

Each release is named after a milestone in human space exploration, in chronological order.
This is not decoration — it's a timeline of ambition.

| Version | Codename | Year | Significance |
|---------|----------|------|-------------|
| v0.1.x | **Sputnik** | 1957 | First satellite. First signal. First proof it works. |
| v0.2.x | **Vostok** | 1961 | First human in space. The system carries a passenger. |
| v0.3.x | **Mercury** | 1962 | First orbital flight. Sustained operation. |
| v0.4.x | **Gemini** | 1965 | Docking. Multi-mission. Two things working together. |
| v0.5.x | **Shenzhou** | 2003 | China's first crewed flight. East meets West. |
| v1.0.0 | **Apollo** | 1969 | The moon. "One small step." Production-ready. |
| v1.x | **Voyager** | 1977 | Leaving the solar system. Expanding beyond known territory. |
| v2.0 | **Tiangong** | 2022 | Space station. Permanent infrastructure. |
| v3.0 | **Artemis** | 2025 | Return to the moon with new technology. Maturity. |

### Architecture Metaphors

Used in internal developer documentation and code comments, not in user-facing API.

| Component | Metaphor | Rationale |
|-----------|----------|-----------|
| Core engine | **Flight Computer** | Executes mission sequences (pipelines) |
| Adapter registry | **Star Catalog** | Index of all known targets |
| Discovery/loader | **Radar** | Scans the environment for adapters |
| Browser bridge | **Docking Port** | Connects to Chrome's airlock |
| Output formatter | **Telemetry** | Structured data downlink |
| MCP server | **Deep Space Network** | Long-range communication protocol |
| Plugin system | **Payload Bay** | Carries mission-specific extensions |
| External CLI hub | **Launch Complex** | Where external missions lift off |
| Error handling | **Abort Modes** | Structured failure taxonomy |
| Config directory | **Ground Station** | `~/.unicli/` — mission control on the ground |

### Error Messages — Subtle, Not Cosplay

Error messages should be clear and helpful first. Aerospace flavor is a subtle seasoning, not the main course.

```
Good:  "Connection lost — browser bridge not responding (exit 69)"
Bad:   "HOUSTON WE HAVE A PROBLEM — DOCKING PORT FAILURE!!!"

Good:  "No results returned from bilibili/hot (exit 66)"
Bad:   "Mission returned empty payload from target bilibili"
```

### Internal Documentation Tone

- Technical precision first. The Space Shuttle's documentation was beautiful because it was *exact*, not because it was poetic.
- Architecture decisions are "mission briefs" — state the objective, constraints, and chosen approach.
- Post-mortems are "anomaly reports" — what happened, root cause, corrective action.
- Changelogs group by mission codename.

## Visual Identity

### Color Palette

Inspired by Mission Control displays and the cosmic void.

| Role | Color | Hex | Usage |
|------|-------|-----|-------|
| Primary | Deep Space | `#0D1117` | Backgrounds, hero sections |
| Accent | Signal Blue | `#58A6FF` | Links, interactive elements |
| Success | Orbit Green | `#3FB950` | Status indicators, success |
| Warning | Reentry Orange | `#D29922` | Warnings, auth-required |
| Error | Abort Red | `#F85149` | Errors, failures |
| Muted | Nebula Gray | `#8B949E` | Secondary text, borders |
| Highlight | Starlight | `#F0F6FC` | Primary text on dark |

### Typography

- Monospace-first aesthetic. Code IS the product.
- README uses minimal emoji — only in section headers, never in prose.
- Tables and code blocks over bullet lists where possible.
- Diagrams use box-drawing characters (ASCII art), not Mermaid — they render everywhere.

### Logo Direction

- Geometric. A universal docking adapter — a hexagonal connector.
- Or: a stylized "U" that forms an orbital path around a dot (planet).
- Colors: white on deep space, or signal blue on dark.
- No gradients. No shadows. Clean vector geometry.

## Competitive Positioning

### What We Say

> "OpenCLI does websites. CLI-Anything does desktop apps. Uni-CLI does everything — in 20 lines of YAML."

### What We Don't Say

- Never disparage competitors. They pioneered this space.
- Never claim features we haven't shipped.
- Never use "revolutionary" or "groundbreaking." Let the work speak.

### Tone of Voice

| Do | Don't |
|----|-------|
| "Uni-CLI adapts any software to CLI" | "Uni-CLI is the BEST CLI tool EVER" |
| "20-line YAML adapters" | "Incredibly easy to use" |
| "Designed for AI agents" | "AI-powered next-gen platform" |
| "Apache-2.0, MIT-compatible" | "Fully open source and free forever" |
| Show a working example | Make a claim without proof |

### README Structure (10K Star Formula)

1. **Hero** — One-line pitch + badges + 3 action buttons
2. **Why** — Problem statement + architecture diagram + comparison table
3. **Quick Start** — 3 commands to working output
4. **Features** — 5 adapter types with copy-pastable examples
5. **Agent Integration** — MCP + Skills + AGENTS.md
6. **Built-in Adapters** — Growing table of adapters
7. **Architecture** — Clean system diagram
8. **Contributing** — "Add a 20-line YAML" hook
9. **License** — Apache-2.0

Each section earns the next scroll. If a section doesn't pull the reader forward, cut it.

## Quality Bar

Before any release:
- Every adapter must have at least one test
- README examples must be copy-pastable and working
- TypeScript strict mode, zero `any`
- All exit codes documented and tested
- CHANGELOG entry for every user-visible change
- No broken links in documentation
