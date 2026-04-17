---
"@zenalexa/unicli": minor
---

Agent-Native v2 envelope + `-f md` output become first-class (Gagarin iteration).

Breaking (for anyone parsing beta.1 `--json` output):

- `--json` / `--yaml` now emit `{ok, schema_version: "2", command, meta, data, error, content?}` v2 envelope (schema_version: "2" string literal, not numeric). Pre-P-B flat arrays replaced. `csv` and `compact` formats unchanged.
- Non-TTY default format is now `md`. Use `-f json` or `UNICLI_OUTPUT=json` to restore JSON for scripts. `table` format deprecated (falls back to md + stderr warning).
- Envelope `command` field uses `<area>.<action>` naming (core.list, ext.install, dev.watch, and `<site>.<command>` for adapter calls).

Added:

- Agent-UA auto-detection switches output to md when any of CLAUDE_CODE, CODEX_CLI, OPENCODE, HERMES_AGENT, UNICLI_AGENT is set.
- `UNICLI_OUTPUT` / `OUTPUT` env override (json|yaml|md|csv|compact); `--format` / `-f` flag has highest priority.
- 20 MD golden fixtures covering 10 flagship adapter pairs (twitter.mentions, reddit.frontpage, bilibili.dynamic, hackernews.top, github-trending.daily, arxiv.search, xiaohongshu.feed, zhihu.answers, douban.book-hot, notion.search); iterating snapshot test with UPDATE_FIXTURES=1 regen path.
- `## Output Contract` section in AGENTS.md — envelope shape, selection order, error code enum, agent-UA env vars.
- `src/commands/dispatch.ts` (299 LOC) extracted from `src/cli.ts` (781 → 490); quarantine gate now emits a v2 envelope instead of bespoke JSON.

Changed:

- `format(data, columns, fmt, ctx)` requires an `AgentContext` — TS-enforced at every call site.
- 7 call sites migrated: core.list, adapter dispatch, ext.list, core.usage, dev.watch, core.search, core.health.
- `detectFormat()` order: explicit flag > `UNICLI_OUTPUT` / `OUTPUT` env > non-TTY > agent UA > default (md).

Fixed:

- No more envelope bypass on empty results, chalk-styled rows, health.json, core.usage --json, or adapter-dispatch catch paths.
- `migrate-schema.ts` capability map now covers `wait`, `cua_ask`, `cua_assert` steps; affected adapters' `capabilities:` arrays complete on re-migration.
- `--json` deprecation window moved to v0.214 (strings no longer self-contradicting on every invocation).
- `dev.ts --format` default: `table` → `md`; description widened to `table|json|yaml|csv|md|compact`.
- AGENTS.md version footer + top-of-file "JSON when piped" prose realigned to MD-default.

Out of scope (still on runway for v0.213.0 GA or v0.214):

- Workflow adapters (gmail/gcal/drive/spotify/apple-notes/imessage), Chrome extension full pipeline, `generate --verify` closed loop, CUA backend drivers, desktop-ax AX steps, dual JS adapter format, `unicli inbox` / `shop`, OpenCLI parity harness.
