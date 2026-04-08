# Uni-CLI vs the Field

> Honest, source-level comparison against the projects most commonly mentioned in the same conversation. Numbers are from a 2026-04-07 audit of cloned reference repositories under `ref/`.

## TL;DR

Uni-CLI is the CLI agents call. It is _not_ a runtime that hosts the model, _not_ a browser library agents embed, and _not_ an MCP-only server. The closest comparable shape is opencli (TypeScript) and CLI-Anything (Python, same lab) — both are "many adapters behind one binary." Uni-CLI is positioned as the most general of the three: 134 sites, 711 commands, raw CDP browser, and a Karpathy-style self-repair loop.

## vs opencli

> opencli is the genome. Uni-CLI is the descendant.

| Dimension                 | opencli                | Uni-CLI v0.208                  |
| ------------------------- | ---------------------- | ------------------------------- |
| Pipeline steps            | 15                     | 35                              |
| Self-repair loop          | implicit (per adapter) | explicit 8-phase Karpathy loop  |
| Eval harness              | none                   | bundled (15 starter cases)      |
| Adapter generation engine | manual                 | `unicli init` + `unicli record` |
| Browser layer             | shared opencli engine  | raw CDP, no extension required  |
| Sites                     | ~115                   | 134                             |
| Commands                  | ~460                   | 711                             |

Uni-CLI takes opencli's adapter format and extends it with control flow (`each`, `if`, `parallel`, `retry`), browser primitives (snapshot, observe, intercept), and a self-repair loop the agent can drive end-to-end.

## vs CLI-Anything (HKUDS, same lab)

> They win on desktop apps and SKILL.md auto-gen. Uni-CLI v0.208 closes the SKILL.md gap.

| Dimension                | CLI-Anything                   | Uni-CLI v0.208                             |
| ------------------------ | ------------------------------ | ------------------------------------------ |
| Desktop-app harnesses    | 44                             | ~30 (covers Godot, RenderDoc as of v0.208) |
| SKILL.md auto-generation | yes (`skill_generator.py`)     | yes (`unicli skills export`)               |
| MCP gateway              | partial                        | yes (expanded + lazy modes, stdio + HTTP)  |
| Pipeline steps           | per-harness Python             | 35 declarative steps + TS extension hook   |
| Browser layer            | uses Chrome via Python wrapper | raw CDP, no Python runtime needed          |
| Web breadth              | small                          | 134 sites                                  |

If you live in desktop apps and have an existing Python toolchain, CLI-Anything is the cleaner home. If you live in the web and want a Node-only single-binary install, Uni-CLI is the cleaner home.

## vs browser-use

> Different shape. Don't compare apples to oranges.

| Dimension           | browser-use                      | Uni-CLI v0.208                        |
| ------------------- | -------------------------------- | ------------------------------------- |
| Distribution model  | Python library agents `import`   | CLI binary agents `exec`              |
| Step semantics      | LLM-driven (one model call/step) | Deterministic pipeline + optional LLM |
| Token cost per call | Per-step LLM tokens              | ~80 tokens per CLI invocation         |
| Stars               | 86K                              | (not yet listed)                      |
| Best when           | Open-ended browser tasks         | Repeatable, debuggable extraction     |

A browser-use call does an LLM round-trip per step, which is why it costs more and is better at unscripted exploration. A Uni-CLI call is a YAML pipeline running locally — orders of magnitude cheaper, better at structured fetches.

## vs goose (MCP-first)

> Goose can mount Uni-CLI as an MCP server and inherit 711 commands at zero integration cost.

| Dimension     | goose                | Uni-CLI v0.208               |
| ------------- | -------------------- | ---------------------------- |
| MCP-first     | yes                  | yes (`unicli mcp serve`)     |
| Adapter shape | MCP servers          | YAML pipelines + MCP gateway |
| Coverage      | depends on MCP fleet | 711 commands native          |

Run `unicli mcp serve` and goose sees every Uni-CLI adapter as an MCP tool.

## vs hermes-agent (NousResearch)

> Different category — hermes is the agent, Uni-CLI is the tool layer.

Hermes can call `unicli` from its bash tool today. Uni-CLI v0.208 also reads hermes's on-disk skills (`~/.hermes/skills/`) and FTS5 session DB via the new `hermes` adapter (deliverable F#1).

## vs Stagehand (browser-only)

> Stagehand sets the standard for the `observe → act → extract` browser verb separation. Uni-CLI v0.208 ships `unicli operate observe` to match.

| Dimension              | Stagehand             | Uni-CLI v0.208                                           |
| ---------------------- | --------------------- | -------------------------------------------------------- |
| `observe()` verb       | yes (vision-grounded) | yes (`unicli operate observe`, ranker w/ optional LLM)   |
| `act()` verb           | yes                   | `operate click / type / press / scroll`                  |
| `extract()` verb       | yes                   | `extract` pipeline step + `operate text/value/html`      |
| Self-healing selectors | yes                   | yes (refs persist across snapshots, observe-cache.jsonl) |

Stagehand is browser-only. Uni-CLI's browser layer is one of five adapter types — for a tool already covering web APIs, desktop apps, and bridges, the browser surface needed parity, not replacement.

## vs OpenHarness (HKUDS, same lab)

> OpenHarness is a 10-subsystem framework that overlaps with Uni-CLI's CLAUDE.md harness. Uni-CLI v0.208 reads OpenHarness on-disk state for interop and ports its sensitive-path deny list pattern.

OpenHarness's `permissions/checker.py:18-37` ships hardcoded sensitive path patterns (`.ssh`, `.aws`, `.gnupg`, `.kube`, `credentials.json`). Uni-CLI v0.208 ports the same pattern set to `src/permissions/sensitive-paths.ts` and blocks `unicli operate upload` and the `exec` pipeline step from touching anything that matches.

## Where Uni-CLI is honestly behind

- **Adapter count vs CLI-Anything's desktop-app coverage** — they have 44 desktop harnesses; we have ~30. Closing this gap is a v0.209 priority.
- **Stateful REPL per app** — CLI-Anything ships a REPL mode for interactive sessions; Uni-CLI calls are stateless. v0.209.
- **Cloud backends** — Modal/Daytona dispatch; deferred to v0.209+.
- **Watchdog event registry** — browser-use's bubus pattern (popups, security, downloads) is not yet ported.

## Where Uni-CLI is honestly ahead

- **Pipeline expressiveness** — 35 steps vs opencli's 15. Control flow (`each`, `if`, `parallel`), retry decorators, and template evaluation are all built in.
- **Self-repair maturity** — explicit 8-phase Karpathy loop with failure classification, eval-driven improvement, and Claude API integration (`src/engine/repair/`).
- **Single-binary distribution** — one Node binary, zero Python deps, raw CDP without an extension.
- **Eval catalog** — 15 starter evals + a `unicli eval ci` mode that runs only adapters touched in the recent git window.
