# Changelog

All notable changes to Uni-CLI are documented here.
Version format: `MAJOR.MINOR.PATCH` — see [contributing/COPY.md](./contributing/COPY.md) for the codename system.

## [Unreleased] — Next major development — Vostok · Astronaut TBD

> Development line only. Do not run release automation, create a tag, publish
> npm, or create a GitHub Release until the maintainer explicitly says release.
> The release codename must replace `Astronaut TBD` before tagging.

### Added

- **Browser-backed social adapters** — Reddit listing/search commands now run
  through maintained TypeScript browser adapters instead of stale public JSON
  endpoints, and Linux.do search has a browser/API-backed implementation with
  structured rate-limit handling.
- **Command-level execution metadata** — TypeScript adapters can now declare
  per-command `strategy`, `browser`, and auth requirements, so discovery,
  health probes, dispatch, describe, auth, and skill generation all see the
  same execution contract.
- **GitHub repository search adapter** — `gh search-repos` covers repository
  research through the GitHub CLI bridge.
- **Release codename gates** — release propagation, release checks, weekly
  release automation, and publish automation now require an explicit
  `Program · Astronaut` label before a version can be tagged or published.

### Changed

- Browser-function commands now receive a real page from the shared execution
  kernel and close it best-effort after command completion.
- Browser daemon compatibility now honors `OPENCLI_DAEMON_PORT` and accepts the
  OpenCLI response shapes used by the reference daemon.
- Adapter health probing now reads command-level browser/auth metadata before
  deciding what is runnable, skipped, or auth-gated.

### Fixed

- Auth and rate-limit failures now map to structured `auth_required` /
  retryable `rate_limited` envelopes consistently across adapter surfaces.
- `vercel list` now uses the current Vercel CLI JSON flag.
- Generated stats and public docs now reflect 220 sites, 1283 commands, 966
  adapters, and 7103 tests after the adapter cleanup.

### Removed

- Removed stale Reddit public JSON YAML adapters and fixtures that no longer
  represented the live site.
- Removed the dead Meituan hot adapter after the upstream endpoint returned
  unrecoverable 404 responses and no reliable reference path remained.

## [0.215.1] — 2026-04-24 — Agent Backend Matrix

### Added

- **Coding-agent backend matrix** — `unicli agents matrix` and
  `unicli agents recommend <agent>` now expose a structured v2 policy
  matrix for core, SOTA, bridge, watchlist, and editor-owned coding agents:
  Claude Code, Codex, Hermes, Cursor, Kimi CLI, OpenCode, Gemini CLI, Qwen
  Code, Kiro CLI, Aider, Goose, Amp, GitHub Copilot CLI, Auggie, Crush,
  OpenHands, mini-SWE-agent, SWE-agent, acpx/OpenClaw, AgentAPI, MiniMax CLI,
  Blackbox CLI, Droid, ForgeCode, Rovo Dev, Cline, Roo Code, Windsurf, and
  Continue.
- **Agent CLI hub entries** — external CLI discovery now includes verified
  agent-facing binaries and install hints for Claude Code, Codex, OpenCode,
  acpx, Hermes, Cursor Agent, Gemini CLI, Qwen Code, Kiro CLI, Kimi CLI,
  Aider, Goose, Amp, Copilot, Auggie, Crush, OpenHands, mini-SWE-agent,
  SWE-agent, AgentAPI, Droid, ForgeCode, and Rovo. Blackbox remains
  watchlist-only because the public npm package exposes a generic `cli` bin.
- **Reusable package export** — `@zenalexa/unicli/agents/backends` exports
  the backend matrix and recommendation helpers for other coding-agent
  integrations.

### Changed

- ACP is now documented as an editor compatibility gateway rather than
  Uni-CLI's core runtime path. Recommendations prefer direct CLI, JSON
  stream, MCP, or explicit API/CLI routes first for lower latency and native
  session semantics.
- Backend recommendations now expose `primary_protocol` and
  `external_cli_name`, so callers can distinguish route names like `acpx` or
  `api_cli` from the underlying protocol and install the matching external
  CLI registry entry.
- README, AGENTS.md, roadmap, and release metadata now present v0.215.1 as
  the current agent-backend release line.

## [0.215.0] — 2026-04-24 — Closed Adapter Loop

### Added

- **Browser adapter authoring loop** — `unicli browser analyze`, `browser init`,
  and `browser verify` now cover the OpenCLI-style authoring path with
  structured v2 envelopes, schema-v2 adapter skeletons, fixture generation,
  fixture validation, and `--strict-memory` gates.
- **Reusable site memory** under `~/.unicli/sites/<site>/`: endpoint
  discoveries, field maps, notes, and verify fixtures are now written by
  `explore` / `generate` and consumed by `synthesize` / `browser verify`.
- **Network evidence replay** — `browser network` now persists captured
  responses with stable keys and supports `--filter`, `--detail`, `--ttl`,
  and `--max-body` for repeatable adapter investigation.

### Changed

- `browser verify` runs adapters through the shared invocation kernel using
  fixture-provided args, preserves fixture args on update, and fails with the
  adapter's structured error when execution fails.
- Browser authoring commands are split into focused modules so the top-level
  browser command file stays within the project file-size budget.

### Fixed

- Site analysis now classifies single authenticated API failures as Pattern D,
  records multi-vendor anti-bot evidence instead of keeping only the first
  match, and emits Pattern E for websocket / event-stream surfaces.
- Fixture verification no longer produces a misleading success envelope when
  the adapter execution itself failed.

## [0.213.3] — 2026-04-19 — Vostok · Gagarin TC0 Patch R2

> Closes six gaps left by v0.213.2 along the agent-invocation path:
> unified invocation kernel (P1), MCP/ACP/CLI surface parity (P2),
> output-side TC0 externalization (P3), schema-driven hardening on 71
> adapters (P4), and a multi-provider agent-bench harness (P5).
> Bench posture was recorded in the v0.213.3 git history; empirical ASR
> numbers were deferred to v0.213.4 (OpenRouter credit
> exhausted mid-run; harness is ready, fix landed in commit `d31e72e`).

### Added

- **Invocation kernel** (`src/engine/kernel/{types,ulid,compile,execute}.ts`)
  with monotonic ULID ids and a `CompiledCommand` cache primed by the
  loader. `src/engine/invoke.ts` is now a thin re-export shim. CLI / MCP
  / ACP all route through `buildInvocation()` + `execute()`; the lazy
  compile fallback is gone.
- **Schema-driven hardening** in `src/engine/harden.ts` via `ajv` +
  `ajv-formats` with `format-assertion: true`. Adapter args may declare
  `format:` (JSON Schema draft-2020-12 formats) and a vendor extension
  `x-unicli-kind:` of `id` / `path` / `uri` / `email` / `date` to dispatch
  to a dedicated validator. `validateIdArg` rejects URL-shaped inputs
  (`?` / `#` / `%XX` encodings, `scheme://`).
- **Output projection flags** — `--select <jsonpath>` (`jsonpath-plus`),
  `--fields <a,b,c>`, `--pluck <field>` (newline-sanitized for safety),
  and `--pluck0 <field>` (NUL-delimited for `xargs -0`). `ProjectionError`
  on malformed JSONPath emits `USAGE_ERROR` (exit 2); empty result after
  projection emits `EMPTY_RESULT` (exit 66).
- **Three-channel transport coverage** — `bench/agent/sdk-runner.ts`
  drives any OpenAI-compatible provider via Vercel AI SDK +
  `@ai-sdk/openai-compatible` across `shell` / `file` / `stdin` channels,
  five tasks, four ICS buckets, with per-trial verdicts (`asr_gen`,
  `asr_exec`, `asr_sem`), Wilson-95 CIs, per-model + overall ship-gate
  thresholds, and per-trial USD cost from `bench/agent/pricing.ts`.
- **`scripts/migrate-add-kind.ts`** — comment-preserving YAML codemod
  (552 LOC, `yaml` LineCounter) that annotates 243/1355 args across 223
  YAMLs with `format:` + `x-unicli-kind:`. Idempotent (`--check` exits 0
  after a full pass). 30 unique override triplets were documented in the
  generated codemod report for that release.

### Changed

- **`runPipeline(pipeline, bag, base, opts)` requires a `ResolvedArgs`
  bag** — no more optional default. Seven callers + 107 test sites
  migrated. `ArgSource` extended with `"internal"` / `"mcp"` / `"acp"`;
  template scope exposes `source` / `surface` / `trace_id` so adapters
  can branch on origin.
- **`src/mcp/server.ts` 1061 → 174 LOC** — split into
  `dispatch.ts` / `tools.ts` / `handler.ts` / `http-transport.ts`.
  `src/mcp/streamable-http.ts` 745 → 15 LOC shim, with handlers split
  into `streamable-http/{index,handle-post,session}.ts`. `handlePost`
  itself shrank 349 → 36 LOC.
- **`src/acp.ts` 700 → 523 LOC** — extracted `acp-helpers.ts` (195 LOC)
  and routed through the kernel. `commands/dispatch.ts` 296 → 251 LOC,
  also a thin kernel wrapper.
- **`describe.ts` documents schema divergence** — the introspection
  schema declares `additionalProperties: true` (permissive — agents
  discover by probing); the kernel validation schema enforces
  `additionalProperties: false` (strict — drift fails closed at
  `INPUT_HARDENING_ERROR`, exit 65). The divergence is intentional and
  the comment block explains the contract.

### Fixed

- **`$HOME` prefix-collision in path sandbox** — `validatePathArg` now
  ensures the resolved path is contained within `$HOME` rather than
  string-prefix-matching, so `$HOME-evil` no longer slips through.
- **Per-call ULID ordering** — IDs generated in the same millisecond
  are now strictly monotonic via a same-ms spin-counter, so trace order
  matches generation order in tight loops.
- **MCP health tool counts** are derived from `DEFAULT_TOOL_NAMES`
  rather than hard-coded literals; deferred-tool name collisions warn
  instead of silently shadowing.
- **`bench/agent/sdk-runner.ts` prompt path** — Run 1 (1800 trials,
  $0.645) discovered the prompt's example invocations used bare
  `unicli` (not on `PATH` in the bench env); commit `d31e72e` now
  interpolates `${unicliBin}` into all four examples and adds an
  explicit "absolute path required" guard line per channel stanza.
  Re-run deferred to v0.213.4 due to OpenRouter credit exhaustion.

### Bench posture

The ship-gate (`scripts/bench/check-ship-gate.js`) is a recommended
pre-release check, not a hard merge blocker for this patch. The TC0
thesis and the three-channel design are externally validated
(Merrill & Sabharwal 2023; arXiv:2604.06742; Poehnelt 2026-03;
openclaw#46370). Implementation correctness is carried by 1569 unit +
5514 adapter tests at green. Empirical ASR numbers will land in
v0.213.4 once OpenRouter credit is restored.

## [0.213.2] — 2026-04-18 — Vostok · Gagarin TC0 Patch

> Agent-invocation reliability release. Externalizes argument state out of
> shell quoting (a TC0-bounded mod-2 matching problem that Transformers
> cannot reliably generate) into JSON channels (stdin / `--args-file`).
> Grounded in arXiv:2411.07602 (RoPE + TC0 bounds), 2502.02393 (CoT lower
> bounds), 2604.06742 (CLI-Tool-Bench), 2603.20847 (Claude-Code / Codex /
> Gemini CLI bug study) — see `.claude/plans/sessions/2026-04-18-v213.2-tc0/task_plan.md`.

### Added

- **`--args-file <path>` global flag** — every command accepts a JSON
  object from file. Reuse + version-controllable payloads without touching
  the shell. JSON only; YAML/TOML deliberately not supported.
- **Stdin-JSON auto-detection** — when stdin is non-TTY AND the first byte
  is `{`, Uni-CLI parses it as the argument bag. Precedence:
  `stdin > --args-file > shell flags > positional args > defaults`.
  Externalizes TC0-hostile quote nesting into byte-structured JSON.
- **`unicli describe [site] [command]`** — runtime schema introspection.
  Emits JSON Schema draft-2020-12 for args, a realistic example payload,
  the three invocation-channel templates, and `next_actions` hints.
  Replaces stale markdown docs as the agent's source of truth
  (Poehnelt `gws schema` pattern, Google Workspace CLI 2026-03).
- **`--dry-run` global flag** — resolves the ArgBag and prints the
  execution plan (`command`, `args`, `args_source`, `pipeline_steps`)
  without running the pipeline. Safe preview for mutating commands.
- **HATEOAS `next_actions[]` in v2 envelope** — every success and error
  response carries typed command templates (`params.<name>.value /
.default / .enum / .description`) so agents can navigate without
  re-reading docs. Pattern from joelclaw.com 2026-02.
- **Input hardening** — control-character rejection for string args,
  path-traversal sandbox for path-shaped args, URL-punctuation and
  pre-encoded-id rejection, double-URL-encoding warnings. Fails fast
  with `invalid_input` + directional `suggestion` (Poehnelt pattern,
  Google Workspace CLI).
- **`bench/agent/` harness** — deterministic Invocation Complexity Score
  (ICS, 0..10) calculator with 5 inputs: quote nest depth, backslash
  escapes, non-ASCII chars, arg tokens, inline JSON depth. Payload
  factory generates trivial / moderate / hostile / pathological buckets
  for 5 representative tasks. `npm run bench:agent` writes a timestamped
  `bench/agent/results.json`. ASR / SED measurement via Claude SDK lives
  behind an opt-in flag (costs real API credits).
- **`skills/unicli-claude-code/SKILL.md`** — formal guide teaching Claude
  Code to pick the right channel per payload. The decision rule: if the
  payload contains quotes / emoji / newlines / JSON / is >60 chars,
  pipe it (stdin-JSON); otherwise shell args are fine.

### Changed

- **`src/commands/dispatch.ts` — unified arg resolution** — the inline
  Commander-to-args merging is gone; every code path now calls
  `resolveArgs()` from `src/engine/args.ts`. One place for precedence
  rules, one place for type coercion.
- **Error envelope now includes `next_actions`** — `defaultErrorNextActions()`
  biases hints toward `unicli repair` + stdin-JSON channel switch on
  `invalid_input` / `selector_miss` / `parse_error`, and toward
  `unicli auth setup` on `auth_required`.

### Fixed

- **Commander arg drift** — the previous inline merge silently dropped
  values when the same flag name appeared on the command and its parent,
  because positional-then-optional ordering was ambiguous. The unified
  resolver enumerates schema once per arg and applies precedence
  deterministically.

## [0.213.1] — 2026-04-18 — Vostok · Gagarin Patch

> Patch release closing 25 documented and audited issues against v0.213.0 Gagarin GA.
> Semver-correct bug-fix + cleanup release; no new feature surface.
> See `.claude/plans/sessions/2026-04-17-v213.1-patch/findings.md` for the full audit.

### Added

- **`DEFAULT_SURFACE` + `makeCtx` helpers** exported from `src/output/envelope.ts` — callers building `AgentContext` no longer need to hard-code `surface: "web"` or repeat the 5-field literal. The existing 10 call sites migrate in T3 and T5-T7.

### Fixed

- **`zhihu.answers` MD rendering** — `pickTitle` in `src/output/md.ts` now falls back to `question` → `excerpt` → `summary` before the generic `"Item"` label, so answer listings render meaningful `### N · <question>` headings. Adapter shapes that carry post bodies in `question` + `excerpt` (zhihu.answers) or `summary` (certain arxiv paths) now surface that content as the row title. `zhihu.answers.success.md` fixture regenerated; 2 unit tests in `tests/unit/output/md.test.ts` pin the new priority order (`title > name > id > question > excerpt > summary > "Item"`).
- **`content[]` canonical populated case battle-tested** — the optional `AgentEnvelope.content[]` field first shipped in v0.213.0 was never exercised end-to-end. `src/output/md.ts` now renders a `## Content` section (text / image / resource blocks) when the field is populated; `makeEnvelope()` gained an optional `content` argument threading `AgentContent[]` through the envelope. New golden fixture `tests/fixtures/md/unsplash.search.success-with-content.md` plus 3 unit tests in `md.test.ts` + 2 in `envelope.test.ts` pin the shape for the download-step use case (`{type:"resource", uri:"file://…"}`). YAML-adapter opt-in via `emit_content: true` is documented on `makeEnvelope`; the runner-side plumbing to auto-populate from `download` step output ships in v0.214.
- **`stats-consistency.test.ts` timeout bumped 5s → 60s** — `computeStats()` spawns `vitest list --json` twice (one per project) after T11's rewrite, which takes ~10-25s on cold runs of this repo. The 5s default was tight from day one and timed out under `npm run verify` on slower machines. 7 sibling tests were already fast and unchanged.
- **Ref-Locator verification layer** — `BrowserPage.snapshot()` and `DaemonPage.snapshot()` now persist a window-level fingerprint map on `window.__unicli_ref_identity`; click/type steps plus `unicli operate click/type` resolve refs against this map and throw structured `TargetError` ({code: "stale_ref" | "ambiguous" | "ref_not_found"}) when a ref fails to bind uniquely. `executor.ts` re-wraps the TargetError into a `PipelineError` preserving `detail.code` as `errorType`, and `dispatch.ts` passes it through verbatim to the v2 envelope's `AgentError.code`. Ports the diagnostics layer from OpenCLI PR #1016 on top of our existing snapshot primitive. `ref_not_found` is deliberately distinct from the HTTP-404 `not_found` code so agents can tell DOM-level from server-level failures.
- **`streamable-http` test port flake fixed** — `tests/unit/streamable-http.test.ts` now calls `server.listen(0)` and reads the OS-assigned port via `address().port`, retiring the 5-attempt `Math.random()` retry loop added in v0.213.0-beta.2. Zero collision risk on busy CI runners.
- **Windows cold-start test timeouts bumped** — `tests/unit/{exports,loader-parity,mcp-server-expanded}.test.ts` now give Windows Node 20 runners 15s instead of 5s for dynamic-import cold-start cases. Linux/macOS timing unchanged.
- **`dist/main.js` execute bit set via postbuild hook** — when `npm run build` runs, `dist/main.js` is now chmod'd to 755 so it's immediately executable when extracted from the tarball. Previously mode 644; npm auto-chmods on install but manual tarball consumers had to `chmod +x` themselves. Uses `node -e "require('fs').chmodSync(...)"` so Windows builds are untouched gracefully.
- **`scripts/release.ts` replacement patterns refreshed** — 4 of 6 patterns were stale after v0.213.0's documentation restructure, causing `npm run release` to silently SKIP updates. Patterns for CLAUDE.md (.gitignored), the retired `## Available Sites` / `N sites, M commands` AGENTS.md headers, and the retired `N_Sites-M_Commands` README badge are deleted; site/command/pipeline/test counts are now authoritative in `scripts/build-readme.ts` via `<!-- STATS:key -->` markers. README footer codename regex updated to match the current `<sub>vX.Y.Z — Codename</sub>` shape. `docs/ROADMAP.md` summary version pattern narrowed to `as of vX.Y.Z` so STATS marker interleaving no longer blocks the match. `npx tsx scripts/release.ts --dry-run` now emits 0 SKIP warnings.
- **Test coverage closed on 3 v0.213.0 gaps** — CLI-level quarantine dispatch via subprocess spawn (`tests/unit/cli/quarantine-cli.test.ts` asserts the full `process.exit` path — exit code 78, stderr-routed v2 envelope with `error.code: "quarantined"`, plus a `UNICLI_FORCE_QUARANTINE=1` bypass guard); `format()` error-wins precedence when both `ctx.error` and non-null `data` are passed (non-empty array, object payload, and yaml/md output all verified to discard the data and emit `data: null`); `UNICLI_OUTPUT` env bare override detection when `OUTPUT` is explicitly unset, plus the UNICLI_OUTPUT-wins-when-both-set path asserts no deprecation warning leaks.
- **`stats.json.test_count` now matches runtime vitest count** — the regex-based counter in `scripts/count-stats.ts` missed `it.each([...])` parametrised cases and loop-generated tests (1314 claimed vs 6921 actual across unit + adapter projects). Rewritten to enumerate via `npx vitest list --json --project=<name>` per project, so parametrised and dynamic tests are counted exactly. Regex fallback (`UNICLI_STATS_TEST_STRATEGY=regex` or when vitest spawn fails) still ships for sandboxed environments. Accuracy now within 0% of `npm run test` + `npm run test:adapter` runtime output.
- **`stats.json` regenerated** — `test_count` 1314 → 6921 now propagates through the `<!-- STATS:test_count -->` markers in README / AGENTS / ROADMAP / copy rules. `site_count` stays at 200, which matches `dist/manifest.json` truth: the 5 extra directories under `src/adapters/` are the `_electron` shared-infra module (prefixed with `_`, never a site) plus 4 AI-chat adapters (`antigravity`, `chatgpt`, `chatwise`, `doubao-app`) that register via `registerAIChatCommands()` rather than direct `cli()` calls. Those 4 surface at runtime (203 runtime sites) but are intentionally excluded from the manifest/stats site count until the registration pathway is unified in v0.214.

### Changed

- **887 YAML adapters: duplicate schema-v2 migration banner comments coalesced** — the v0.212 migration injected a banner + 5 metadata fields; the v0.213 migration re-emitted the same banner before the new `schema_version: v2` line, leaving every adapter with two identical comment lines. New one-off `scripts/dedupe-yaml-banner.ts` walks `src/adapters/**/*.yaml`, drops the second banner in exactly the canonical duplicate shape, and is idempotent (dry-runs to 0 after a full pass). Purely cosmetic; adapter lints + 5514 adapter tests stay green.
- **undici stays at 8.0.2** — the 8.1.0 bump attempted in this patch calls `webidl.util.markAsUncloneable` which does not exist in Node 20, breaking our `"engines": ">=20"` CI matrix. Deferred to v0.214 pending a Node 22+ engine bump.
- **`AgentError.code` documented enum expanded 11 → 15** — adds `quarantined` (already emitted by the quarantine gate since v0.213.0) and the three T1 ref-locator codes `stale_ref` / `ambiguous` / `ref_not_found`. `code` remains an open string to preserve forward compatibility.
- **`UNICLI_OUTPUT` env var is now canonical**; bare `OUTPUT` is deprecated and emits a stderr warning. CI systems that set `OUTPUT` for their own purposes (GitHub Actions step outputs, Jenkins outputs) no longer accidentally switch unicli's output format. `OUTPUT` will be removed in v0.214.
- **`detectFormat` simplified** — the three branches that all returned `"md"` (non-TTY, agent-UA, default) are collapsed into a single final return, now documented in one comment.
- **`isAgentUA` no longer inspects the `USER_AGENT` env var** — that variable isn't set in subprocess contexts (it's an HTTP header name, not a process env var). The 5 canonical agent env vars (`CLAUDE_CODE`, `CODEX_CLI`, `OPENCODE`, `HERMES_AGENT`, `UNICLI_AGENT`) remain.
- **Error-mapping helpers extracted to `src/output/error-map.ts`** — `errorTypeToCode`, `mapErrorToExitCode`, `errorToAgentFields`, and `REF_LOCATOR_CODES` now live in one reusable module. `src/commands/dispatch.ts` slims by ~60 LOC; the 4-way `err instanceof` ternary (repeated 7 times) collapses to a single `errorToAgentFields` call.
- **17 admin commands migrated to v2 envelope**, closing the gap documented in v0.213.0's "every command" claim. Wired: `agents`, `auth`, `eval`, `explore`, `generate`, `hub`, `lint`, `mcp` (health/list/install/config), `migrate`, `migrate-schema`, `operate`, `repair`, `research`, `schema`, `skills`, `status`, `synthesize`. Combined with the 7 v0.213.0-wired sites (adapter dispatch + `core.list/health/usage/search` + `ext.list` + `dev.watch`), the v2 envelope contract now covers 24 command surfaces. `mcp serve` intentionally stays raw (stdio MCP protocol). All envelopes flow through `format(data, columns, fmt, ctx)`; human-oriented chalk summaries route to stderr (Scene-6 pattern). The `operate upload` sensitive-path / workspace-boundary deny branches also normalize to structured error envelopes now, closing the last non-envelope bypass.

### Removed

- **`health --json` flag removed** — duplicated `-f json`; use `-f json` (or `UNICLI_OUTPUT=json`).
- **Top-level `--json` alias removed** — pre-v0.213 legacy; use `-f json` (or `UNICLI_OUTPUT=json`). The `applyJsonAlias` helper and its unit test are deleted.

### Breaking

- **`unicli agents generate > AGENTS.md` no longer writes raw Markdown to stdout.** Stdout now returns the v2 envelope (with `data.generated` carrying the generated MD). Use `unicli agents generate --output AGENTS.md` to write the raw file. Callers redirecting stdout to capture raw MD must migrate.

## [0.213.0] — 2026-04-17 — Vostok · Gagarin

> **GA release.** Engine rigor + Agent-Native output + honest parity numbers.
> 195 sites · 957 commands · engine split (2810 → 298 LOC executor) · schema-v2 on 896 adapters · v2 envelope with `-f md` default for agents · 1286 unit + 5514 adapter = 6800 tests passing.
>
> **Since v0.212.1 Shatalov II** the branch accumulated 46 commits across two prereleases:
>
> - **beta.1 (engine rigor)**: yaml-runner split into executor + registry + runtime + template + ssrf + 33 step files; 24 plugin export subpaths + `PLUGIN.md` + exports CI gate; weekly release CI cron + dependabot grouping; schema-v2 migration on 896 YAML adapters; 80 colocated adapter tests.
> - **beta.2 (agent-native output)**: v2 `{ok, schema_version, command, meta, data, error, content?}` envelope, `-f md` default on non-TTY and recognised agent UAs, `isAgentUA()` detector, 7 call sites wired, `src/commands/dispatch.ts` extracted from `cli.ts`, 20 golden MD fixtures across 10 flagship adapter pairs, quarantine envelope aligned.
> - **GA polish**: `docs/THEORY.md` v2 now cites SkillDroid (arXiv:2604.14872), MolmoWeb, IntentScore, Android Coach, Beyond Chat and Clicks — 46 refs verified against arxiv.org; `PARITY_AUDIT.md` publishes measured per-CLI numbers against `public-clis`; Ref-Backed Locator primitive audited vs OpenCLI PR #1016.
>
> **Honest parity numbers.** Measured per-CLI parity against `github.com/public-clis/public-clis` on 2026-04-17: 85.7% on the four core social sites (twitter 95.7%, reddit 87.0%, xiaohongshu 82.8%, bilibili 77.3%); weighted across eight messaging peer CLIs the figure is 73.5%, not 85%. Uni-CLI ships ~45 commands on overlapping sites that no peer offers (twitter trending/spaces/lists/media, bilibili live/later, xiaohongshu creator-suite, reddit rising/frontpage). Telegram (0 adapters), Discord (placeholder only), and Obsidian vault-write are explicit scope-outs deferred to v0.214. Positioning: breadth (195 sites in one binary) + self-repair + editable 20-line YAML adapters, not per-peer command parity.
>
> **Ref-Backed Locator (OpenCLI PR #1016) parity.** Snapshot-driven numbered refs, interactive-only filtering, scroll markers, iframe/shadow-DOM crossing all ship since v0.211. The verification-layer diagnostics that PR #1016 added on top — window-level fingerprint map, `stale_ref` / `ambiguous` / `not_found` structured errors with candidate lists — are scoped for v0.213.1 (~2–3 days).
>
> **Remaining v0.213 runway → v0.214 Nikolayev**: workflow adapters (gmail/gcal/drive/spotify/apple-notes/imessage), Chrome extension full pipeline, `generate --verify` closed loop, CUA backend drivers, dual JS adapter format, `unicli inbox`, `unicli shop`, and the full 25-adapter OpenCLI parity harness.

### Breaking

- **`--json` / `--yaml` output shape changed to v2 envelope.** Adapter dispatch plus `core.list`, `core.health`, `core.search`, `core.usage`, `ext.list`, and `dev.watch` now return `{ok, schema_version: "2", command, meta, data, error, content?}`. Pre-P-B flat arrays are no longer emitted from these paths; parse `data` from the envelope. Remaining admin commands (`repair`, `skills`, `hub`, `operate`, `mcp health`, `explore`, `eval`, `lint`, `status`, `schema`) migrate in v0.214. `csv` and `compact` output formats are unchanged.
- **Non-TTY default format is now `md`**, not `json`. Set `-f json` (or `UNICLI_OUTPUT=json`) to restore the previous behaviour for scripts that parse stdout.
- **`table` format deprecated** and now falls back to `md` with a stderr warning.
- **Command naming unified to `<area>.<action>`** in the envelope `command` field (e.g. `core.list`, `ext.install`, `dev.watch`, plus `<adapter>.<cmd>` for adapter dispatch). Flat command names such as `list` no longer appear in envelopes.

### Added

- **`src/output/envelope.ts`** (184 LOC) — `AgentEnvelope` discriminated union (`AgentEnvelopeOk | AgentEnvelopeErr`), `AgentMeta`, `AgentError`, `AgentContext`, `AgentContent`, factories `makeEnvelope()` / `makeError()`, and `validateEnvelope()` with 9 structural invariants (schema_version, ok/error mutual exclusion, ok/data correlation, `<site>.<command>` regex, duration_ms type, content[].type enum, count/data.length consistency).
- **`src/output/md.ts`** (313 LOC) — `renderMd(envelope)` produces YAML frontmatter plus `## Data` / `## Context` / `## Next Actions` / `## Error` / `## Suggestion` / `## Alternatives` sections. Handles null/undefined/Date/Buffer/Function/BigInt/circular references, shared-ref DAGs, long strings, throwing `toJSON`, and unserializable values without crashing. Markdown injection sanitised at 21 insertion points.
- **`-f md` output format** (`UNICLI_OUTPUT=md` and agent-UA env vars also trigger it) with stable byte-for-byte rendering per input (golden-fixture tested).
- **Agent-UA auto-detection** — `isAgentUA()` reads `CLAUDE_CODE`, `CODEX_CLI`, `OPENCODE`, `HERMES_AGENT`, `UNICLI_AGENT` environment variables and switches output to `md` when any is set.
- **`UNICLI_OUTPUT` / `OUTPUT` env var override** — `json|yaml|md|csv|compact`, overrides auto-detection; `--format` / `-f` flag has highest priority.
- **`src/commands/dispatch.ts`** (299 LOC) — adapter-dispatch path extracted from `cli.ts`, including envelope construction and the structured-error path (`AgentError` → `ctx.error` → v2 error envelope to stderr with `errorTypeToCode` + `mapErrorToExitCode` helpers).
- **20 MD golden fixtures** under `tests/fixtures/md/<site>.<command>.{success,error}.md` covering 10 flagship adapter pairs (twitter.mentions, reddit.frontpage, bilibili.dynamic, hackernews.top, github-trending.daily, arxiv.search, xiaohongshu.feed, zhihu.answers, douban.book-hot, notion.search). Regenerate with `UPDATE_FIXTURES=1 npx vitest run tests/unit/output/fixtures.test.ts`.

### Changed

- **`format(data, columns, fmt, ctx)`** now requires an `AgentContext` argument; TypeScript enforces it at every call site.
- **`src/cli.ts` slimmed 781 → 490 LOC** by moving adapter dispatch into `src/commands/dispatch.ts`; the complexity gate is green.
- **7 call sites migrated to the envelope path**: `core.list` in `src/cli.ts`, adapter dispatch in `src/commands/dispatch.ts`, plus `src/commands/{ext,usage,dev,search,health}.ts`.
- **`detectFormat()` order**: explicit `--format` > `UNICLI_OUTPUT` / `OUTPUT` env > non-TTY (md) > agent-UA (md) > md default.

### Fixed

- **No silent envelope bypass on empty results, chalk-styled rows, `health.json`, `core.usage --json`, or the adapter-dispatch catch path** — every surface that previously emitted raw arrays or `console.log` now goes through `format()`.
- **Command regex `<area>.<action>`** is the only accepted shape for envelope `command`; legacy dash-case values are rejected by `validateEnvelope`.

## [0.212.1] — 2026-04-16 — Vostok · Shatalov II

> Pre-push security and contract hardening after third-round audit.

### Security

- **SSRF defence on pipeline fetch** — `stepFetch` / `stepFetchText` / HTTP transport reject `file://`, `data:`, `gopher:` schemes and private/loopback/metadata addresses (`127.0.0.0/8`, `10/8`, `192.168/16`, `172.16–31/12`, `169.254/16`, `localhost`, `metadata.google.internal`). Set `UNICLI_ALLOW_LOCAL=1` to override for local development. Tests inherit `UNICLI_ALLOW_LOCAL=1` via vitest config; production runs never get it.
- **AppleScript injection hardening** — `escapeAs` now folds `\r` / `\n` to spaces and strips NUL bytes so a user-controlled app name like `Calculator"\nos_command(...)` can no longer smuggle new statements past `osascript -e`.
- **OAuth Bearer constant-time validation** — `validateBearer` scans every resident token with `crypto.timingSafeEqual` so the timing between "no match" and "expired match" doesn't leak which prefix of a guessed token matched. Token length capped at 128 chars.
- **Billion-laughs + oversized YAML defense** — `js-yaml.load` switched to `CORE_SCHEMA` (blocks `!!js/*` tags) and file size capped at 256 KiB before parse.
- **release.yml scope tightening** — `id-token: write` moved from workflow to job level; workflow-level `permissions: {}` forbids broad grants. NPM_TOKEN stays as an explicit fallback when Trusted Publishers is not yet bound.

### Fixed — Contract Drift

- **schema-v2 hard gate validates the full YAML**, not a five-field projection — the legacy `pipeline`, `url`, `params` fields now go through Zod too, so `pipeline: "string"` fails the gate (it would have crashed at runtime before). Warn mode always writes to stderr.
- **clipboard step names aligned** — the capability matrix referenced `clipboard_get` / `clipboard_set` while every handler, adapter, lint engine, and migrator used `clipboard_read` / `clipboard_write`. Matrix renamed to match, so `bus.require("clipboard_read")` resolves.
- **Quarantine enforcement** — `unicli <site> <cmd>` for a command flagged `quarantine: true` now emits a structured envelope to stderr and exits-78 (CONFIG_ERROR) with a `unicli repair` hint. Bypass flag `UNICLI_FORCE_QUARANTINE=1` for debugging.
- **TransportBus registers all 7 transports** — `HttpTransport`, `CdpBrowserTransport`, `SubprocessTransport` previously not registered on the shared bus (capability queries lied). Now every transport is visible to `bus.require`.
- **AnthropicBackend stub honesty** — error messages now say "v0.213-deferred" explicitly and explain that a production Anthropic backend MUST compose with a screen capture source. `ANTHROPIC_CUA_TOOL_VERSION` env overrides the tool identifier so operators can follow the Sonnet 4.6 rollout.

### Fixed — Robustness

- **migrate-schema roundtrip validation** — every rewritten YAML is re-parsed and run through `validateAdapterV2` before being blessed as migrated; failures are quarantined with a reason.
- **stepParallel concurrency cap** — replaced unbounded `Promise.all` with `mapConcurrent(5)`.
- **ACP prompt length bound** — `parseUnicliInvocation` truncates input to 64 KiB before regex scan (ReDoS defence).
- **MCP SSE event IDs** — every SSE frame now carries an `id:` line; `Last-Event-ID` request header is accepted and logged (full replay lands in v0.213 per `docs/ROADMAP.md`).

### Changed

- **stats.json adds `app_transport_count`** — 7 application-layer transports (TRANSPORT_KINDS) distinct from the 3 MCP server-side transports. `pipeline_step_count` now counts `CAPABILITY_MATRIX` top-level keys (54) rather than `executeStep` switch arms (31) — matches the spec promise of the step catalog.
- **verify chain expanded** — `npm run verify` now runs `conformance` + `verify:changesets` in addition to the previous 10 gates. Full network probe (`adapter:health`) + bibtex resolve available via `npm run verify:full`.
- **docs/ROADMAP.md** — added v0.213 deferred items covering Anthropic planner composition, Windows UIA / Linux AT-SPI napi-rs bindings, full Last-Event-ID replay, Gmail/GCal/Drive OAuth adapters.

## [0.212.0] — 2026-04-15 — Vostok · Shatalov

> The execution layer for agent skills. Deterministic, editable, cross-vendor.
> 200 sites · 968 commands · 7-transport architecture · CUA · ACP · 1134 tests.

### Minor Changes

- e456a01: v0.212.0 "Shatalov" — the execution layer for agent skills.

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
  - `docs/ADAPTER-FORMAT.md` v2 and adapter migration tooling
  - `docs/guide/integrations.md` integration guide
  - `contributing/` per-domain guides (adapter, transport, cua, mcp, acp, release, schema, branch-protection)
  - `.claude/commands/` and `skills/` committed as cross-vendor workflow surface
  - Changesets workflow + `verify-changesets` CI gate
  - `adapter-health` (PR-soft) + `adapter-health-strict` (push/nightly) gates
  - Nightly conformance suite with artifact upload

  ### Changed
  - Formatter rewritten: `table` dropped; added `compact` format (newline-delimited, token-efficient)
  - `--json` global flag becomes deprecation alias for `-f json` with stderr warning
  - stats.json is the single source of truth for counts; CI gate enforces marker consistency across README/AGENTS.md/COPY.md/ROADMAP.md
  - All GitHub Actions SHA-pinned (checkout/setup-node/upload-artifact/stale/gh-release)
  - CI matrix expanded to Node 20/22 × macOS 14 × Windows × Ubuntu
  - Retired "~80 tokens" claim; published honest measured-in-BENCHMARK.md decomposition

  ### Fixed
  - Conflict resolved across Phase 0+8: unified verify chain runs format:check → typecheck → lint → lint:context → build:manifest → lint:adapters → test → build → stats:check

## [0.211.2] — 2026-04-13 — Vostok · Volynov

> Discovery engine, MCP infrastructure, self-repairing CLI for AI agents.
> 198 sites · 1020 commands · BM25+TF-IDF bilingual search · MCP 2025-03-26 · 855 tests.

### Added

- **BM25+TF-IDF hybrid bilingual search engine** — `unicli search "推特热门"` finds `twitter trending` (Top-1: 67.76%, Top-5: 81.31%). 200+ Chinese↔English alias entries, mixed-script tokenizer (B站, QQ音乐), 50KB index, <10ms queries
- **MCP Streamable HTTP transport** — replaces deprecated SSE. Single POST /mcp endpoint, MCP-Session-Id headers, Origin validation, CORS, DELETE session termination (spec 2025-03-26)
- **MCP OAuth 2.1 PKCE** — authorization code flow with S256 challenge, `--auth` flag on HTTP/Streamable transports
- **MCP deferred tool loading** — 4 meta-tools at ~200 tokens default, 956 lightweight stubs with searchHint for on-demand discovery (95% token reduction)
- **`unicli search` CLI command** — bilingual semantic search across all adapters
- **`unicli_search` MCP tool** — alwaysLoad, bilingual discovery for MCP clients
- **`unicli_explore` MCP tool** — renamed from `unicli_discover` (backwards-compatible alias kept)
- **Eval suite** — 214 bilingual queries measuring Top-1/3/5 accuracy across 15 categories
- **Logo SVG** — dark/light mode adaptive via `<picture>` element
- **Tool annotations** — `idempotentHint` and `destructiveHint` added per MCP 2025-03-26 spec

### Changed

- **MCP protocol version** — upgraded from 2024-11-05 to 2025-03-26
- **Schema builder extracted** — `src/mcp/schema.ts` eliminates duplication between server.ts and commands/schema.ts
- **README rewritten** — compiler tagline, architecture diagram, number badges, agent integration section
- **AGENTS.md** — search-first instructions, MCP server documentation, version update
- **Build manifest** — now generates search index (`manifest-search.json`) and compact catalog (`manifest-compact.txt`)

### Security

- Codex cross-audit: 2 independent reviews, all CRITICAL findings addressed
- Streamable HTTP: Origin validation, body size limits, session management
- OAuth: single-use auth codes (60s TTL), PKCE S256 only, token expiry (3600s)

## [0.210.0] — 2026-04-12 — Vostok · Komarov

> The compiler that turns the internet into deterministic programs for AI agents.
> 195 sites · 957 commands · 30 macOS system adapters · 35 external CLIs · 5 agent skills.

### Added

- **Error reliability system** — `retryable` and `alternatives` fields in all structured error output; agents never get opaque errors
- **Agent platform skills** — 5 SKILL.md files (agentskills.io standard) covering 39 agent platforms
- **`unicli status` command** — lightweight system health JSON for agent pre-flight checks
- **Cloudflare remote browser** — `UNICLI_CDP_ENDPOINT` connects to any remote CDP WebSocket (Cloudflare Browser Rendering, etc.)
- **30 macOS system adapters** — volume, dark-mode, battery, notify, clipboard, screenshot, say, spotlight, system-info, disk-info, wifi, lock-screen, caffeinate, trash, open, apps, calendar-list, calendar-create, contacts-search, mail-status, mail-send, reminder-create, notes-list, notes-search, music-now, music-control, messages-send, photos-search, finder-tags, finder-recent
- **20 new web sites** — threads, deepseek, perplexity, baidu, toutiao, maoyan, futu, coinbase, kuaishou, ele, dianping, dangdang, mubu, douyu, wechat-channels, binance, ke, maimai, slock, and more
- **Desktop app adapters** — vscode (extensions, install-ext, open), obsidian (open, search, daily), chrome (bookmarks, tabs), zoom (join, start)
- **Electron app deepening** — cursor (+export, +history), discord (+delete), slack (+search, +send, +status)
- **Site command deepening** — zhihu +13, xiaohongshu +9, twitter +9, instagram +5, bilibili +4, youtube +3, plus 100+ commands across 40+ existing sites
- **External CLI hub** — kimi-cli (8K★), gws (Google Workspace), deepagents (LangChain) → 35 total

### Changed

- `BridgeConnectionError` now includes structured JSON with retry guidance
- Non-PipelineError catch-all in cli.ts emits full structured error (was opaque `{error: message}`)
- AGENTS.md fully rewritten with accurate site/command counts and category listings

## [0.209.0] — 2026-04-10 — Vostok · Popovich

> Discover, Evolve, Connect. 167 sites · 756 commands.
> Auto-discovery pipeline, AutoResearch self-improvement loop, Adapter Hub,
> 29 new adapter sites spanning AI/ML, finance, music, news, devtools, and
> enterprise collaboration. MiniMax MMX-CLI integration (day-0), Feishu/Lark
> CLI bridge, and 5 security hardening fixes from triple-review audit.

### Added

- **Auto-discovery engine** — `src/engine/endpoint.ts` (unified endpoint analysis with role-based field mapping), `src/engine/probe.ts` (snapshot-based interactive probing), `src/engine/framework.ts` (React/Vue/Next/Nuxt/Svelte/Angular detection + Pinia/Vuex store discovery), `src/engine/capability.ts` (12 EN+ZH goal aliases, 5 pipeline patterns: public-fetch, cookie-fetch, browser-evaluate, intercept, store-action). Builds on existing `explore`/`synthesize`/`generate` commands.
- **AutoResearch engine** — `unicli research run <site>` — Karpathy-style 8-phase self-improvement loop (precondition → review → modify via Claude Code → commit → verify via eval → guard → decide keep/discard → log). 4 presets: reliability, coverage, freshness, security. `unicli research log` and `unicli research report` for history and aggregation. Stuck detection at 5 consecutive discards with escalating hints.
- **Adapter Hub** — `unicli hub search/install/publish/update/verify` — git-based community adapter registry via GitHub API (`olo-dot-io/unicli-hub`). Install adapters from hub, publish via PR.
- **Test generator** — `unicli test-gen generate <site>` auto-generates Vitest tests from eval files. `unicli test-gen ci` tests only adapters changed in current commit.
- **Multi-harness AGENTS.md** — `unicli agents generate --for cursor|codex|goose|generic` generates harness-optimized discovery files.
- **MCP discover tool** — `unicli_discover` exposed as MCP tool in expanded mode. URL → explore → generate, callable from any MCP client.
- **Auto-eval generation** — `unicli generate` now auto-creates `evals/smoke/<site>.yaml` when installing a new adapter.
- **Response caching** — `cache: <seconds>` field on `fetch` pipeline step. Cached to `~/.unicli/cache/` with 10MB per-entry limit.
- **Strategy fallback** — `fetch` step auto-retries with cookie injection on 401/403 responses.
- **29 new adapter sites** — minimax (chat, models, tts), feishu (send, docs, calendar, tasks), gitlab (trending, search), netease-music (hot, search), techcrunch (latest), theverge (latest), nytimes (top), cnn (top), sspai (latest, hot), ithome (news), infoq (articles), eastmoney (hot, search), mastodon (trending, search), twitch (top), openrouter (models), huggingface-papers (daily), replicate (trending, search), ycombinator (launches), gitee (trending, search), crates-io (search), pypi (info), homebrew (info), npm-trends (compare), docker-hub (search), cocoapods (search), unsplash (search), pexels (search), exchangerate (convert), ip-info (lookup), qweather (now), itch-io (popular), meituan (search), pinduoduo (hot).

### Security

- **Shell injection prevention in research engine** — all scope pattern resolution uses Node `readdirSync` (no shell). `runVerify` and `runGuard` use `execFileSync("unicli", [...args])` instead of `sh -c`. Site names validated against `/^[a-zA-Z0-9_-]+$/`.
- **Hub path traversal prevention** — site/command names validated in all subcommands (install, publish, verify). `execFileSync` with args array instead of shell interpolation.
- **MCP HTTP loopback binding** — HTTP transport explicitly binds to `127.0.0.1`, not `0.0.0.0`.
- **Probe ref validation** — CSS selector injection prevented by `/^\d+$/` check on snapshot refs.
- **Cache size limit** — 10MB per-entry cap prevents disk exhaustion from oversized API responses.
- **Claude Code tool restriction** — research engine uses `--allowedTools "Read,Edit,Glob,Grep"` (no Write, no Bash).

### Changed

- **All adapters always visible** — `detect:` field is informational only, does not gate adapter registration. Desktop adapters appear in `unicli list` regardless of whether the binary is installed. Runtime errors give clear install instructions.
- **`agents generate` multi-format** — new `--for` flag generates Cursor Rules, Codex-optimized, Goose recipe, or generic markdown formats.
- **`generate` auto-eval** — installing an adapter via `unicli generate` now auto-creates a smoke eval file.

## [0.208.0] — 2026-04-08 — Vostok · Titov

> Standards, Distribution, and Self-Improvement. 134 sites · 711 commands.
> Skills export, hardened MCP gateway, eval catalog, `observe()` verb,
> and sensitive-path deny list.
>
> **Post-release hardening:** a 4-reviewer audit of the initial release
> commit (`a1e75cb`) surfaced 6 BLOCKERs and 9 MAJORs. All were fixed in
> `5e6237f` before the tag was cut — the release-facing SHA. See the
> "Post-release audit (5e6237f)" section below for the full list.

### Added

- **`unicli skills export` (deliverable A)** — auto-generates one Anthropic-spec SKILL.md per adapter command into `skills/`. `unicli skills publish [--to ~/.claude/skills/uni-cli/]` copies into a Claude/Cursor skills directory. `unicli skills catalog` writes the canonical machine-readable manifest at `docs/adapters-catalog.json`. `scripts/generate-catalog.ts` ships as the build-time entry point.
- **`unicli mcp serve` (deliverable B)** — production-ready MCP gateway. Default expanded mode auto-registers one tool per adapter command (`unicli_<site>_<command>`) with input schemas derived from `args` and output schemas from `columns`. Lazy mode (`--lazy`) preserves the v0.207 2-tool surface. New `--transport http --port 19826` adds JSON-RPC over `POST /mcp` for self-hosted environments. `unicli mcp health` is the offline pre-flight check.
- **`unicli eval` (deliverable C)** — declarative regression suites. 15 starter eval files ship under `evals/`: 12 smoke (hackernews, bilibili, github, reddit, weibo, zhihu, xiaohongshu, douyin, youtube, twitter, instagram, linkedin, hupu, douban, producthunt) + 3 regression (auth-rotation, selector-drift, api-versioning). Subcommands: `eval list`, `eval run [--all]`, `eval ci --since 7d`. Output format: `SCORE=N/M` plus structured JSON for CI.
- **Per-call cost ledger (deliverable D)** — append-only JSONL at `~/.unicli/usage.jsonl` capturing `{ts, site, cmd, strategy, tokens, ms, bytes, exit}` for every CLI invocation. `unicli usage report [--since 7d] [--slow] [--failing]` aggregates by site+cmd with median, p95, error rate, and bytes. Opt out with `UNICLI_NO_LEDGER=1`.
- **`unicli operate observe <query>` (deliverable I)** — Preview verb. Snapshots the page, ranks interactive elements against the natural-language query (token overlap, exact label, role/aria bonuses), returns `{action, ref, selector, confidence, reason}` candidates. Caches every observation to `~/.unicli/observe-cache.jsonl` for self-healing audits.
- **8 strategic adapters (deliverable F)** — `hermes`, `openharness`, `motion-studio`, `stagehand`, `godot`, `renderdoc`, `autoagent`, `cua`. +14 commands total.
- **AgentLint integration (deliverable E)** — `scripts/lint-context.sh` runs Agent Lint against the workspace and gates `npm run verify` on context quality. Default threshold 60/100, override with `UNICLI_LINT_THRESHOLD`. Disable with `UNICLI_LINT_DISABLE=1`.
- **Documentation (deliverable H)** — maintenance and integration docs now live in `docs/reference/maintenance.md` and `docs/guide/integrations.md`.

### Security

- **Sensitive path deny list (deliverable J)** — `src/permissions/sensitive-paths.ts` blocks access to sensitive paths (`.ssh`, `.aws/credentials`, `.gnupg`, `.kube/config`, `.docker/config.json`, `.npmrc`, cookie/credential files). Enforced in `unicli operate upload` and the `exec` pipeline step. Returns structured error JSON on stderr.

### Changed

- **MCP server default mode** — `unicli mcp serve` now boots in expanded mode (one tool per adapter command). Lazy mode (the v0.207 default) is opt-in via `--lazy`. The existing `tests/unit/mcp-server.test.ts` was updated to spawn with `--lazy` to preserve the 2-tool contract; new `tests/unit/mcp-server-expanded.test.ts` covers the expanded surface.
- **`npm run verify`** — chains `lint:context` between `lint` and `test`. Soft-skips when Agent Lint is not installed.
- **`recordUsage` cli.ts hook** — every dynamic site command writes a ledger entry on success, empty result, pipeline error, and generic error.

### Post-release audit (5e6237f)

A 4-reviewer parallel audit (plumbing / runtime / security / release-wiring) over `a1e75cb` identified 6 BLOCKERs and 9 MAJORs. All fixed in commit `5e6237f` before the v0.208.0 tag was cut. The numbered list below is the authoritative record for anyone tracing "what did v0.208 change beyond its own release notes."

**BLOCKERs fixed:**

1. **Shell injection in 4 new adapter YAMLs.** `hermes/skills-read`, `hermes/sessions-search`, `openharness/memory-read`, `renderdoc/capture-list` used `bash -c` with `${{ args.* }}` raw-interpolated into the script body. The template engine emits `String(value)` with no shell quoting, so a crafted arg like `foo"; printf OWNED; #` escaped the string literal. **Fix:** rewrote all bash adapters to pass user input via environment variables (`UNICLI_NAME`, `UNICLI_TOPIC`, `UNICLI_QUERY`, etc.) and reference them as `"$VAR"` bash literals. Added path-traversal rejection (case globs for `..` and `/`) where the name flows into a file path. PoC was verified by Codex against the live engine.

2. **SQL injection in `hermes/sessions-search.yaml`.** `${{ args.query }}` was spliced into the FTS5 `MATCH` and `LIKE` clauses. Verified against `sqlite3 :memory:`: `query=hello' UNION SELECT '999','888','PWN' --` returned the injected row. **Fix:** the env-var rewrite above plus bash `${UNICLI_QUERY//\'/\'\'}` parameter expansion to SQL-escape single quotes. `LIMIT` clause strips non-digits via `${UNICLI_LIMIT//[^0-9]/}`.

3. **Eval runner shell injection in `src/commands/eval.ts`.** `runCase()` used `execSync` with a string-concatenated command line, so positional values with spaces, quotes, or shell metachars were reinterpreted. **Fix:** replaced with `spawnSync(executable, argv)`. Added `parseCliCommand()` to handle `UNICLI_BIN="npx tsx src/main.ts"` dev invocations without reintroducing shell parsing. The `eval ci --since` git log call was also converted from `execSync` to `spawnSync`, and `--since` is now regex-validated before being passed to git.

4. **Pre-existing: dist-mode loader could not see YAML adapters.** `src/discovery/loader.ts` set `BUILTIN_DIR = join(__dirname, "..", "adapters")` which resolves to `dist/adapters` in built mode, but `tsc` does not copy YAML files — only `.js` + `.d.ts`. Compounding this, `collectTsFiles` matched `.d.ts` declaration files via `extname(file) === ".ts"` and imported them as empty ES modules, silently inflating the TS adapter count to 81 while registering zero commands. `node dist/main.js doctor` reported `Sites: 0`. This bug existed since v0.1.0 but was dormant until the package was first published to npm in v0.207.1 (commit `607cedb`). **Fix:** new `findAdapterDirs()` resolves the YAML directory to whichever candidate (`src/adapters` or `dist/adapters`) actually contains `.yaml` files — works in dev, production builds, and global npm installs. `collectTsFiles` now auto-detects the entry-point extension (`.ts` in dev, `.js` in built mode) by probing the first site directory, and explicitly excludes `.d.ts`, `.d.ts.map`, `.js.map`, `.test.ts`, `.test.js`. Post-fix verification: `node dist/main.js list --format json | count` returns 134 sites / 711 commands, matching src mode.

5. **`unicli operate observe` ranker was blind to attributes.** `src/browser/snapshot.ts` emitted raw refs as `{ref, tag, text}` but `scoreCandidate` in `src/browser/observe.ts` awarded confidence for `role` and `aria-label` bonuses. Interactive elements with empty text (search boxes with only `aria-label`) were dropped at confidence 0 in `rankCandidates`. Tests passed because they constructed fake refs with attrs. **Fix:** refactored `getAttrs` to `collectAttrs` returning an object bag; each interactive ref now carries `{ref, tag, text, attrs}` so the ranker's role/aria-label logic actually fires in production.

6. **MCP expanded-mode dispatch broken for hyphenated command filenames.** `buildToolName` normalizes non-alphanumeric chars to `_`, but `handleExpandedTool` attempted to reverse the normalization by trying to split `unicli_<site>_<command>` at adapter-name prefixes and look up `adapter.commands[strippedSuffix]`. Command file names preserve hyphens (`skills-list.yaml` → `skills-list` key), so the reverse lookup never matched. Every v0.208 new command (`skills-list`, `capture-list`, `component-get`, `scene-export`, `project-run`, `sessions-search`, `skills-read`, `memory-read`, `eval-run`, `bench-list`, `bench-run`, `frame-export`, `wrap-observe`) was unreachable via MCP. **Fix:** `buildExpandedTools` now builds a `Map<toolName, {adapter, cmdName, cmd}>` at tool-list time and `handleExpandedTool` does a single O(1) lookup. Collision detection writes shadow warnings to stderr. Regression test asserts all 5 representative hyphenated names appear in the registered tool list.

**MAJORs fixed:**

7. **Symlink bypass** — `operate upload` and the exec pipeline step used string-based guards. `ln -s ~/.ssh/id_rsa /tmp/pretty.txt` defeated the check. **Fix:** new `matchSensitivePathRealpath` / `isSensitivePathRealpath` follow the symlink via `realpathSync` before matching, with a graceful fallback to string-only checking on broken symlinks. Both callers switched.

8. **Pattern coverage** — 9 new credential paths: `.pgpass`, `.netrc` (+ Windows `_netrc`), `.wgetrc`, `.my.cnf`, Azure CLI (`accessTokens.json`, `azureProfile.json`), GitHub CLI (`hosts.yml`), 1Password CLI (`~/.config/op/`), rclone (`rclone.conf`).

9. **Case-insensitive filesystem bypass (macOS/Windows)** — `/Users/x/.SSH/id_rsa` slipped past the case-sensitive regexes. **Fix:** new `normalizeForMatch()` lowercases the path on Darwin and Win32 before matching; POSIX paths stay case-sensitive.

10. **`eval run --all` absolute-path branch was broken.** `f.path.includes(\`/${target}/\`)`produced`//tmp/evals/smoke/`for absolute targets and never matched. **Fix:** two-branch logic: relative names match`f.relative`prefix, absolute paths match`f.path`prefix after`resolve()`.

11. **Version residue** in `AGENTS.md`, `docs/ROADMAP.md`, `contributing/COPY.md` — still said `0.207.1 — Vostok · Gagarin`. Updated.

12. **Missing `docs/adapters-catalog.json`** — the CHANGELOG promised a canonical machine-readable manifest but the generator was never run. Ran `tsx scripts/generate-catalog.ts` → 134 sites / 711 commands / 467KB JSON. Committed.

13. **Denial error shape mismatch** — `operate upload` emitted top-level `{error: "sensitive_path_denied", ...}` while the exec step wrapped the denial in `PipelineError.detail.config.denial` with `error = "exec blocked: sensitive_path_denied"`. Agents pattern-matching the canonical identifier had to handle two shapes. **Fix:** exec step now throws `PipelineError("sensitive_path_denied", ...)` so `toAgentJSON()` surfaces the same top-level identifier. Denial path + pattern inlined into `config.denial_path` / `config.denial_pattern`.

**Known limitations (not fixed in v0.208):**

- `detect:` YAML field is loader decoration — parsed but never executed. Adapters that rely on `detect` for registration gating do not currently self-disable on machines missing the binary. Moving this to a real `existsSync`/`statSync` probe is deferred to v0.209 because changing the loader semantics could introduce surprising adapter warnings in existing installs.

**Test-count delta:** 753 → 769 (26 → 40 sensitive-paths tests after adding case-insensitive, extended pattern, and symlink realpath suites; 5 → 7 MCP expanded tests after adding hyphen registration + dispatch coverage).

### Fixed

- **Node 20 compatibility**: replaced `node:fs` `globSync` (Node 22+) with manual glob implementation in repair engine
- **Shell injection prevention**: all `execSync` string interpolation in repair engine replaced with `execFileSync` + argument arrays; site/command names validated against `[a-z0-9._-]` pattern
- **Lower-direction metric**: verify failures now return `Infinity` (not `0`) for `direction: "lower"`, preventing broken commits from being kept as improvements
- **CDP flat session protocol**: `sessionId` now placed at top-level of JSON-RPC envelope (not inside `params`), fixing multi-tab recording
- **Interceptor data pipeline**: JS interceptor now captures HTTP method, status code, and request body — enables write candidate detection (POST/PUT/PATCH) in `unicli record`
- **Diagnostic crash prevention**: `parseDiagnostic` validates parsed JSON shape before cast, preventing TypeError on truncated payloads
- **DaemonPage network capture**: `startNetworkCapture` and `readNetworkCapture` methods added to DaemonPage, enabling CDP-first path in `unicli operate`

### Security

- **JWT full redaction**: entire JWT token replaced with `[JWT-REDACTED]` (previously only signature was redacted, leaking payload claims)
- **Upload path boundary**: `operate upload` now blocks paths outside workspace and home directory
- **Bracket-notation param redaction**: `token[]`, `auth[token]` etc. now matched by sensitive param filter
- **Body redaction depth limit**: recursive `redactBody` capped at 50 levels to prevent stack overflow

### Changed

- Failure classifier: 404 status only classified as `api_versioned` when URL contains API path pattern; generic 404 falls through to `unknown`
- `extractPerfectScore` cached from first successful verify output instead of re-running verify command each iteration
- `safeRevert` uses `git reset --hard HEAD~1` directly instead of creating noisy revert commits
- `isNoiseUrl` now correctly filters `facebook.com` domain (was dead code with `/tr` path in hostname check)
- `endpointSortKey` uses first array item's key count for wrapped responses like `{data: [...], total: N}`
- `explore.ts` uses real interceptor method/status data instead of fabricating `GET`/`200`
- Record and explore request capture arrays capped at 10,000 entries to prevent OOM
- Record polling has re-entrancy guard to prevent overlapping captures
- `extractMetric` resets `lastIndex` before exec for global/sticky regex safety
- `EvalJudge` type changed to discriminated union for type-safe value access
- `operate` string escaping uses `JSON.stringify` instead of hand-rolled replace chains
- `templatizeUrl` skips duplicate query parameters

## [0.207.0] — 2026-04-06 — Vostok · Gagarin

### Added

- **Self-Repair Loop**: `unicli repair <site> [cmd] --loop` — Karpathy-style autonomous adapter repair with failure-type-aware prompting (selector_miss, auth_expired, api_versioned, rate_limited). 8-phase loop: review → classify → modify (Claude Code) → commit → verify → guard → decide → log. Stuck hint escalation at 3/5/7/9/11 consecutive discards.
- **Eval Harness**: `unicli repair --eval <file>` — run evaluation suite with 4 judge criteria (contains, arrayMinLength, nonEmpty, matchesPattern). Outputs `SCORE=N/M` for metric extraction.
- **Endpoint Analysis Module**: `src/engine/analysis.ts` — shared boolean filters (`isNoiseUrl`, `isStaticResource`, `isUsefulEndpoint`) + transparent sort key (`endpointSortKey`) replacing opaque numeric scoring.
- **Record Multi-Tab**: CDP `Target.setDiscoverTargets` for cross-tab network capture, write candidate generation (POST/PUT/PATCH replay), URL parameter templatization (query → `${{ args.query }}`), request deduplication.
- **Explore Interactive Fuzzing**: `unicli explore --interactive` — click buttons, tabs, and anchors to trigger additional XHR endpoints. iframe re-fetch for empty-body GET JSON endpoints.
- **Operate CDP-First Network**: `operate open` pre-navigation capture, `operate network` prefers CDP `readNetworkCapture()` with JS interceptor fallback.

### Changed

- Endpoint scoring replaced: numeric `scoreEndpoint()` → boolean filter cascade (`isNoiseUrl` → `isStaticResource` → `isUsefulEndpoint`) + `endpointSortKey([itemCount, fieldCount, isApiPath, hasParams])`
- `endpoint-scorer.ts` rewritten as thin facade re-exporting from `analysis.ts`
- `synthesize.ts`: removed `--min-score` parameter, uses `isUsefulEndpoint()` instead

### Security

- Diagnostic redaction: JWT signature stripping (Cloudflare har-sanitizer pattern), sensitive header/URL param/body key redaction, 3-level size degradation (128KB/192KB/256KB cap)
- `redactUrl` handles relative URLs safely, `redactBody` has circular reference protection (WeakSet guard)
- `isNoiseUrl` matches against hostname only (not full URL string), preventing false positives from query parameters

### Fixed

- RegExp matching in analysis: noise domains checked against hostname, capability patterns against pathname only
- Record URL templatization preserves URL auth credentials and port numbers in dedup keys
- Record generates correct YAML args shape (mapping, not list) matching loader expectations
- Repair engine: correct metric comparison for `direction: 'lower'`, scope file re-resolution after Claude modifications

## [0.206.0] — 2026-04-05 — Vostok · Tereshkova

### Added

- **Adapter Generation Engine**: `unicli explore <url>` (API discovery), `unicli synthesize <site>` (YAML candidate generation), `unicli generate <url>` (one-shot explore+synthesize+select) — complete adapter generation pipeline with endpoint scoring algorithm
- **Browser Enhancements**: DOM settle detection via MutationObserver, network body capture with `startNetworkCapture`/`readNetworkCapture`, navigate with `waitUntil: networkidle`, click with x/y coordinates, interceptor regex patterns + text capture + multi-capture
- **Diagnostic Engine**: `RepairContext` module — full error context with DOM snapshot, network requests, console errors, and adapter source for AI agent self-repair. Triggered via `UNICLI_DIAGNOSTIC=1`
- **Plugin System v1**: Custom step registration (`registerStep`), manifest-based plugin loader (`unicli-plugin.json`), `unicli plugin install/uninstall/list/create/steps` commands
- **Agent-Native Primitives**: `assert` step (URL/selector/text/condition), `extract` step (structured browser data extraction with CSS selectors and type coercion), `retry` property on any step with exponential backoff
- **Smart Cookie Refresh**: Auto-detect 401/403 on cookie/header adapters → navigate Chrome → re-extract cookies via CDP
- **Infrastructure**: HTTP proxy support (`http_proxy`/`https_proxy`/`no_proxy` via undici), update auto-checker (24h cache, non-blocking), `unicli health [site]` (adapter health monitoring), `unicli agents generate` (AGENTS.md auto-generation)
- **New Sites (8)**: linkedin, jd, weixin, reuters, barchart, 1688, smzdm, sinablog — 26 new adapter commands
- **Operate Enhancements**: `operate upload <ref> <path>`, `operate hover <ref>`
- **Pipeline Steps**: assert, extract → 30 → 35 total (including retry as a cross-cutting property)

### Changed

- Pipeline engine: `SIBLING_KEYS` extended with `retry`, `backoff`; `executeStep` default case checks plugin custom step registry
- `fetchJson` and `stepFetchText` now use proxy agent when proxy env vars set
- `BrowserPage.goto()` uses DOM settle detection (MutationObserver) instead of simple setTimeout
- CLI startup: non-blocking update check + plugin loading before hook emission

## [0.205.0] — 2026-04-05 — Vostok · Bykovsky

### Added

- **Pipeline**: 7 new steps — `set`, `if/else`, `append`, `each`, `parallel`, `rate_limit`, plus `fallback` property (23 → 30 steps)
- **CDP Direct Mode**: Zero-extension browser auth — direct CDP connection, smart cookie extraction, auto-launch Chrome
- **Self-Repair**: Level 1 auto-fix (detect `selector_miss`, suggest alternative paths), Level 3 community-fix stub
- **Bridge CLIs**: 19 new bridges — vercel, supabase, wrangler, lark, dingtalk, hf, claude-code, codex-cli, opencode, aws, gcloud, az, doctl, netlify, railway, flyctl, pscale, neonctl, slack
- **DX**: `unicli init` (adapter scaffolding), `unicli dev` (hot-reload), `unicli adapter install/list` (marketplace)
- **Documentation**: VitePress site with DESIGN.md theme (Geist Mono + Terminal Green), 7 content pages
- **Browser**: `unicli browser cookies <domain>`, `--profile`, `--headless` options
- **Infrastructure**: npm publish config, rate limiter module, cookie extractor module

### Changed

- `acquirePage()` now prioritizes direct CDP over daemon (CDP → daemon → auto-launch)
- Cookie loading now transparently falls back to CDP extraction from Chrome
- Pipeline engine refactored: `executeStep()` helper, `getActionEntry()` + `SIBLING_KEYS`

### Security

- Path traversal guard on cookie `saveCookies()` and `loadCookies()`
- Port validation for `UNICLI_CDP_PORT` environment variable
- Recursion depth limit (max 10) for nested `if` and `each` steps

---

## [0.204.0] — Vostok · Nikolayev

### Engine Core (Sub-Project A)

- **6 new pipeline steps** — press, scroll, snapshot (DOM a11y tree), tap (Vue Store Bridge), download (HTTP+yt-dlp), websocket (OBS auth)
- **9 new BrowserPage methods** — insertText, nativeClick, nativeKeyPress, setFileInput, autoScroll, screenshot, networkRequests, snapshot, closeWindow
- **9 new pipe filters** — slugify, sanitize, ext, basename, keys, json, abs, round, ceil, floor, int, float, str, reverse, unique (total: 29)
- **VM sandbox migration** — replaced `new Function()` with hardened `vm.runInNewContext()` (null-prototype, frozen built-ins, 50ms timeout)
- **Dual interceptor** — fetch + XHR monkey-patching with WeakMap anti-detection stealth
- **Stealth upgrade** — 6 → 13 anti-detection patches (CDP cleanup, Error.stack filter, Performance API, iframe chrome consistency)

### Daemon + Browser Bridge (Sub-Project B)

- **Browser daemon** — standalone HTTP+WS server (port 19825), auto-spawn, 4h idle timeout, CSRF protection
- **DaemonPage** — IPage implementation over daemon HTTP (reuses Chrome login sessions)
- **Chrome extension** — Manifest V3 service worker, workspace isolation, command dispatch via chrome.debugger
- **`operate` command** — 16 interactive browser subcommands (open, state, click, type, keys, scroll, screenshot, eval, network, etc.)
- **`record` command** — capture network requests and auto-generate YAML adapters
- **Shell completion** — bash, zsh, fish tab completion
- **Daemon-first page acquisition** — yaml-runner tries daemon before direct CDP

### Electron App Control (Sub-Project C)

- **8 Electron apps** — Cursor, Codex, ChatGPT, Notion, Discord, ChatWise, Doubao, Antigravity
- **66 commands** via shared AI chat pattern + per-app specialization
- **App registry** — auto-discovery, CDP port assignment, user-extensible via ~/.unicli/apps.yaml

### New Web Sites (Sub-Project D)

- **+39 sites, +293 commands** — xiaohongshu (13), douyin (13), instagram (19), tiktok (15), facebook (10), amazon (8), boss (14), pixiv (6), hupu (7), xianyu (3), ones (11), notebooklm (15), doubao-web (9), lesswrong (15), gemini (+2 deep-research), yollomi (12), and 13 more P2 sites
- **Existing site gaps filled** — xueqiu fund-holdings, hupu mentions

### Desktop Expansion (Sub-Project E)

- **FreeCAD** 2→15 commands, **Blender** 4→13, **GIMP** 3→12
- **13 new apps** — OBS Studio (8, WebSocket), Zotero (8), Audacity/Sox (8), Krita (4), Kdenlive (3), Shotcut (3), MuseScore (5), CloudCompare (4), WireMock (5), AdGuardHome (5), Novita (3), Sketch (3), Slay the Spire II (6)

### Ecosystem (Sub-Project F)

- **Plugin system** — `unicli plugin install/uninstall/list/update` with GitHub/local sources
- **Lifecycle hooks** — onStartup, onBeforeExecute, onAfterExecute (globalThis singleton, sequential execution)

### Security

- Shell injection fix in plugin.ts (execFileSync replaces execSync)
- Path traversal prevention (plugin name validation + startsWith guard)
- JS injection prevention in operate commands (ref validation, JSON.stringify selectors)
- VM sandbox hardening (null-prototype, frozen built-ins, contextCodeGeneration restrictions)
- Tap step sanitization (identifier regex for store/action names)
- Fetch concurrency cap (mapConcurrent with limit=5)
- Network buffer cap (500 entries max)

### Metrics

| Metric          | v0.203.0 | v0.204.0 |
| --------------- | -------- | -------- |
| Sites           | 57       | 96       |
| Commands        | 289      | 582      |
| Pipeline steps  | 17       | 23       |
| Pipe filters    | 14       | 29       |
| Stealth patches | 6        | 13       |
| Tests           | ~137     | 2272     |

---

## [0.203.0] — Vostok · Leonov

### Engine — Browser Strategy

- **CDP client** — raw WebSocket Chrome DevTools Protocol, zero new runtime dependencies
- **BrowserPage** — goto, evaluate, click, type, press, cookies, scroll, waitForSelector
- **Chrome launcher** — auto-discover/start Chrome with `--remote-debugging-port`
- **Stealth injection** — anti-detection evasions (webdriver, plugins, permissions, toString)
- **6 new pipeline steps** — navigate, evaluate, click, type, wait, intercept
- **Strategy cascade** — auto-probe PUBLIC → COOKIE → HEADER
- CLI: `unicli browser start`, `unicli browser status`

### Web Adapters — Write Operations

- twitter: +15 write commands (post, like, reply, follow, unfollow, block, unblock, bookmark, unbookmark, delete, hide-reply, download, article, accept, reply-dm) — total 25 commands

### Web Adapters — Platform Expansions

- jike: +9 (create, like, repost, comment, search, notifications, post, topic, user)
- douban: +6 (subject, top250, marks, reviews, photos, download)
- weibo: +4 (feed, post, search, user)
- weread: +4 (book, highlights, notebooks, notes)
- zsxq: +3 (dynamics, search, topic)
- reddit: +7 (comment, read, save, saved, subscribe, upvote, upvoted)
- linux-do: +8 (categories, category, feed, search, tags, topic, user-posts, user-topics)
- xueqiu: +8 (stock, fund-snapshot, comments, feed, watchlist, search, hot-stock, earnings-date)
- medium: +2 (feed, user)
- producthunt: +3 (browse, posts, today)
- sinafinance: +2 (news, stock)
- 36kr: +3 (article, hot, search)
- v2ex: +2 (daily, user)
- substack: +2 (feed, publication)
- imdb: +2 (person, reviews)
- bloomberg: +1 (news), google: +2 (search, trends), bilibili: +1 (dynamic), zhihu: +1 (download), tieba: +1 (read)

### Infrastructure

- Manifest builder includes TS adapter metadata
- Browser module: cdp-client.ts, page.ts, launcher.ts, stealth.ts
- 119 unit tests (was 42)

**Stats: 57 sites, 289 commands (was 203 — +86 commands, +77 tests)**

---

## [0.202.0] — Vostok · Tereshkova

### Engine

- Cookie authentication strategy — reads cookies from `~/.unicli/cookies/<site>.json`
- Cookie injection in fetch/fetch_text pipeline steps (strategy=cookie)
- `write_temp` pipeline step for desktop adapters (temp file creation + auto-cleanup)
- `auth` CLI commands: `auth setup`, `auth check`, `auth list`
- Async TS adapter loading via dynamic import (loadTsAdapters)
- `PipelineOptions` for passing site/strategy context to pipeline engine

### Web Adapters — Chinese Platforms (3 new sites, 18 commands)

- bilibili: 12 commands (hot, ranking, feed, following, me, history, favorites, search, user-videos, comments, subtitle, download) — WBI signed + cookie auth
- weibo: 5 commands (hot, timeline, profile, comments, me) — cookie auth
- zhihu: 6 commands (hot, feed, question, search, me, notifications) — cookie auth

### Web Adapters — International (2 new sites, 15 commands)

- twitter: 10 commands (search, profile, timeline, bookmarks, trending, likes, thread, followers, following, notifications) — GraphQL + Bearer token + cookie auth
- youtube: 5 commands (search, video, channel, comments, transcript) — InnerTube API

### Web Adapters — P1/P2 Sites (8 new sites, 19 commands)

- douban: 3 commands (movie-hot, book-hot, search)
- xueqiu: 2 commands (hot, quote)
- linux-do: 2 commands (hot, latest) — Discourse API
- jike: 1 command (feed) — GraphQL
- zsxq: 2 commands (groups, topics) — cookie auth
- medium: 1 command (search)
- sinafinance: 2 commands (rolling-news, stock-rank)
- Expanded: v2ex (+2: notifications, me), weread (+1: shelf), tieba (+2: search, posts), reddit (+1: comments)

### Desktop Adapters (2 new apps, 5 commands)

- gimp: 3 commands (resize, convert, info) — Script-Fu via exec stdin
- freecad: 2 commands (export-stl, info) — Python via write_temp + exec

### Infrastructure

- `authCookies` field in adapter manifests for declaring required cookies
- `Strategy` re-exported from registry.ts for TS adapter pattern
- Manifest builder now includes TS adapter metadata (regex extraction from source)
- Fixed `sync:ref` script to use `--rebase` for divergent branches

**Stats: 57 sites, 203 commands (was 43 sites, 141 commands — +14 sites, +62 commands)**

---

## [0.201.0] — Vostok · Chaika II

### Engine

- POST JSON body template resolution in fetch steps
- Exec stdin pipe for desktop tools (mermaid, pandoc, jq)
- Exec environment variables and file output support
- HTML-to-Markdown conversion step via turndown
- Retry with exponential backoff for fetch steps (429/5xx)

### Web Adapters (12 new sites)

- tieba, 36kr, substack, producthunt
- google (suggest, news), imdb (search, title, top, trending)
- web/read (HTML to Markdown), ctrip, paperreview, spotify
- xiaoyuzhou expanded (episode, podcast-episodes)

### Bridge Adapters (4 new tools, 16 commands)

- gh (repo, issue, pr, release, run)
- docker (ps, images, run, build, logs)
- yt-dlp (download, info, search, extract-audio)
- jq (query, format)

### Desktop Adapters (10 new apps, 36 commands)

- ffmpeg expanded to 11 commands (probe, trim, gif, etc.)
- imagemagick (convert, resize, identify, composite, montage, compare)
- pandoc (universal document converter)
- libreoffice (headless convert, print)
- mermaid (diagram rendering via stdin)
- inkscape (SVG export, convert, optimize)
- blender expanded (info, convert, animation)
- musescore (export, convert)
- drawio (diagram export)
- comfyui (generate, status, history, nodes)

### Stats

- Sites/apps: 21 → 43 (+22)
- Commands: 74 → 141 (+67)
- Engine steps: 9 → 10 (html_to_md)
- Unit tests: 18 → 27

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
- Aerospace theme system: [contributing/COPY.md](./contributing/COPY.md)
- Full release label rules: [docs/reference/release.md](./docs/reference/release.md)
