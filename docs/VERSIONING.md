# Versioning & Codename System

> Uni-CLI uses a space-program-inspired versioning scheme. Every release has a numeric version and an aerospace codename that encodes the project's stage and ambition.

## Version Format

```
<MAJOR>.<MINOR>.<PATCH>
```

| Segment   | Meaning                                            | Example                                   |
| --------- | -------------------------------------------------- | ----------------------------------------- |
| **MAJOR** | Era (0 = pre-production, 1 = stable, 2 = next-gen) | `0.xxx.x`                                 |
| **MINOR** | Mission number (100, 200, 300...)                  | `0.200.x` = Mission 200                   |
| **PATCH** | Revision within a mission                          | `0.201.0` = first revision of Mission 200 |

Mission numbers increment by 100 for major capability shifts. Within a mission, the ones digit increments: 200, 201, 202... up to 299.

## Codename Hierarchy

Each release gets a **mission codename** (from Category 1) and optionally a **call sign** (from Category 3) for sub-releases.

Format: `<Mission> · <Call Sign>`

Example: `0.200.0 Vostok · Chaika` → Mission 200 ("Vostok"), call sign "Chaika" (Seagull — Valentina Tereshkova's call sign).

### Naming Rules

1. Mission codenames are assigned once per `0.x00` series and stay for the entire range
2. Call signs differentiate sub-releases within a mission (201, 202...)
3. Call signs can come from any Category 3 name or historical astronaut/cosmonaut call signs
4. Codenames are lowercase in CLI output, title case in docs: `vostok` vs `Vostok`

## Release History

| Version | Codename           | Date       | Sites | Commands | Milestone                             |
| ------- | ------------------ | ---------- | ----- | -------- | ------------------------------------- |
| 0.100.0 | Sputnik            | 2026-04-04 | 6     | 8        | First signal — proof the system works |
| 0.100.1 | Sputnik · Kedr     | 2026-04-04 | 6     | 8        | Version system overhaul               |
| 0.200.0 | Vostok · Chaika    | 2026-04-04 | 21    | 74       | Self-repair engine, 74 YAML adapters  |
| 0.201.0 | Vostok · Chaika II | 2026-04-04 | 43    | 141      | Engine v2, desktop/bridge adapters    |

## Planned Releases

| Version | Codename            | Target     | Scope                                       |
| ------- | ------------------- | ---------- | ------------------------------------------- |
| 0.202.0 | Vostok · Tereshkova | TBD        | Chrome Extension + cookie infrastructure    |
| 0.203.0 | Vostok · Leonov     | TBD        | Cookie adapters batch 1 (Chinese platforms) |
| 0.204.0 | Vostok · Nikolayev  | 2026-04-05 | Cookie adapters batch 2 (international)     |
| 0.205.0 | Vostok · Bykovsky   | 2026-04-05 | Full parity — all sites, all desktop apps   |
| 0.300.0 | Mercury             | TBD        | Sustained operation, adapter reliability    |
| 1.0.0   | Eagle               | TBD        | "The Eagle has landed" — production-ready   |

## Mission Codename Map

| Range   | Mission      | Origin                             | Software meaning                                 |
| ------- | ------------ | ---------------------------------- | ------------------------------------------------ |
| 0.100.x | **Sputnik**  | USSR 1957, first satellite         | First signal. Proof the system works.            |
| 0.200.x | **Vostok**   | USSR 1961, Gagarin's flight        | First real user. The system carries payload.     |
| 0.300.x | **Mercury**  | USA 1962, first US orbital         | Sustained operation. Adapters stay in orbit.     |
| 0.400.x | **Gemini**   | USA 1965, rendezvous + docking     | Two systems working together. Plugin docking.    |
| 0.500.x | **Soyuz**    | USSR 1967, workhorse               | Reliability. The adapter that never fails.       |
| 0.600.x | **Salyut**   | USSR 1971, first station           | Persistent state. Config and session management. |
| 0.700.x | **Skylab**   | USA 1973, first US station         | Long-duration operation. Caching, performance.   |
| 0.800.x | **Shenzhou** | China 2003, first Chinese crewed   | East meets West. Full CJK platform coverage.     |
| 0.900.x | **Falcon**   | SpaceX 2008, first private orbital | Community launches. Plugin ecosystem lift-off.   |
| 1.0.0   | **Eagle**    | Apollo 11 LM, 1969                 | "The Eagle has landed." Production-ready.        |

## Call Sign Registry (Sub-release Names)

Call signs come from the tradition of astronaut/cosmonaut radio identifiers. They name sub-releases within a mission.

### Vostok Series (0.200.x) — Soviet Cosmonaut Call Signs

| Patch   | Call Sign      | Origin                         | Meaning                            |
| ------- | -------------- | ------------------------------ | ---------------------------------- |
| 0.200.0 | **Chaika**     | Valentina Tereshkova, Vostok 6 | Seagull — first woman in space     |
| 0.201.0 | **Chaika II**  | Continuation                   | Second flight of the seagull       |
| 0.202.0 | **Tereshkova** | Full name honor                | Chrome extension launch            |
| 0.203.0 | **Leonov**     | Alexei Leonov, first spacewalk | Stepping outside (cookie adapters) |
| 0.204.0 | **Nikolayev**  | Andrian Nikolayev, Vostok 3    | Extended duration mission          |
| 0.205.0 | **Bykovsky**   | Valery Bykovsky, Vostok 5      | Longest solo orbital flight        |

### General Call Signs (Available for Any Mission)

| Call Sign    | Meaning      | Best used for                     |
| ------------ | ------------ | --------------------------------- |
| **Kedr**     | Cedar        | The very first patch              |
| **Sokol**    | Falcon       | Fast-response fixes               |
| **Almaz**    | Diamond      | Hardening, security patches       |
| **Rubin**    | Ruby         | Polishing, refinement             |
| **Granit**   | Granite      | Stability reinforcement           |
| **Kristall** | Crystal      | Clarity — API cleanup             |
| **Mayak**    | Beacon       | Guidance — documentation          |
| **Altair**   | Star         | Navigation — routing improvements |
| **Aquarius** | Water bearer | Survival — crisis recovery        |
| **Intrepid** | Fearless     | Bold changes                      |

## Architecture Metaphors

Used in code comments and internal docs, not user-facing API.

| Component        | Metaphor               | Rationale                              |
| ---------------- | ---------------------- | -------------------------------------- |
| Core engine      | **Flight Computer**    | Executes mission sequences (pipelines) |
| Adapter registry | **Star Catalog**       | Index of all known targets             |
| Discovery/loader | **Radar**              | Scans the environment for adapters     |
| Browser bridge   | **Docking Port**       | Connects to Chrome's airlock           |
| Output formatter | **Telemetry**          | Structured data downlink               |
| MCP server       | **Deep Space Network** | Long-range communication protocol      |
| Plugin system    | **Payload Bay**        | Carries mission-specific extensions    |
| External CLI hub | **Launch Complex**     | Where external missions lift off       |

## Where Versions Appear

When releasing a new version, update ALL of these locations:

| File                        | Field              | Example                             |
| --------------------------- | ------------------ | ----------------------------------- |
| `package.json`              | `version`          | `"0.201.0"`                         |
| `src/cli.ts`                | `.version()`       | `.version("0.201.0")`               |
| `scripts/build-manifest.js` | `manifest.version` | `{ version: "0.201.0" }`            |
| `src/engine/yaml-runner.ts` | User-Agent header  | `"Uni-CLI/0.201"`                   |
| `CHANGELOG.md`              | Release heading    | `## [0.201.0] — Vostok · Chaika II` |
| `CLAUDE.md`                 | Code Standards     | `- Version: 0.201.0`                |
| `AGENTS.md`                 | Available Sites    | `## Available Sites (0.201.0)`      |
| `README.md`                 | Badge + footer     | Badge count + codename              |
| `docs/TASTE.md`             | Current line       | `Current: 0.201.x`                  |

> **Note:** YAML adapter User-Agent headers use `Uni-CLI/0.2xx` (minor only, no patch). The engine `yaml-runner.ts` is the canonical source; individual YAML adapters that override User-Agent should match.

## Updating Version Checklist

```bash
# 1. Bump version
npm version 0.202.0 --no-git-tag-version

# 2. Update all locations listed above

# 3. Rebuild manifest
npm run build

# 4. Verify
npm run verify

# 5. Commit
git commit -am "chore: bump version to 0.202.0 Vostok · Tereshkova"
```
