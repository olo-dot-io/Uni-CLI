# Progress

## 2026-05-26 — Site Smoke and Search Complexity Audit

- Used the built Uni-CLI against its own catalog: `list` reports 319 visible surfaces and 1,806 commands, including core/dynamic surfaces; `architecture audit` reports 311 adapter sites, 1,770 loaded commands, 611 local-computer-use commands, and zero missing source paths.
- Live public-command smoke passed for `hackernews top`, `arxiv search`, `coingecko top`, and `wttr current`; earlier same-session smoke also passed for `npm package` and `wikipedia summary`.
- Conformance result: 977 adapters across 221 adapter sites, 935 passed, 0 failed, 42 quarantined. Browser doctor reports default local CDP ready, but background extension bridge still `needs-action`, and 90 visible surfaces include auth-required commands.
- Complexity fix: replaced per-search full registry signature generation with an O(1) registry version check, reused postings for site/category candidate expansion, cached normalized site phrases in the index, and replaced default full candidate sorting with bounded top-k insertion.
- Result: search eval stayed unchanged at 73.49% Top-1, 83.47% Top-3, 85.76% Top-5, 71.58% Chinese Top-5, and 91.82% English Top-5. Micro-benchmark improved from 1,500 queries in 21.33s (14.2181 ms/query) to 18.89s (12.5924 ms/query).
- Experiment ladder: `unicli search/list/architecture audit/browser doctor`, `npm run conformance`, six live public command smokes, complexity scanner, targeted search/fast-path/MCP tests, micro-benchmark before/after, and full `npm run verify`.
- Residual risk: this does not prove every live third-party site works right now. Full live validation still needs a scheduled sweep that classifies auth-required, quarantined, browser-required, rate-limited, region-blocked, and upstream-changed commands separately.

## 2026-05-26 — Live Registry Search Rewrite

- Demolished the generated runtime search-index path: `scripts/build-manifest.js` no longer writes `dist/manifest-search.json`, and runtime discovery no longer reads or falls back to generated BM25 artifacts.
- Root cause removed: search had a second source of truth separate from command creation/invocation. Generated manifest search could miss runtime/user-registered commands that the live registry could invoke, so discovery and execution were not a closed loop.
- Rebuilt `src/discovery/search.ts` around `CommandSearchDocument` inputs: normal CLI/MCP search indexes the live registry plus core commands, while fast-path search projects `dist/manifest.json` into the same scorer instead of owning separate search semantics.
- Added a red regression proving a runtime-only command is discoverable after registration; updated direct search, command, and MCP tests to load the live registry boundary used by real CLI/MCP startup.
- Experiment ladder: red runtime-only search test, targeted search/fast-path/MCP/command suites, formatter/typecheck/lint, one failed then three passing full `npm run verify` runs, `npm run docs:build`, built CLI self-use for Twitter/social search, scholarly category search, and `architecture audit`, plus `test ! -e dist/manifest-search.json`.
- Result: `npm run verify` and `npm run docs:build` pass. Search eval reports 73.49% Top-1, 83.47% Top-3, 85.76% Top-5, 71.58% Chinese Top-5, and 91.82% English Top-5 against the live registry.
- Residual risk: this proves in-repo command discovery, fast-path projection, MCP search, adapter conformance, generated docs, and absence of the old artifact. It does not prove every live third-party command succeeds against current upstream network/auth/UI conditions.

## 2026-05-26 — Architecture Tree and Repairability Audit

- Added the callable `architecture tree` and `architecture audit` commands so agents can inspect Uni-CLI's first-class architecture roots, command lifecycle, local-computer-use coverage, second-class surfaces, and per-command repair source paths through the normal CLI envelope.
- Reworked adapter loading and TypeScript registration so YAML, static TS stubs, loop-generated TS commands, cross-site TS registrations, and user adapters preserve repairable `adapter_path` metadata.
- Experiment ladder: red architecture command/tree tests, red loader source-path tests, targeted loader/architecture/quarantine/parity suites, source and built CLI self-use, `npm run verify`, and `npm run docs:build`.
- Result: `architecture audit` now reports 311 sites, 1,770 loaded commands, 611 local-computer-use commands, zero missing source paths, and `ready_for_full_rewrite: true`; full verify and docs build pass.
- Residual risk: this validates the in-repo command contracts, loader/runtime parity, adapter schema/conformance, and generated docs. It does not prove every live third-party website currently succeeds against the network, logged-in state, rate limits, or upstream UI changes; that still needs a scheduled live adapter sweep.

## 2026-05-26 — Compute Cursor UI Rewrite

- Replaced the old neon arrow cursor vocabulary with `aperture-reticle-v1` across `visual_timeline`, docs replay, and macOS/Windows/Linux native overlay request/render paths.
- Experiment ladder: red cursor style test, red visual timeline state test, targeted unit suites, `npm run typecheck`, `npm run lint`, `npm run docs:build`, generated Swift parse, generated Linux Python compile, full `npm test`, and a live macOS `compute click --overlay` smoke.
- Result: all listed checks passed. The live macOS smoke returned `macos-appkit` / `arrived` and evidence with `aperture-reticle-v1`, `press`, `pressure`, and `click_ripple`.
- Residual risk: PowerShell parse was skipped because `pwsh` is not installed on this macOS host. Windows/Linux native behavior is covered here by shared request contracts, source guards, and generated Python compilation, but still needs real OS sidecar smoke on those platforms.

## 2026-05-26 — Mac Pointer Skin Rewrite

- Replaced the reticle cursor direction with `mac-glass-pointer-v1`: a Mac-style arrow skin with a real top-left hotspot, lift shadow, travel trace, arrival-gated press bloom, busy orbit, and success/error states.
- Experiment ladder: red cursor-style expectations, targeted cursor/overlay/timeline suites, generated Swift parse, generated Linux Python compile, local docs screenshot inspection, live macOS `compute click --overlay` smoke, `npm run typecheck`, `npm run lint`, `npm run docs:build`, `git diff --check`, and full `npm test`.
- Result: all listed checks passed. The live macOS smoke returned `macos-appkit` / `arrived` and evidence with `mac-glass-pointer-v1`, `mac-pointer`, `lift-shadow`, `pressure-bloom`, and `success-spark`.
- Residual risk: PowerShell parse remains skipped because `pwsh` is not installed on this macOS host; Windows/Linux real native sidecar smoke still requires those OSes.
