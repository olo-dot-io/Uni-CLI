# UNICLI Local Computer Use — Design Spec

**Date:** 2026-05-02
**Status:** Draft (awaiting maintainer approval)
**Author:** Claude (sonnet-aligned brainstorm) + ZenAlexa
**Target:** v0.219 Vostok
**Supersedes:** none — first first-class "operate any installed app" spec
**Adjacent:** `.claude/plans/sessions/2026-04-14-v212-rethink/round4/02-operate-anything-arch.md` (capability-matrix origin), `.claude/plans/sessions/2026-04-26-office-control/` (Office work that motivated this), v0.212+ transport-bus work

---

## 1. The thesis

> Real local computer use is **a structured tool call to the OS**, not a screenshot loop.

Codex shipped its "Computer Use" plugin on 2026-04-16 as **a bundled MCP server** (`com.openai.sky.CUAService`), gated by macOS Accessibility + Screen Recording perms. The community has repeatedly verified — issue #16666, #18404, #18522 — that the plugin's primitives are MCP tool calls, not raw `click(x,y)` over a screenshot. Anthropic's `computer_20251124` is the only major vendor still pushing the screenshot+coordinate paradigm; the community calls it "fragile" and is actively building AX-first replacements (Touchpoint, Windows-MCP, MacOS-MCP, lahfir/agent-desktop, native-devtools-mcp, desktop-pilot-mcp).

**UNICLI's position on this debate is already correct.** The transport architecture has seven lanes (HTTP, CDP-Browser, Subprocess, Desktop-AX, Desktop-UIA, Desktop-ATSPI, CUA), a 101-step pipeline surface, and AX/UIA/ATSPI as first-class peers to CUA — not fallbacks for it. What's missing is the **cross-platform completion** of the AX/UIA/ATSPI side and a **unified MCP surface** that lets any MCP-speaking agent (Claude Code, Codex CLI, Cursor, Gemini CLI) drop UNICLI in as their computer-use substrate.

This spec closes those two gaps and ships UNICLI as **the open-source `computer-use` MCP server** with broader coverage than any single vendor's offering.

---

## 2. What we have today (v0.218.1)

| Layer                 | State                   | Notes                                                                                                                                                                                                                                                                     |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport bus         | ✅ Real                 | `src/transport/bus.ts`, 7 transports, capability-matrix routing, structured `NoTransportForStepError` envelopes                                                                                                                                                           |
| HTTP transport        | ✅ Real                 | 398 LOC                                                                                                                                                                                                                                                                   |
| CDP-Browser transport | ✅ Real                 | 281 LOC, but only attaches to **launched** Chrome on `:9222`, no support for already-running Electron apps                                                                                                                                                                |
| Subprocess transport  | ✅ Real                 | 304 LOC                                                                                                                                                                                                                                                                   |
| Desktop-AX (macOS)    | ✅ Real                 | 700 LOC + 569 LOC Swift backend (`desktop-ax-swift.ts`) + background-click-swift (156 LOC). Covers `ax_focus`, `ax_menu_select`, `applescript`, `ax_snapshot`, `ax_focused_read`, `ax_set_value`, `ax_press`, `ax_background_click`, clipboard, launch_app, focus_window. |
| Desktop-UIA (Windows) | ❌ **Stub**             | 86 LOC. Returns `service_unavailable:69` for every call. Capability declared but no backend.                                                                                                                                                                              |
| Desktop-ATSPI (Linux) | ❌ **Stub**             | 85 LOC. Same shape as UIA. No backend.                                                                                                                                                                                                                                    |
| CUA transport         | 🟡 **Backend skeleton** | 866 LOC. `CuaBackend` interface + provider selection (`anthropic`/`trycua`/`opencua`/`scrapybara`/`mock`). Provider network paths are explicit stubs, mock works for tests.                                                                                               |
| MCP server            | ✅ Real                 | `src/mcp/`, stdio + HTTP + Streamable HTTP + OAuth-PKCE, with deprecated SSE requests routed through Streamable HTTP compatibility. `unicli mcp serve [--expanded]` exposes adapter commands as tools.                                                                    |
| `unicli operate`      | ✅ Real                 | 16 browser subcommands (open/state/click/type/keys/scroll/get/wait/eval/screenshot/find/observe/extract/network/upload/hover) — but **browser-only**. No `unicli operate <app>` for native apps.                                                                          |
| AX-tree text encoding | 🟡 Partial              | `snapshot` step returns DOM-AX or screenshot; no compact-text encoding with progressive disclosure (lahfir/agent-desktop's `[e1] role "name" wxh ...`).                                                                                                                   |

**Bottom line:** macOS is solid; Windows + Linux are honest stubs that exit 69 on every call. The MCP gateway exposes adapter commands but not a unified `computer-use` toolset. CUA backends are placeholder. CDP can't attach to existing Electron apps.

---

## 3. What "done" looks like (success criteria)

A maintainer on each of macOS / Windows / Linux can:

```bash
# 1. Start UNICLI as a computer-use MCP server
unicli mcp serve --transport http --profile compute

# 2. Any MCP client (Claude Code, Codex, Cursor, Gemini) sees these tools:
#    compute.apps           list running apps
#    compute.windows        list windows
#    compute.snapshot       AX-tree snapshot, compact text by default
#    compute.find           query by role/name/app, returns @e refs
#    compute.click          act on an @e ref (no x,y needed)
#    compute.type           type into an @e ref
#    compute.press          send a keyboard combo to a window
#    compute.scroll         scroll @e ref or screen region
#    compute.launch         launch an app by bundle-id / exe / .desktop
#    compute.shell          sandboxed shell (already there via subprocess)
#    compute.screenshot     pixel fallback when AX returns nothing
#    compute.cdp_attach     attach to a running Electron/Chrome
#    compute.evaluate       run JS in attached Electron renderer
#    compute.wait           wait for AX state change
#    compute.observe        rank candidate elements for a NL goal

# 3. Same `unicli` CLI works on the host
unicli compute apps
unicli compute snapshot --app Slack
unicli compute click @e7 --background      # no focus theft on darwin
unicli compute type @e3 "hello"

# 4. The agent never needs to think in pixels for any app whose
#    accessibility tree is exposed; CUA (screenshot+coord) is the
#    LAST resort, picked only when AX returns NotImplemented.
```

Each verb above:

- Returns a structured envelope on every error (`adapter_path`, `step`, `action`, `suggestion`, `minimum_capability`, `exit_code`)
- Supports `--json` output natively (JSON when piped, table when TTY)
- Has a Vitest unit test against a mocked transport
- Has at least one **adapter test** against a real running app (`Calculator.app` / `notepad.exe` / `gnome-calculator`)
- Is documented in `docs/operate/` with a "click without coordinates" recipe

**Quantitative bar:** on the maintainer's macOS box, `unicli compute snapshot --app Safari --format compact` returns ≤ 4 KB (≤ ~1 K tokens) of text and survives a re-snapshot 5 s later with stable refs (`@e7` continues to mean "the Send button").

---

## 4. Architecture decisions (DECISION blocks per rules/06)

### DECISION 1 — Element ID scheme

**OPTIONS**

1. `@e1`, `@e2` (lahfir/agent-desktop style) — opaque, allocated per snapshot.
2. `ax:<pid>:<aXAPath>` (Touchpoint style) — semantically dense, survives across snapshots.
3. Hybrid: short **session-scoped** alias (`@e7`) backed by long stable token (`ax:1234:AXWindow/AXButton[3]`), agent uses either form.

**RECOMMEND: 3 (Hybrid)**. Reason: agents see compact `@e7` in the snapshot for cheap reference; tooling and self-repair need the stable token to debug "this element disappeared between snapshots". Touchpoint and agent-desktop both wished they had this — Touchpoint's `atspi:1234:1:2.0` IDs are stable but unreadable in a screenful; agent-desktop's `@e7` are readable but break when the page refreshes. We get both.

**Stable-token format:** `<transport>:<scope>:<path>` where `transport ∈ {ax, uia, atspi, cdp}`, `scope` is pid/tab-id/window-id, `path` is the role-indexed accessibility path (e.g. `ax:1234:AXWindow[0]/AXButton[3]`). Refs are valid for one MCP session; the bus rebuilds the alias table on every `compute.snapshot`.

### DECISION 2 — Compact snapshot encoding

**OPTIONS**

1. JSON tree (current default in `ax_snapshot`).
2. One-element-per-line text: `@e7 button "Send" [4,12 60x24] {enabled,focusable} app=Slack`.
3. Both, controlled by `format=` param.

**RECOMMEND: 3, default to compact text.** Compact text is what every reference repo converged on (lahfir, agent-desktop, native-devtools, agent-ctrl, Touchpoint `format="flat"`). 78–96 % token reduction is a reproducible benchmark. JSON stays available because adapter authors and tests need it.

### DECISION 3 — Unified verb names

**OPTIONS**

1. Keep `cua_click`, `ax_press`, `uia_invoke` as separate steps (current matrix).
2. Promote a unified `compute_*` family that the bus dispatches to whichever transport can satisfy the step on this host.
3. Layer the unified family **on top** of the existing transport-specific verbs.

**RECOMMEND: 3.** Don't break v0.212's matrix — it's load-bearing for self-repair. Add a `compute_*` family (alias-style) where each verb consults a per-host preference list (`AX > CDP > UIA > CUA` on macOS, `UIA > CDP > CUA` on Windows, etc.) and picks the first transport that returns `ok`. If all return `service_unavailable`, surface the union of `minimum_capability` hints so the agent can install a backend.

This is the user's actual ask: they don't want to think about whether they're calling CUA or AX. They want `compute click @e7` and they want it to work.

### DECISION 4 — Windows UIA backend

**OPTIONS**

1. Pure Node.js via `node-ffi-napi` calling `UIAutomationCore.dll` directly.
2. Sidecar binary in C# (UIAutomationClient is a managed COM lib) packaged as `unicli-uia.exe`.
3. Sidecar binary in Rust via `uiautomation-rs` crate (active, used by mediar-ai/terminator).
4. Python sidecar via `uiautomation` PyPI lib.

**RECOMMEND: 3 (Rust sidecar via `uiautomation-rs`).** Reasons: (a) terminator is the highest-star Windows UIA stack right now, validated; (b) Rust gives us a tiny self-contained binary distributable via npm (`@zenalexa/unicli-uia` postinstall) — same packaging story as `desktop-ax-swift`; (c) `node-ffi-napi` is unmaintained on modern Node.js; (d) C# sidecar drags in .NET runtime; (e) Python sidecar drags in the Python install. Postinstall ships pre-compiled binaries for `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`.

### DECISION 5 — Linux AT-SPI backend

**OPTIONS**

1. Pure Node.js via `dbus-next` speaking AT-SPI's D-Bus interface directly.
2. Python sidecar via `pyatspi` (binds `gir1.2-atspi-2.0`).
3. Rust sidecar via `atspi` crate.
4. Vendor Touchpoint's AT-SPI bridge (MIT, used in production).

**RECOMMEND: 3 (Rust sidecar via `atspi` crate).** Same reasoning as DECISION 4 — symmetry with UIA, no host-language runtime dependency, single distributable. The Rust `atspi` crate is mature (8 K downloads/month, used by Helix LSP). Input on Wayland needs `ydotool`/`wtype` shell-out, on X11 `xdotool` — same pattern as Touchpoint.

### DECISION 6 — CDP for existing Electron apps

**OPTIONS**

1. Detect Electron apps and ship a per-app launcher that re-spawns them with `--remote-debugging-port`.
2. Trust the user to have launched the target Electron app with `--remote-debugging-port` already.
3. Use Electron's IPC (private, version-fragile).
4. Fall back to AX-only for Electron content (lossy — web content not in AX tree).

**RECOMMEND: 1 + 2 (additive).** New step `cdp_attach`: takes either `--port` (already-running app) or `--app-name` (launches a fresh copy with the debug port). Document the trade-off — re-launching loses the user's session. Touchpoint, native-devtools-mcp, and Cua Driver all do exactly this.

### DECISION 7 — MCP server profile

**OPTIONS**

1. Add `compute.*` tools to the existing `unicli mcp serve --expanded` flag (mixed with adapter tools).
2. New `--profile compute` flag that exposes only the computer-use surface (~15 tools).
3. New separate binary `unicli-compute-mcp` (matches Codex's split between `codex mcp-server` and `computer-use`).

**RECOMMEND: 2.** Same binary, focused tool list. Avoids the 855-tool token bomb of `--expanded` (real problem, see opencli-audit-2026-04-15 memory). Codex went with separate binaries for governance reasons we don't have. One binary, focused profile, lazy tool loading.

### DECISION 8 — Anti-screenshot stance

**OPTIONS**

1. Remove CUA transport entirely (purist).
2. Keep CUA, demote to last-resort fallback only.
3. Keep CUA at full priority, let user choose.

**RECOMMEND: 2.** Screenshots are the right answer when (a) the app has no AX tree (some Java AWT apps, custom canvas-based UIs), (b) the user explicitly opts in for visual verification (`compute.assert visual`), or (c) the agent is asked to grade something perceptual ("is this graph readable?"). For everything else, AX is faster, deterministic, cheaper, and survives DPI/locale changes. Default `compute_*` priority = `AX > CDP > UIA/ATSPI > CUA`. CUA stays in the matrix; the new `compute_*` family pushes it last. Existing `cua_*` steps stay unchanged for explicit users.

---

## 5. Components

### 5.1 New: `src/transport/adapters/desktop-uia-rs.ts`

TypeScript adapter that spawns the Rust sidecar `unicli-uia` (postinstalled binary), speaks JSON-over-stdio. Replaces the existing `desktop-uia.ts` stub on Windows. On non-Windows, registers as the same stub it is today.

Interface: each `action()` writes `{kind, params, ts}` JSONL, reads one response JSONL. Sidecar implements:

- `uia_apps`, `uia_windows`, `uia_snapshot` (returns flat-text element list with stable IDs)
- `uia_invoke`, `uia_set_value`, `uia_focus`, `uia_press`, `uia_scroll`
- `uia_screenshot` (Win32 BitBlt) for the `compute.screenshot` fallback
- All emit `service_unavailable` envelopes if the COM call fails — never throws.

Sidecar binary: 5 MB target, statically linked, distributed via `optionalDependencies: { "@zenalexa/unicli-uia-x64-win": "*" }` style — same pattern `esbuild` and `swc` use.

### 5.2 New: `src/transport/adapters/desktop-atspi-rs.ts`

Same shape as UIA. Sidecar `unicli-atspi` for Linux. Wayland input via `ydotool` shell-out (already a subprocess transport call), X11 via `xdotool`. Detects display server and picks; emits `minimum_capability: "desktop-atspi.wayland-input"` if neither tool is installed.

### 5.3 Extend: `src/transport/adapters/cdp-browser.ts`

Add `attach({port, target?})` method. Today it only knows how to launch a fresh Chrome. New flow:

1. `compute.cdp_attach --app Slack` — looks up Slack's bundle-id, sends SIGUSR1 if running with debug port, otherwise re-launches with `--remote-debugging-port=<random>` and persists the port in a session-scoped file (`~/.unicli/sessions/<pid>/cdp-targets.json`).
2. Once attached, normal `evaluate` / `click` / `intercept` work against the Electron renderer.

### 5.4 New: `src/engine/steps/compute.ts`

Unified `compute_*` step family. Each handler asks the bus for the _full preference list_ (not just first match), tries them in order, returns first `ok` envelope. On all-fail, merges `minimum_capability` hints into one envelope.

Steps:

- `compute_apps` — list running apps (transport: AX | UIA | ATSPI | subprocess `ps`)
- `compute_windows` — list windows
- `compute_snapshot` — accessibility-tree snapshot
- `compute_find` — query by role/name/app
- `compute_click` — invoke an element
- `compute_type` — set text on an element
- `compute_press` — keyboard combo on a window
- `compute_scroll` — scroll element or region
- `compute_launch` — launch app
- `compute_screenshot` — pixel snapshot (fallback)
- `compute_cdp_attach` — attach to Electron/Chrome
- `compute_evaluate` — JS in attached renderer
- `compute_wait` — wait for AX state change
- `compute_observe` — rank candidate elements for a NL goal
- `compute_assert` — visual or AX assertion

Capability matrix gets these 15 rows; existing `cua_*`, `ax_*`, `uia_*`, `atspi_*` rows stay unchanged.

### 5.5 New: `src/commands/compute.ts`

CLI surface: `unicli compute <verb> [args]`. Same verbs as 5.4. JSON-by-default when piped, table when TTY. Reuses `src/output/formatter.ts`.

### 5.6 New: `src/mcp/profiles/compute.ts`

Profile loader for `unicli mcp serve --profile compute`. Wraps the 15 `compute_*` steps as MCP tools with hand-tuned schemas (more useful than auto-generated). Includes a `prompts/` section with the Codex-style "computer-use system prompt" template the user can opt into.

### 5.7 New: `src/transport/snapshot-encoder.ts`

Pure function: `encodeSnapshot(tree, format) → string`.

- `format=compact` (default for LLMs): one element per line, `@eN role "name" wxh @x,y {states} app=...`
- `format=tree` (human debugging): indented, same fields
- `format=json` (programmatic): full element objects

Element-ref allocator: per-snapshot monotonic counter that maps `@eN ↔ stable-token`, persisted in the bus context for the next `compute_click` to dereference.

### 5.8 Extend: `src/engine/repair/`

Self-repair loop already understands `minimum_capability: "desktop-uia.uia_invoke"`. Extend to recognize the new keys:

- `desktop-uia.binary_missing` → suggest `npm install @zenalexa/unicli-uia` or a postinstall hint
- `desktop-atspi.wayland-input` → suggest `apt install ydotool`
- `desktop-ax.permission` (macOS) → print a deeplink to System Settings → Privacy & Security → Accessibility

### 5.9 Out of scope (explicit non-goals)

- We do NOT ship a VLM (UI-TARS, Fara-7B, OpenCUA). The `cua` backends stay pluggable for users who want screenshot+VLM as a fallback; we just don't make it the primary path.
- We do NOT build a sandbox VM. trycua/cua and e2b-dev/desktop already do this; we integrate as a `cua_backend` user, not a competitor.
- We do NOT replace `unicli operate` (browser-only). `compute_*` is the new umbrella; `operate` continues to work as a browser-focused alias.
- We do NOT ship the optional Codex-style "computer-use" plugin install UX (System-Settings deeplinks etc.) until Phase 5 — bare CLI/MCP surface ships first.

---

## 6. Data flow (one example)

```
agent: "click the Send button in Slack"
  │
  ▼
MCP tool call: compute.find {role: "button", name: "Send", app: "Slack"}
  │
  ▼
bus.require("compute_find", platform="darwin")
  │
  ▼
[on darwin]  desktop-ax  → finds AXButton, returns {refs: [{id:"@e7", token:"ax:1234:AXWindow/AXButton[3]"}]}
[on win32]   desktop-uia → spawns unicli-uia sidecar over stdio, sidecar walks UIA tree, returns same shape
[on linux]   desktop-atspi → spawns unicli-atspi sidecar, walks AT-SPI registry, returns same shape
  │
  ▼
agent receives @e7
  │
  ▼
MCP tool call: compute.click {ref: "@e7"}
  │
  ▼
bus.require("compute_click")  → tries [AX, CDP, UIA/ATSPI, CUA]
  │
  ▼
desktop-ax → resolves @e7 → ax:1234:AXWindow/AXButton[3] → AXPress (background, no focus theft)
  │
  ▼
ok envelope, message sent
```

If AX fails (rare, e.g. inside a custom WebGL canvas), the bus falls through to CDP (works for Slack — Electron). If CDP also fails (no debug port and user declined re-launch), falls through to CUA (screenshot + click coords). The agent sees one tool call; the bus does the cascade.

---

## 7. Self-repair contract

Every error envelope carries:

- `transport`: which transport tried and failed
- `step`: pipeline step ordinal (0 for ad-hoc MCP)
- `action`: verb name
- `reason`: human-readable
- `suggestion`: one-line fix (e.g. "grant Accessibility to Terminal in System Settings")
- `minimum_capability`: machine-readable `<transport>.<verb>` or `<transport>.<missing-thing>`
- `exit_code`: sysexits.h value

**New** `minimum_capability` keys:

- `desktop-uia.binary_missing` — sidecar not installed
- `desktop-uia.permission` — UI Access manifest missing
- `desktop-atspi.binary_missing`
- `desktop-atspi.wayland-input` — ydotool/wtype not in PATH
- `desktop-atspi.dbus-blocked` — daemon firewalled
- `desktop-ax.permission` — Accessibility not granted
- `desktop-ax.screen-recording` — Screen Recording not granted (only for the screenshot fallback)
- `cdp-browser.attach-failed` — debug port not reachable
- `cdp-browser.electron-app-running-without-debug-port` — agent must `compute.launch --debug-port` to get a fresh process
- `compute_*.no-transport-available` — emitted by the unified family when every fallback returns `service_unavailable`

Agents that read these can either (a) drop down a transport, (b) shell out to install the sidecar, (c) ask the user to grant a perm — without paging us.

---

## 8. Phased roll-out

Each phase is a single-PR-sized chunk. **Each phase ships independently** and leaves the system in a working state.

### Phase 1 — Foundation (≈3 days)

- `src/transport/snapshot-encoder.ts` with the three formats and unit tests
- Element-ref allocator with stable-token mapping; bus context holds the alias table
- Extend `desktop-ax` `ax_snapshot` to use the new encoder
- Doc: `docs/operate/snapshot-formats.md`

### Phase 2 — Unified `compute_*` family (≈4 days)

- `src/engine/steps/compute.ts` — 15 handlers
- Capability-matrix rows
- `src/commands/compute.ts` — CLI surface
- Vitest tests with mocked transports
- Doc: `docs/operate/compute.md`

### Phase 3 — Windows UIA real backend (≈1 week)

- New crate `crates/unicli-uia/` (Rust, `uiautomation-rs`)
- npm postinstall package `@zenalexa/unicli-uia-x64-win` (and arm64)
- TS adapter `desktop-uia-rs.ts` replacing the stub on win32
- Adapter tests against `notepad.exe` and `calc.exe` (CI on `windows-latest`)
- Doc: `docs/operate/windows.md`

### Phase 4 — Linux AT-SPI real backend (≈1 week)

- New crate `crates/unicli-atspi/` (Rust, `atspi` crate)
- npm postinstall package `@zenalexa/unicli-atspi-x64-linux` (and arm64)
- TS adapter `desktop-atspi-rs.ts`
- Adapter tests against `gnome-calculator` (Wayland) and `xterm` (X11)
- Doc: `docs/operate/linux.md`

### Phase 5 — CDP-Electron-attach (≈3 days)

- Extend `cdp-browser.ts` with `attach()` method
- New step `compute_cdp_attach`
- Bundle-id → debug-port lookup table for top-20 Electron apps (Slack, Discord, VS Code, Cursor, Notion, Linear, Figma, …)
- Adapter test against locally-installed VS Code
- Doc: `docs/operate/electron.md`

### Phase 6 — MCP profile (≈2 days)

- `src/mcp/profiles/compute.ts` with hand-tuned tool schemas
- `unicli mcp serve --profile compute` flag
- Sample configs for Claude Desktop, Cursor, Codex, Gemini CLI in `docs/mcp/clients/`
- Conformance test: run UNICLI as MCP server, probe with `mcp-spec-validator`

### Phase 7 — Self-repair surface polish (≈2 days)

- Add the new `minimum_capability` keys to `src/engine/repair/`
- Doctor command: `unicli doctor compute` checks every transport on this host and prints what's missing
- Doc: `docs/operate/troubleshooting.md`

### Phase 8 — Background/non-focus-stealing audit (≈3 days)

- Review every `compute_*` verb on every transport; verify default does NOT steal cursor / activate window
- Add `--focus` opt-in flag where the user explicitly wants focus
- macOS: leverage `desktop-ax-background-click-swift.ts` (already there)
- Windows: use `SendInput` with `KEYEVENTF_SCANCODE` against background HWND via `PostMessage` where supported
- Linux: AT-SPI activate without raise; `ydotool` runs without focus by default

**Total:** ≈4–5 weeks of focused work. Phases 3 + 4 are the long poles; everything else is well-scoped.

---

## 9. Risks and mitigations

| Risk                                                   | Likelihood          | Mitigation                                                                                                                                                                                |
| ------------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UIA sidecar postinstall fails on Windows ARM64         | Medium              | Pre-build all 4 (x64/arm64 × win/linux) in CI; fall back to download-on-first-use; mark transport `service_unavailable` with explicit suggestion                                          |
| Wayland input still fragile in 2026                    | High                | Document the `ydotool`/`wtype` requirement loudly; add `compute.permission_check` that surfaces this before any agent action                                                              |
| AX/UIA refs become stale between snapshots             | Medium              | Stable-token format encodes the role-indexed path so the next snapshot can re-derive `@e7`; tests cover refresh churn                                                                     |
| CUA backends never get used (we demoted them)          | Low                 | Keep `cua_*` family unchanged so explicit users still get them; `compute.assert visual` route surfaces them again                                                                         |
| MCP `--profile compute` confuses users vs `--expanded` | Low                 | Doc clearly; emit a one-line note on `mcp serve` saying "default profile = `compute`; use `--expanded` for full adapter catalog"                                                          |
| Codex ships an SDK that overlaps and we look redundant | Medium              | We ship cross-platform; Codex Computer Use is macOS-only as of 2026-04-16. Lead with that. Also: the open spec is a moat — `agent-ctrl` and CUP are converging on it, and we should join. |
| AX permission UX is brutal on macOS                    | High (already true) | Doctor command + deeplink + a one-page explainer in docs. Same problem MacOS-MCP, Touchpoint, and Codex Computer Use all hit.                                                             |

---

## 10. What this is NOT

- **Not** a replacement for browser automation. `unicli operate` (CDP-only browser) stays as the fast path for web. `compute_*` adds desktop + Electron coverage.
- **Not** a vision model. We don't ship a VLM. CUA backends remain pluggable for users who want them.
- **Not** sandboxed execution. trycua/cua and e2b-dev/desktop are the right answer there; we read from them as a `cua_backend`.
- **Not** a Codex clone. Codex's app-server JSON-RPC is internal; we expose MCP only.

---

## 11. Open questions for maintainer

1. **Do we ship the Rust sidecars in-tree** (monorepo with `crates/`) **or as separate repos** (cleaner CI, slower dev loop)? Current CLAUDE.md's release SOP assumes single repo. **Recommend:** in-tree under `crates/`, mirroring how `desktop-ax-swift.ts` already lives next to its TypeScript wrapper.
2. **Codename:** `compute` or `operate-anything` for the user-facing verb? Current `unicli operate` is browser-only. **Recommend:** `compute` for the new family, keep `operate` as a hidden alias that delegates to `compute` for the browser verbs.
3. **MCP profile name:** `compute` matches the verb. Codex's tool is `computer-use`. **Recommend:** profile name `compute`, MCP tool prefix `compute.*` — readable, parses cleanly, doesn't collide with Codex.
4. **Launch order:** ship Phase 1+2 (text-only foundation, no new backends) as v0.218 first to get the encoding + `compute_*` matrix shipping; Phases 3–8 land as v0.219+. **Recommend:** yes — ship infrastructure first so adapter authors can write against the unified API while Windows/Linux backends bake.

---

## 12. References

**OpenAI Codex Computer Use (verified 2026-05-02):**

- https://developers.openai.com/codex/app/computer-use — official docs, MCP-based, AX + Screen Recording perms
- https://github.com/openai/codex/issues/16666 — community AX-vs-screenshot debate, OpenAI maintainer reply
- https://github.com/openai/codex/issues/18404 — confirms Computer Use is bundled MCP server
- https://github.com/openai/codex/issues/18522 — MCP elicitation for approvals
- https://www.engineering.fyi/article/unlocking-the-codex-harness-how-we-built-the-app-server — Codex's app-server is JSON-RPC, MCP for external tools

**Reference implementations (all 2026-04 push dates):**

- https://github.com/Touchpoint-Labs/Touchpoint — cleanest cross-platform AX-only architecture, MIT
- https://github.com/lahfir/agent-desktop — `@e1` ref pattern, progressive AX traversal
- https://github.com/CursorTouch/Windows-MCP — reference Windows UIA MCP server
- https://github.com/CursorTouch/MacOS-MCP — reference macOS AX MCP server
- https://github.com/sh3ll3x3c/native-devtools-mcp — three-mode (AX / CDP / visual) dispatch
- https://github.com/VersoXBT/desktop-pilot-mcp — Swift-only, no cursor movement
- https://github.com/mediar-ai/terminator — Rust + UIA + DOM + UIAutomation hybrid (validates DECISION 4)
- https://github.com/computeruseprotocol/computeruseprotocol → moved to `k4cper-g/agent-ctrl` — open AX-tree schema candidate

**Internal anchors:**

- v0.212 round-4 capability matrix: `.claude/plans/sessions/2026-04-14-v212-rethink/round4/02-operate-anything-arch.md`
- Office-control work that exposed gaps: `.claude/plans/sessions/2026-04-26-office-control/`
- Memory: `lotl-pet-system`, `v213-execution-2026-04-15` (parallel context)

---

## 13. Sign-off

This spec is ready for maintainer review. After approval, the next step is a writing-plans pass (rule 02) that breaks each Phase into per-PR task plans under `.claude/plans/sessions/2026-05-02-compute/`.

I have NOT written any code. The repo is unchanged except for this file. Please mark up sections you want changed; the spec self-review pass already swept for placeholders, contradictions, and ambiguity.
