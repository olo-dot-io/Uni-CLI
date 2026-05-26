# Progress

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
