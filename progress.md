# Progress

## 2026-05-31 — Step 2/5 Unified Operation Contracts

- Root cause: adapter commands used `CommandContract`, but core Commander
  commands (`compute`, `browser`, `delivery`, `runs`, `mcp`, `agents`, and
  `architecture`) still exposed schemas and architecture inventory through a
  parallel `CoreDiscoveryCommand` path. That kept the universal computer-control
  model split at the operation boundary.
- Added `buildCoreCommandContract()` in `src/core/command-contract.ts`. Core
  contracts now carry identity, input schema, target surface, effect,
  governance, explicit unknown eval status, and `repair.source_kind: "core"`
  with `source_path`. They intentionally do not invent adapter-only
  `adapter_path` or `repair_command` fields.
- Updated architecture inventory to derive core command target surface and
  safety class from the contract builder instead of hardcoding
  `safety_class: "control"`.
- Updated slow runtime `describe` and fast-path `describe` so
  `describe compute capture` exposes the same core contract as adapter command
  descriptions.
- Experiment ladder: added failing contract/describe/fast-path/architecture
  tests, observed missing `buildCoreCommandContract`, missing runtime core
  describe payload, missing fast-path contract, and hardcoded core safety class;
  implemented the core projection and reran the same suite to green.
- Verification: focused contract/architecture/fast-path suite passed with 36
  tests; adjacent contract/architecture/MCP fast-path suite passed with 55
  tests; `npm run typecheck`, `npm run lint`, `describe compute capture`, and
  `architecture audit` exited 0. The CLI describe probe confirmed core tags are
  de-duplicated as `["core", "desktop"]`.
- Residual risk: full `npm test` was attempted but stopped after more than ten
  minutes without a Vitest summary, so full-suite completion remains
  unverified. Full `npm run verify` still needs to run after this step;
  independent subagent audit was not spawned because the available tool
  requires an explicit delegation request.

## 2026-05-31 — Universal Computer-Control Reframe

- Root cause: the previous "agent control plane" wording still allowed the
  product to be read as a better tool catalog, execution layer, MCP wrapper, or
  adapter collection. The user clarified the intended category is larger:
  Uni-CLI is the universal hand by which agents control computers; browser
  automation, computer-use sandboxes, natural-language local execution, MCP, and
  per-site wrappers are substrates below it.
- Replaced the top-level public model across README, package metadata, docs
  sources, VitePress homepage/config, FAQ, glossary, getting-started,
  integrations, roadmap, and architecture docs with the computer-control loop:
  intent -> select -> govern -> act -> observe -> diagnose -> repair/reroute ->
  deliver -> expose.
- Rebuilt `src/core/architecture-tree.ts` around
  `COMPUTER_CONTROL_STAGES`, `computer-control-platform`,
  `operation-contract`, `control-kernel`, `action-substrates`,
  `evidence-delivery-loop`, and `runtime-exposure`. The old command lifecycle
  stays as an internal authoring cycle, not the product root.
- Updated `src/discovery/core-catalog.ts`, `src/commands/architecture.ts`, and
  focused tests so `architecture tree/audit` enforce the new topology and
  non-product identity boundaries.
- Experiment ladder so far: wrote failing architecture tests against the new
  topology, observed red failures for missing `COMPUTER_CONTROL_STAGES` and old
  `first-class-citizens`, implemented the root replacement, then reran
  `npx vitest run tests/unit/core/architecture-tree.test.ts tests/unit/commands/architecture.test.ts`
  to green with 8 tests.
- Verification: focused architecture tests passed with 8 tests; `npm run
typecheck`, `npm run lint`, `npm run docs:build`, `npm run docs:check-public`,
  `npm test`, `npm run boundary:check`, and `architecture audit` all exited 0.
  Full `npm test` passed with 232 test files, 2656 tests, and 2 skipped after a
  release metadata regression in FAQ version pins was fixed in
  `scripts/release.ts`.

## 2026-05-31 — Agent Control Plane Repositioning

- Root cause: the architecture model treated adapter manifest commands as the
  callable architecture, but the product's control plane also includes core
  Commander commands such as `compute`, `browser`, `delivery`, `runs`, `mcp`,
  `agents`, and `architecture`.
- Reframed README/package/docs architecture thesis around Uni-CLI as the agent
  control plane for real software: intent discovery, governed execution, state
  observation, result delivery, diagnosis/repair, and reuse.
- Added core command source paths in `src/discovery/core-catalog.ts`, merged core
  commands into `src/core/architecture-tree.ts`, and wired
  `src/commands/architecture.ts` so `architecture tree/audit` covers adapter and
  core command inventories.
- Result: `architecture audit` now reports 321 sites, 1819 total commands, 1783
  adapter commands, 36 core commands, 627 local-computer-use commands, and 0
  missing source paths. `unicli list -f json` also reports 1819 commands.
- Experiment ladder: read README/docs/runtime structure, ran architecture/list
  probes, added focused regression tests, then ran
  `npx vitest run tests/unit/core/architecture-tree.test.ts tests/unit/commands/architecture.test.ts`,
  `npm run typecheck`, `npm run lint`, and `npx tsx src/main.ts architecture audit -f json`.
- Full `npm test` was attempted after focused verification, but the Vitest
  process idled for about seven minutes without a final summary and was killed.
- Residual risk: this aligns the callable architecture inventory and public
  architecture thesis. It does not yet project core Commander commands through
  the full `CommandContract` path, prove individual live desktop/web workflows,
  or provide a completed full unit-suite result for this dirty worktree.

## 2026-05-27 — Marxists.org Chinese Archive Adapter

- Root cause: `unicli search` had no structured route for `https://www.marxists.org/chinese/index.html`, so agents asking for Marxist philosophy, people, books, or primary-source content were pushed toward generic web/scholarly search instead of the Chinese Marxists archive.
- Added the public `marxists-cn` TypeScript adapter with `index`, `authors`, `works`, `search`, `read`, `reading-list`, and `western-marxism` commands. The adapter constrains all URLs to `https://www.marxists.org/chinese/`, sniffs UTF-8 vs GB18030/GBK/GB2312 pages, extracts top-level people/topic directories, parses author/topic work lists, reads HTML pages as plain text, returns a station-verified Western Marxism reading list, and supports bounded scoped full-text search.
- Added discovery aliases and a narrow intent boost so Marxism/philosophy/archive retrieval queries route to `marxists-cn search` before generic paper search, while Western Marxism canon/reading-list queries route to `marxists-cn western-marxism`.
- Result: `list --site marxists-cn` reports seven commands; `search "马克思主义 哲学 文库 检索"` ranks `marxists-cn search` first; `search "读 西马 著名人物 著名著作"` ranks `marxists-cn western-marxism` first and `marxists-cn reading-list` second; `marxists-cn search "共产党宣言"` returns the Marx and Engels archive entries; `marxists-cn read marx/01.htm` returns title, author, date, full character count, and clean text for 《共产党宣言》.
- Experiment ladder: live `unicli search` showed no existing Marxists coverage; fetched and decoded the live GB2312/UTF-8 archive pages; added parser/unit tests, search routing regression, live CLI index/works/search/read probes, regenerated manifest/stats/docs, then ran targeted typecheck/lint/unit/adapter checks, `npm run docs:check-public`, `git diff --check`, and full `npm run verify`. A later Western Marxism probe first failed to route `search "读 西马 著名人物 著名著作"` to `marxists-cn`; the repair added station-verified reading-list commands, regenerated fast-path manifests, and re-ran the same search/read probes until they returned `western-marxism`, `reading-list`, and readable 卢卡奇 text.
- Residual risk: full-text search is intentionally scoped by `--scope` to prevent unbounded crawling of the whole archive in one command. PDF/CHM/MP3 resources are listed as works/resources, but `read` only extracts HTML/text; binary document parsing remains a separate reader/download workflow.

## 2026-05-27 — Twitter/X Coverage Repair

- Root cause: Twitter/X runtime had a user timeline command under `tweets`, but no natural `user-tweets` command, no direct `comments` command, URL inputs to `thread` were passed through as raw tweet IDs, and the generated manifest could drift from runtime TS registrations when commands were hidden behind helper registration.
- Rebuilt the Twitter/X user timeline surface so `tweets`, `user-tweets`, and `user-timeline` are explicit manifest-visible commands; they normalize `@handles`, use browser readability checks, emit the standard tweet row shape, and throw structured empty-result errors instead of silently returning `[]`.
- Added a targeted discovery intent so `unicli search "X user timeline"` ranks `twitter user-timeline` above the home timeline command while plain `twitter timeline` remains unchanged.
- Added `twitter comments` as a cookie-auth command over the existing TweetDetail thread reader, and made both `thread` and `comments` accept numeric tweet IDs or Twitter/X status URLs.
- Fixed Twitter social capability coverage by marking `post` as `write_post`, and added manifest scanner regression tests so these TS commands cannot disappear from fast-path `list/search`.
- Result: fast-path `list --site twitter` now reports 47 Twitter commands; `search "twitter comments replies"` returns `twitter comments`; `search "X user timeline"` returns `twitter user-timeline`; `twitter comments <url> --dry-run` reports `strategy: cookie` and `domain:x.com`.
- Experiment ladder: red adapter tests for `user-tweets`, `user-timeline`, `comments`, URL/id parsing, `/i/status` extraction, and social audit; red search test for X user timeline intent; regenerated manifest/stats/docs; `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:adapter`, `npm run format:check`, `npm run stats:check`, `npm run lint:schema-v2`, `npm run docs:check-public`, `git diff --check`, plus fast-path CLI discovery/dry-run probes.
- Residual risk: this proves command registration, generated discovery, dry-run metadata, parser behavior, and DOM-extraction contracts. It does not prove live X/Twitter currently returns rows for every authenticated account, because that depends on local browser login, X anti-bot state, and live DOM/API drift.

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

## 2026-05-31 — 0.225.0 Computer-Control Release Candidate

- Root cause: after the five-step architecture reshape, the repo still needed a
  final release audit, stale release-doc cleanup, generated documentation sync,
  and a semver-minor `0.xxx.0` candidate that reflected the larger
  universal-computer-control product category.
- Prepared `0.225.0 — Apollo · Irwin`: updated package/lock metadata, README
  footers, AGENTS.md, skills, server.json, CHANGELOG, docs/release-info.json,
  roadmap/FAQ version pins, generated public docs, and release reference docs.
- Historical audit baseline: checked npm latest (`0.224.1`), latest local tag
  (`v0.224.1`), and release history from `0.200.0` through `0.224.1`. Folded the
  audit into tracked release reference docs rather than new ignored
  `docs/reference/release-audit.md` files, because local `.git/info/exclude`
  hides new paths below `reference/`.
- Final review fix: `npm run verify` first failed on Prettier formatting. Ran
  Prettier on the reported files, then reran the full gate to success.
- Experiment ladder: npm registry/tag audit, stale-doc grep, release metadata
  propagation, docs build, full `npm run verify`, strict release check,
  architecture audit probe, `git diff --check`, and `npm publish --dry-run`.
- Result: `npm run verify` passed; unit tests passed 233 files / 2664 tests / 2
  skipped; adapter tests passed 168 files / 6426 tests; `docs:build` passed with
  150 public files; `release:check -- --strict-codename` passed 23/23;
  `npm publish --dry-run` produced `zenalexa-unicli-0.225.0.tgz` with shasum
  `1ff26e95393ba7da147f9df77e6ff99b3cfc3a31`.
- Residual risk: this is a verified local release candidate, not a real npm
  publish. Tagging and publishing still require a maintainer commit on `main`,
  `git tag v0.225.0`, and the GitHub `release.yml` workflow.
