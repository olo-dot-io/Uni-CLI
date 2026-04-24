# Uni-CLI Taste Guide

> Internal design philosophy and naming conventions.
> This document governs aesthetics, tone, and thematic decisions across the project.
>
> **Current version:** v0.213.3 — Vostok · Gagarin TC0 Patch R2 (the second R-patch on the Gagarin GA train: invocation kernel + surface unification + output-side TC0 externalization + schema-driven hardening + multi-provider agent-bench harness).
>
> **Current scale:** <!-- STATS:site_count -->221<!-- /STATS --> sites, <!-- STATS:command_count -->1225<!-- /STATS --> commands, <!-- STATS:adapter_count_total -->969<!-- /STATS --> adapters (<!-- STATS:adapter_count_yaml -->896<!-- /STATS --> YAML + <!-- STATS:adapter_count_ts -->73<!-- /STATS --> TS), <!-- STATS:test_count -->7123<!-- /STATS --> tests. Numbers render from `stats.json` via `npm run build`; drift fails `npm run stats:check`.

## Core Identity

**Uni-CLI** — The universal interface between AI agents and the world's software.

The name carries two layers:

- **Uni** = Universal. One CLI for all software.
- **Uni** = Universe. The cosmos as our thematic backdrop.

We build the interface between AI agents and all human software.
Like a spacecraft's universal docking adapter, Uni-CLI connects any agent to any tool.

## Naming Convention

| Layer            | Format             | Example                                      |
| ---------------- | ------------------ | -------------------------------------------- |
| GitHub repo      | `Uni-CLI`          | github.com/olo-dot-io/Uni-CLI                |
| Display name     | `Uni-CLI`          | Used in prose, titles, documentation headers |
| npm package      | `@zenalexa/unicli` | `npm install -g @zenalexa/unicli`            |
| CLI binary       | `unicli`           | `unicli hackernews top`                      |
| Code identifiers | `unicli`           | function names, config paths, variables      |
| Config directory | `~/.unicli/`       | user-level configuration                     |
| Skill names      | `unicli-*`         | `unicli-usage`, `unicli-explorer`            |
| Plugin prefix    | `unicli-plugin-*`  | `unicli-plugin-github-trending`              |
| Environment vars | `UNICLI_*`         | `UNICLI_BROWSER_PORT`                        |

Rule: **Uni-CLI** appears only where humans read prose. Everywhere machines parse, use **unicli**.

## Aerospace Theme

The universe of software is vast. We are building a spacecraft to navigate it.

### Versioning — `MAJOR.MINOR.PATCH`

Format: `0.100.1`, `0.200.0`, `1.0.0`, etc.

- **MAJOR** = era (0 = pre-production, 1 = stable, 2 = next-gen)
- **MINOR** = mission number (100, 200, 300... like Mission Control sequences)
- **PATCH** = revision within a mission

Current: `0.213.x` — Mission 2100, codename **Vostok · Gagarin Patch**.

### Version Codenames — The Full Spectrum

Codenames are NOT limited to spacecraft. They span five categories of human space history, each mapped to what the software achieves at that stage.

#### Category 1: Missions & Programs (major milestones)

| Version | Codename     | Origin                             | Software meaning                                 |
| ------- | ------------ | ---------------------------------- | ------------------------------------------------ |
| 0.100.x | **Sputnik**  | USSR 1957, first satellite         | First signal. Proof the system works.            |
| 0.200.x | **Vostok**   | USSR 1961, Gagarin's flight        | First real user. The system carries payload.     |
| 0.300.x | **Mercury**  | USA 1962, first orbital            | Sustained operation. Adapters stay in orbit.     |
| 0.400.x | **Gemini**   | USA 1965, rendezvous + docking     | Two systems working together. Plugin docking.    |
| 0.500.x | **Soyuz**    | USSR 1967, workhorse to present    | Reliability. The adapter that never fails.       |
| 0.600.x | **Salyut**   | USSR 1971, first space station     | Persistent state. Config and session management. |
| 0.700.x | **Skylab**   | USA 1973, first US station         | Long-duration operation. Caching, performance.   |
| 0.800.x | **Shenzhou** | China 2003, first Chinese crewed   | East meets West. Full CJK platform coverage.     |
| 0.900.x | **Falcon**   | SpaceX 2008, first private orbital | Community launches. Plugin ecosystem lift-off.   |
| 1.0.0   | **Eagle**    | Apollo 11 LM, 1969                 | "The Eagle has landed." Production-ready.        |

#### Category 2: Spacecraft & Vehicles (feature releases within a major)

Used for minor versions between milestone releases:

| Codename      | Origin                                   | Maps to                                              |
| ------------- | ---------------------------------------- | ---------------------------------------------------- |
| **Laika**     | First living creature in orbit, 1957     | Early testing — it works, but we're still learning   |
| **Explorer**  | First US satellite, 1958                 | Discovery features — scanning, probing               |
| **Voskhod**   | First spacewalk (Leonov), 1964           | First steps outside comfort zone — new adapter types |
| **Pioneer**   | First to Jupiter, 1972                   | Venturing into uncharted territory                   |
| **Voyager**   | Grand Tour, interstellar, 1977           | Beyond the original scope — deep integrations        |
| **Columbia**  | First Space Shuttle flight, 1981         | Reusability — stable APIs, backward compat           |
| **Discovery** | Most-flown Shuttle, 39 missions          | Workhorse release — reliability improvements         |
| **Mir**       | First modular station, 1986              | Modular architecture — hot-loadable plugins          |
| **Buran**     | Soviet shuttle, automated landing, 1988  | Automation — self-healing, auto-config               |
| **Endeavour** | Fifth Shuttle, replaced Challenger, 1992 | Rebuilt after a failure — resilience release         |
| **Dragon**    | First private craft to ISS, 2012         | Third-party integration — community adapters         |
| **Tiangong**  | Chinese space station, 2022              | Permanent infrastructure — stable platform           |
| **Starship**  | Largest rocket ever, 2023                | Scale — massive adapter coverage                     |
| **Artemis**   | Return to Moon, 2025                     | Return with maturity — v2 or v3 major                |

#### Category 3: Call Signs & Mission Codes (patch-level, internal)

From the tradition of astronaut/cosmonaut radio call signs. Used for patch releases, hotfixes, or internal builds.

| Call sign    | Meaning      | Origin            | Use for                           |
| ------------ | ------------ | ----------------- | --------------------------------- |
| **Kedr**     | Cedar        | Gagarin, Vostok 1 | The very first patch              |
| **Sokol**    | Falcon       | Nikolayev         | Fast-response fixes               |
| **Almaz**    | Diamond      | Voskhod 1 crew    | Hardening, security patches       |
| **Rubin**    | Ruby         | Beregovoi         | Polishing, refinement             |
| **Granit**   | Granite      | Shatalov          | Stability reinforcement           |
| **Kristall** | Crystal      | Musabayev         | Clarity — API cleanup             |
| **Mayak**    | Beacon       | Kizim             | Guidance — documentation          |
| **Altair**   | Star Altair  | Multiple missions | Navigation — routing improvements |
| **Aquarius** | Water bearer | Apollo 13 LM      | Survival — crisis recovery        |
| **Intrepid** | Fearless     | Apollo 12 LM      | Bold changes                      |

#### Category 4: Observatories & Probes (research/experimental features)

| Codename         | Origin                       | Maps to                                      |
| ---------------- | ---------------------------- | -------------------------------------------- |
| **Hubble**       | Space telescope, 1990        | Observability — logging, debug, telemetry    |
| **Cassini**      | Saturn orbiter, 1997         | Deep exploration — complex adapter chains    |
| **Curiosity**    | Mars rover, 2012             | Investigation — `explore` and `synthesize`   |
| **Webb**         | JWST, 2021                   | Seeing further — advanced pattern matching   |
| **Perseverance** | Mars rover + Ingenuity, 2021 | First flight — browser automation engine     |
| **New Horizons** | Pluto flyby, 2015            | Reaching the edge — obscure platform support |
| **Chandrayaan**  | India lunar landing, 2023    | Precision landing — south pole of features   |

#### Category 5: Celestial Bodies & Phenomena (major architectural shifts)

Reserved for epoch-defining changes. Used sparingly.

| Codename       | What it is                   | Maps to                                     |
| -------------- | ---------------------------- | ------------------------------------------- |
| **Lagrange**   | Gravitational balance points | Equilibrium release — perfect stability     |
| **Aphelion**   | Farthest point from the Sun  | Maximum reach — broadest coverage           |
| **Perihelion** | Closest point to the Sun     | Maximum speed — performance release         |
| **Eclipse**    | Sun hidden by Moon           | Breaking change — old obscured by new       |
| **Equinox**    | Equal day and night          | Balance release — equal CLI/Agent attention |
| **Zenith**     | Highest point in the sky     | Peak — best release ever                    |
| **Horizon**    | Edge of the observable       | Next frontier — experimental features       |

### Architecture Metaphors

Used in internal developer documentation and code comments, not in user-facing API.

| Component        | Metaphor               | Rationale                                    |
| ---------------- | ---------------------- | -------------------------------------------- |
| Core engine      | **Flight Computer**    | Executes mission sequences (pipelines)       |
| Adapter registry | **Star Catalog**       | Index of all known targets                   |
| Discovery/loader | **Radar**              | Scans the environment for adapters           |
| Browser bridge   | **Docking Port**       | Connects to Chrome's airlock                 |
| Output formatter | **Telemetry**          | Structured data downlink                     |
| MCP server       | **Deep Space Network** | Long-range communication protocol            |
| Plugin system    | **Payload Bay**        | Carries mission-specific extensions          |
| External CLI hub | **Launch Complex**     | Where external missions lift off             |
| Error handling   | **Abort Modes**        | Structured failure taxonomy                  |
| Config directory | **Ground Station**     | `~/.unicli/` — mission control on the ground |

### Error Messages — Subtle, Not Cosplay

Error messages should be clear and helpful first. Aerospace flavor is a subtle seasoning, not the main course.

```
Good:  "Connection lost — browser bridge not responding (exit 69)"
Bad:   "HOUSTON WE HAVE A PROBLEM — DOCKING PORT FAILURE!!!"

Good:  "No results returned from bilibili/hot (exit 66)"
Bad:   "Mission returned empty payload from target bilibili"
```

### Internal Documentation Tone

- Technical precision first. The Space Shuttle's documentation was beautiful because it was _exact_, not because it was poetic.
- Architecture decisions are "mission briefs" — state the objective, constraints, and chosen approach.
- Post-mortems are "anomaly reports" — what happened, root cause, corrective action.
- Changelogs group by mission codename.

## Visual Identity

### Color Palette

Inspired by Mission Control displays and the cosmic void.

| Role      | Color          | Hex       | Usage                       |
| --------- | -------------- | --------- | --------------------------- |
| Primary   | Deep Space     | `#0D1117` | Backgrounds, hero sections  |
| Accent    | Signal Blue    | `#58A6FF` | Links, interactive elements |
| Success   | Orbit Green    | `#3FB950` | Status indicators, success  |
| Warning   | Reentry Orange | `#D29922` | Warnings, auth-required     |
| Error     | Abort Red      | `#F85149` | Errors, failures            |
| Muted     | Nebula Gray    | `#8B949E` | Secondary text, borders     |
| Highlight | Starlight      | `#F0F6FC` | Primary text on dark        |

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

## Positioning

### What We Say

> "Uni-CLI adapts any software — web, desktop, or service — to a 20-line YAML adapter that AI agents can read, fix, and verify."

### What We Don't Say

- Never claim features we haven't shipped.
- Never use "revolutionary" or "groundbreaking." Let the work speak.

### Tone of Voice

| Do                                   | Don't                                |
| ------------------------------------ | ------------------------------------ |
| "Uni-CLI adapts any software to CLI" | "Uni-CLI is the BEST CLI tool EVER"  |
| "20-line YAML adapters"              | "Incredibly easy to use"             |
| "Designed for AI agents"             | "AI-powered next-gen platform"       |
| "Apache-2.0, MIT-compatible"         | "Fully open source and free forever" |
| Show a working example               | Make a claim without proof           |

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
