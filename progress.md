# Progress

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
