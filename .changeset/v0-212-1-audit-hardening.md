---
"@zenalexa/unicli": patch
---

v0.212.1 — Vostok · Shatalov II (third-round audit hardening).

Security:

- SSRF guard rejects `file://`, `data:`, `gopher:`, loopback, RFC1918, IPv6 link/unique-local, AWS IMDS and GCP metadata on every pipeline fetch (`UNICLI_ALLOW_LOCAL=1` to override for local dev).
- AppleScript `escapeAs` now folds `\r\n` to spaces and strips NUL bytes so hostile app names can't smuggle statements past `osascript -e`.
- OAuth Bearer validation switched to a `crypto.timingSafeEqual` scan across resident tokens; token length capped at 128 chars.
- YAML loader uses `CORE_SCHEMA` (blocks `!!js/*` tags) and enforces a 256 KiB per-file size cap; billion-laughs anchor-expansion bounded by the cap.
- ACP `parseUnicliInvocation` truncates input to 64 KiB before the regex (ReDoS defence).
- `stepParallel` replaces unbounded `Promise.all` with `mapConcurrent(5)` so 100-branch pipelines don't exhaust sockets.

Contract:

- `schema-v2` hard gate validates the full parsed YAML (not a five-field projection) — `pipeline: "string"` now fails the gate.
- Quarantined commands exit-78 with a structured envelope and a `unicli repair` hint instead of silently running.
- Capability matrix aligns clipboard step names with handlers (`clipboard_read` / `clipboard_write`).
- `TransportBus` registers all seven transports so `bus.require` gives an honest answer.
- `AnthropicBackend` stubs carry explicit "v0.213-deferred" error text; `ANTHROPIC_CUA_TOOL_VERSION` env overrides the tool identifier for the Sonnet 4.6 rollout.
- `migrate-schema` roundtrip quarantines files whose rewritten YAML still fails `validateAdapterV2`.

Infra / Flywheel:

- `release.yml` tightens `id-token: write` to job scope; workflow-level permissions locked to `{}`.
- `npm run verify` expands to 12 gates (adds `conformance` + `verify:changesets`).
- `stats.json` adds `app_transport_count` (7 TransportAdapter implementations) distinct from the 3 MCP transports; `pipeline_step_count` now reads `CAPABILITY_MATRIX` (54 steps).
- `commit-msg` lefthook hook rejects internal-process terminology per the CLAUDE.md info-security rule.
- `.gitattributes` normalises line endings so Windows CI doesn't flag already-formatted files.
- Test count: 1114 → 1137 (+23 audit regression tests in `tests/unit/audit-hardening.test.ts`).

Docs:

- `docs/TRUSTED-PUBLISHER-SETUP.md` captures the one-time npmjs.com OIDC binding.
- `docs/ROADMAP.md` adds a v0.213 deferred scope section (Anthropic planner composition, napi-rs bindings for Windows UIA / Linux AT-SPI, full Last-Event-ID replay, OAuth workflow adapters).
