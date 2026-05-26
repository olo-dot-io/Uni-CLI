# Compute

`unicli compute` is the local computer-control surface. It routes each request
through the fastest available structured transport first, then falls back to
broader transports when needed.

Transport order is selected per verb and host platform:

- macOS: Accessibility first for app control, CDP for browser/Electron renderers,
  then visual fallback.
- Windows: UIA first once the sidecar is present, CDP next where available, then
  visual fallback.
- Linux: AT-SPI first once the sidecar is present, CDP next where available,
  then visual fallback.

## Snapshot, Find, Click

```bash
unicli compute snapshot --app Calculator --format compact
unicli compute find --role button --name 5
unicli compute find --role input --text 8 --first
unicli compute click @e7
```

Snapshots return compact element refs such as `@e7`. The latest ref bucket is
kept by the transport bus so follow-up actions can dereference aliases without
coordinates. When a structured transport reports bounds, the refs preserve
screen-relative coordinates and `screenIndex` so follow-up actions can target
the same monitor in multi-display setups.
When a snapshot node includes a visible/current value, compact output and stored
refs preserve it, and `compute find --text <text>` can match that value. This is
useful for calculator displays, address fields, editors, and status labels
whose value is not part of the accessible name.

## Capture Context

`compute capture` combines a structured snapshot and screenshot evidence into
one reusable context packet for agents. Use it when the next step needs both
addressable refs and pixels, or when you want to hand a compact state packet to
another tool without making it re-read the app.

```bash
unicli compute capture --app Calculator --format compact
unicli compute capture --app Figma --include snapshot,screenshot --screenshot-path /tmp/figma.png
unicli compute capture --app Calculator --save-reference
unicli compute capture --app Calculator --copy-reference
unicli compute capture --app Calculator --reference-root /tmp/captures --save-reference
```

The command reuses the same `compute snapshot` and `compute screenshot` cascade
paths, so it inherits the platform transport order, ref persistence, and
structured error envelopes. The packet succeeds when at least one requested part
is captured and records per-part errors when the other part is unavailable.
When screenshot bytes are available, the screenshot part includes `image`
metadata with byte count, SHA-256, dimensions, and an image-pixel coordinate
space whose origin is the top-left corner. Packets also include a replayable
trajectory listing the `compute_snapshot` and `compute_screenshot` actions,
params, ordering, and per-step success state that produced the packet.
The packet also includes `visual_timeline`, a protocol-level replay hint for
frontends that want to show agent motion without moving the host cursor. It is
ordered by `index` and `at_ms`, names the cursor state (`observe`, `move`,
`press`, `wait`, `success`, or `error`), preserves target refs and coordinate
spaces when available, and carries visual affordances such as a click ripple or
progress orbit. This follows the same split used by GUI-agent UIs such as
[UI-TARS ScreenshotDisplay](https://github.com/bytedance/UI-TARS-desktop/blob/e9f3387288da4af2ad99972da2ac916cdabce093/multimodal/tarko/ui/src/components/gui-agent/ScreenshotDisplay.tsx):
actions remain structured evidence, while the UI renders a non-invasive cursor
overlay on top of screenshots. Browser-use Terminal's protocol similarly keeps
session events and artifacts separate from the TUI renderer; Uni-CLI keeps this
visual replay in the compute packet so MCP clients, docs, and future desktops
consume one deterministic contract.

<ComputeCursorDemo />

## System Overlay HUD

The screenshot replay above is a frontend replay inside the docs page. It does
not draw over arbitrary desktop apps. For a real system-level virtual pointer,
opt in to the native HUD on mutating compute actions:

```bash
unicli doctor compute --json
unicli compute snapshot --app Calculator --format compact
unicli -f json compute click @e13 --overlay
```

`doctor compute --json` reports the native overlay checks for each desktop
platform: `overlay/macos-appkit`, `overlay/windows-win32`, and
`overlay/linux-gtk`. Non-host providers are reported as `skip` rather than
silently disappearing. On macOS, the check parses the generated Swift/AppKit
daemon source and the normal doctor checks still verify the Accessibility and
Screen Recording permissions. In other words, macOS arbitrary visible app
windows require both Accessibility and Screen Recording. On
Windows, the check parses the generated PowerShell/WinForms daemon and verifies
that Windows Forms can load in the desktop session. On Linux, the check compiles
the generated Python daemon and verifies the GTK/PyGObject/Cairo imports.

Every provider implements the same JSONL HUD protocol: report `ready`, accept a
`visual_action.pointer_plan` render request, draw a full-screen click-through
pointer/halo/trail, report `arrived`, then let Uni-CLI dispatch the real compute
action through the normal transport cascade. This keeps the rendered pointer
target and the actual action target on the same enriched request.

Successful JSON output includes both legacy `visual_timeline` and the richer
`visual_action` record:

- `visual_action.target`: resolved ref or coordinate target in screen pixels.
- `visual_action.pointer_plan`: sampled path used by the HUD and docs replay.
- `visual_action.overlay`: native HUD provider status such as
  `macos-appkit/arrived`.
- `visual_action.dispatch`: transport, status, and target used for the real
  click/type/scroll action.
- `visual_action.post_capture`: optional screenshot evidence captured after the
  action when overlay mode is enabled.

This is intentionally not implemented as a Chrome extension. A Chrome extension
can draw over Chrome pages only; it cannot cover arbitrary macOS apps such as
Calculator, Figma, Xcode, or the Codex desktop window, and it cannot cover
native Windows/Linux apps either. The system HUD is native-provider based and
opt-in with `--overlay`: macOS uses AppKit, Windows uses a Win32/Windows Forms
daemon, and Linux uses a GTK/Cairo daemon with an empty input shape.

`--save-reference` writes a local artifact directory under
`~/.unicli/app-shots` and returns `[app-shots ...]` markup with image, content,
and metadata file paths. Use `--reference-root` to choose a different artifact
root for CI, handoff directories, or isolated experiments. `--copy-reference`
saves the same artifact and copies the markup to the host clipboard. The
content and metadata files are optimized for agent handoff: element refs remain,
but geometry strings and raw accessibility object pointers are stripped from
the text copy so the packet does not encourage coordinate-string matching.

The compute family is also part of the normal command discovery surface. Agents
can find it without knowing the exact subcommand:

```bash
unicli search "Appshots"
unicli search "local computer use capture"
unicli list --site compute
unicli describe compute capture
```

## Commands

| Command                                           | Purpose                                            |
| ------------------------------------------------- | -------------------------------------------------- |
| `compute apps`                                    | List running apps                                  |
| `compute windows --app <name>`                    | List windows                                       |
| `compute snapshot --app <name> --format compact`  | Capture a compact/tree/json accessibility snapshot |
| `compute capture --app <name>`                    | Capture snapshot refs and screenshot evidence      |
| `compute capture --copy-reference`                | Save and copy `[app-shots ...]` handoff markup     |
| `compute find --role <role> --name/--text <text>` | Find matching refs by label or value               |
| `compute click <ref>`                             | Click a ref                                        |
| `compute type <ref> <text>`                       | Set or type text                                   |
| `compute press <combo>`                           | Send a key combo                                   |
| `compute scroll <ref>`                            | Scroll a ref                                       |
| `compute launch <app>`                            | Launch an app                                      |
| `compute screenshot [path]`                       | Capture a screenshot                               |
| `compute attach --app <name>`                     | Attach CDP to a renderer                           |
| `compute attach --app <name> --confirm-relaunch`  | Allow risky app relaunch for CDP attach            |
| `compute eval <js>`                               | Evaluate JS in an attached renderer                |
| `compute wait --ref <ref>`                        | Wait for an element/text/state                     |
| `compute observe <goal>`                          | Rank refs for a natural-language goal              |
| `compute assert --text <text>`                    | Assert visible state                               |

## Output

All commands use the normal Uni-CLI v2 envelope. Success writes to stdout; a
failed cascade writes a structured error to stderr with the failing transport
details and exits with the transport error code.

`compute launch <app>` is routed through the subprocess transport first. It uses
the host launcher command for the current OS: `open -a` on macOS,
`Start-Process` through PowerShell on Windows, and `gtk-launch` on Linux.
When `--debug-port <port>` is supplied, Uni-CLI passes
`--remote-debugging-port=<port>` to the launched app for Electron CDP attach
workflows. The native desktop fallbacks honor the same debug-port argument when
the subprocess route is not available.
The direct low-level UIA and AT-SPI sidecar `launch_app` actions are also
implemented for sidecar callers: UIA uses PowerShell `Start-Process`, and
AT-SPI uses `gtk-launch`. Cross-OS live launch smoke evidence is still pending.

```bash
unicli compute snapshot --app TextEdit -f json
```

Failures include a `minimum_capability` key and may include a structured
`remedy` with a command or deeplink. See
[Compute Troubleshooting](troubleshooting.md) for the remedy catalog.

## Live Smoke

Maintainers can generate the cross-OS smoke plan without touching the host:

```bash
npm run compute:smoke -- --json --platform linux
```

To execute it on a real target machine, run:

```bash
npm run compute:smoke -- --run --include-mutating --output smoke-report.json
npm run compute:smoke -- --run --include-mutating --overlay --output overlay-smoke-report.json
```

The smoke harness uses a temporary ref store, checks `doctor compute`, lists
apps, launches the platform calculator app, captures a compact snapshot, finds a
button ref, waits for it, asserts it is enabled, clicks it with `--background`,
exercises type/scroll routing, and captures a screenshot. Omit
`--include-mutating` to skip launch/click/type/scroll steps while still
collecting read-only evidence. For richer text-field or scroll-container
coverage, override the app and target label with `--app` and `--button`.
When `--run` is used, the harness records every step's `ok`, `exit_code`,
duration, stdout, and stderr instead of aborting at the first failed command, so
cross-OS smoke artifacts keep enough evidence for repair. `--output` writes the
same schema-versioned report to disk for CI artifacts or manual release
evidence. Add `--overlay` to make the mutating click/type/scroll steps use the
native system HUD provider selected by the host platform.

## Provider Discovery

`doctor compute --providers` adds non-blocking discovery checks for optional
local computer-use provider commands and configured visual-model backends. These
checks are reported as `ok`, `warn`, or `skip` and do not make the base doctor
fail. Set `UNICLI_COMPUTE_PROVIDER_COMMAND` or the platform-specific
`UNICLI_<PLATFORM>_COMPUTE_PROVIDER_COMMAND` environment variable when you want
Uni-CLI to probe an installed provider.

```bash
unicli doctor compute --providers
```

## Focus Stealing

Actuating commands prefer background mode: `compute click`, `compute type`,
`compute press`, and `compute scroll` pass `focus: false` to structured
transports unless `--focus` is set. The visual last-resort fallback is treated
as focus-taking because it may move the cursor or active surface.

On macOS, desktop-ax now has a bounded background input session for cases where
plain AX actions are not enough. The transport still tries semantic AX first:
`AXPress`, `AXValue`, and AX scroll actions run without activating the app. If a
click or text action has a target app plus ref/window coordinates and the
semantic action fails, desktop-ax can prime that non-frontmost window, suppress
the previous app's focus-deactivation event, and post pid/window-addressed
`CGEvent` mouse or keyboard events. `compute press --app <name> <combo>` uses
the same window-addressed path before visual fallback.

The background path is scoped to a running app and an on-screen window. It does
not claim support for minimized, hidden, disabled, or security-hardened windows,
and failures are returned as structured envelopes instead of silently
foregrounding the target.

See [Compute Focus Behavior](focus-behavior.md) for the transport matrix and
source links.

Windows UIA uses native top-level inventory and live descendant traversal where
available. Refs emitted from Windows snapshot/find can target `compute type`,
`compute scroll`, `compute screenshot`, `compute wait`, and `compute assert`.
Wait/assert use role/name/title/app/pid filters and descendant text/value/state
checks when the UIA tree exposes them. `compute observe` ranks top-level and
descendant refs by goal/title/name token overlap and marks scrollable
descendants with `action: "scroll"` and slider/spinner/range descendants with
`action: "set_value"`. Descendant invoke, value, focus, and scroll actions
prefer native UIA patterns before bounded fallback paths; invoke also tries
toggle and selection item patterns for controls such as checkboxes, radio
buttons, and selectable list rows, while numeric set-value inputs can use
RangeValuePattern for sliders and spinners.
The UIA sidecar also supports direct app launch through PowerShell
`Start-Process`; the public compute launch cascade still tries subprocess first.

Linux AT-SPI uses `wmctrl -lG -p` where available and falls back to AT-SPI-only
top-level registry roots when `wmctrl` is missing or empty. Refs emitted from
Linux snapshot/find can target `compute click`, `compute type`, `compute
scroll`, `compute screenshot`, `compute wait`, `compute observe`, and
`compute assert`. Descendant click/type/focus prefer native AT-SPI
Action/Value/EditableText/Component proxies before bounded display-server
helpers; descendant scroll prefers native `Component.scroll_to(...)` before
helper fallback. `compute observe` marks scrollable descendants with
`action: "scroll"` and slider/spin-button/range descendants with
`action: "set_value"`. Descendant screenshots capture the element rectangle
when bounds are known. Top-level X11 screenshots use `import -window <id>` when
a real window id exists, and Wayland/top-level bounds use `grim -g` when bounds
are known.
The AT-SPI sidecar also supports direct app launch through `gtk-launch`; the
public compute launch cascade still tries subprocess first.

## CDP Attach

`compute attach --app <name>` resolves known Electron apps from the built-in
registry and uses the app's assigned debug port. If the endpoint is not already
listening, Uni-CLI launches the app with `--remote-debugging-port=<port>`,
reprobes CDP, and then reuses that renderer for `compute eval`, snapshot, click,
type, press, and scroll actions. App-based attach also persists the last CDP
session under the Uni-CLI compute state directory so a later `compute eval` from
a separate process can reconnect to the same renderer.

Some apps are marked as unsafe to relaunch automatically because restarting them
can interrupt signed-in workspace state. For those apps, attach refuses before
launching and returns a structured error; rerun with `--confirm-relaunch` only
when relaunching the app is acceptable.

See [Electron App Control](electron.md) for app caveats and registry guidance.

## Fallback Semantics

The cascade stops on the first successful transport result. Failed transports
are accumulated into one error envelope only when every candidate fails. This
keeps normal operation low-latency while preserving enough evidence for
`unicli doctor compute` and repair workflows.
