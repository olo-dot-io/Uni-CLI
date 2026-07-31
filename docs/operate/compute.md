# Compute

`unicli compute` is the local computer-control surface. Each request is
planned against its task evidence and exact target, then dispatched through one
provider. macOS uses AX for native-window work, Windows uses UIA, Linux uses
AT-SPI, exact browser targets use CDP, and app launch uses a process provider.
Desktop-coordinate control requires an explicit `--via driver` or
`--via visual` route.

Read [Task-Directed Capability Routing](task-routing.md) for the operator model,
selection algorithm, complexity, and recovery state graph. Inspect any compute
selection without acting on the host:

```bash
unicli -f json compute route snapshot --params '{"app":"Calculator"}'
unicli -f json compute route click --params '{"port":9222,"selector":"#submit"}'
unicli -f json compute route screenshot --params '{}' --via visual
unicli -f json compute route point-click \
  --params '{"x":640,"y":480,"observation":"visual-observation:<opaque>"}' \
  --via driver
```

## Snapshot, Find, Click

```bash
unicli compute snapshot --app Calculator --format compact
unicli compute find --role button --name 5
unicli compute find --role input --text 8 --first
unicli compute click @e7
```

Snapshots return compact element refs such as `@e7`. The transport bus keeps
the latest bucket for each exact target scope. A short alias resolves directly
only when one live scope owns it; where a command accepts `windowId` or a CDP
endpoint, that exact hint can disambiguate duplicate aliases, otherwise use the
stable ref included in provenance. Successful snapshots persist only ref
buckets carrying immutable native window identity or an explicit CDP renderer
endpoint. A later CLI process can reuse those exact refs. Broker-owned,
invocation-only CDP refs stay turn-scoped and create no empty persistence
record. When a structured transport reports bounds, the refs preserve
screen-relative coordinates and `screenIndex` so follow-up actions can target
the same monitor in multi-display setups.
When a snapshot node includes a visible/current value, compact output and stored
refs preserve it, and `compute find --text <text>` can match that value. This is
useful for calculator displays, address fields, editors, and status labels
whose value is not part of the accessible name.

## Explicit Coordinate and OS Driver Operations

Semantic and coordinate operations have different public contracts:

- `compute click/type/scroll` consume a ref owned by AX, UIA, AT-SPI, or CDP.
- `compute point-click/drag/point-scroll/move-cursor` consume fresh,
  provider-owned pixels through an opaque observation ref. They never accept
  or synthesize an element ref.
- `compute text` sends text through an explicitly selected foreground provider
  but does not consume coordinates.
- `--via driver` selects the optional Cua Driver service.
- `--via visual` selects the configured visual backend.

No ordinary provider failure changes that selection. A missing Cua Driver
binary, unavailable daemon, permission refusal, schema mismatch, or failed
verification returns directly as a structured `cua-driver` error.

```bash
unicli doctor compute --providers --json
unicli -f json compute screenshot --via driver
unicli compute point-click 640 480 --button left \
  --observation 'visual-observation:<opaque>' --via driver
unicli compute drag 640 480 840 480 \
  --observation 'visual-observation:<opaque>' --via driver
unicli compute text "hello" --via driver
unicli compute point-scroll 640 480 --direction down --amount 3 --by line \
  --observation 'visual-observation:<opaque>' --via driver
```

For an executable two-step flow, read `.data.observation.ref` from the JSON
screenshot envelope and pass it to exactly one coordinate action:

```bash
OBSERVATION="$(
  unicli -f json compute screenshot --via driver |
    jq -r '.data.observation.ref'
)"
unicli compute point-click 640 480 \
  --observation "$OBSERVATION" --via driver
```

Inline driver or visual screenshots issue a random 256-bit ref whose
authoritative record is owner-only local state. The ref expires after 30
seconds, is atomically single-use across processes, and binds provider,
desktop scope, optional session, pixel dimensions, action dimensions, and
pixel hash. Actions reject forged, missing, expired, replayed,
cross-provider, cross-session, and out-of-bounds refs before opening the
provider. Retina and other scaled captures use the recorded width ratio to
map screenshot pixels to action coordinates. Saving a screenshot directly to
a path produces an artifact and no coordinate authority.

The evidence contract prevents stale capability reuse inside Uni-CLI. It
cannot detect an external human or unrelated process changing the screen after
capture; agents must keep the observe-act interval short and take a new
screenshot whenever the visible target may have changed.

The built-in adapter targets Cua Driver portable contract `0.2.0`. It invokes
`cua-driver call <tool> <json>` with argv, never through a shell. Uni-CLI does
not install or start the daemon and does not inherit its app/window-specific
APIs under the coordinate route. The portable `click`, `drag`, `type_text`,
`press_key`/`hotkey`, and `scroll` calls are always compiled with
`scope:"desktop"`. `get_desktop_state` is the pixel source. This boundary
follows the upstream
[portable manifest](https://github.com/trycua/cua/blob/7e13c6437acb1e2193548d36f520b3519ceee05c/libs/cua-driver/contract/manifest.json).

A named session gives concurrent agent runs separate cursor and capture-policy
identity:

```bash
unicli compute session-start research-run-1 --capture-scope auto
unicli compute session-state research-run-1
unicli compute session-escalate research-run-1 \
  --reason ax_tree_pixel_mismatch \
  --detail "window-scoped action was checked and remained ineffective"
unicli compute session-end research-run-1
```

`auto` begins window-scoped. Desktop escalation is a separate, one-way command
with a bounded reason. Session operations explicitly name the driver lifecycle,
so they select `cua-driver` without presenting an unrelated provider list.
Ending a session releases its cursor, recording, and per-session state.

When Cua Driver returns `verified:true` or `effect:"confirmed"`, Uni-CLI emits
a `confirmed` `effect_verdict` backed by provider postcondition observation.
`verified:false` alone remains `unverifiable`: it means delivery completed
without read-back proof. Only `effect:"suspected_noop"` becomes
`suspected_noop`. A dispatch receipt is never upgraded by inference.

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

The command plans `compute snapshot` and `compute screenshot` independently
against the same bound target. Each part selects one provider before execution;
a failure in one part never changes that part's provider. The packet succeeds
when at least one requested part is captured and records a structured per-part
error when the other part is unavailable.
When screenshot bytes are available, the screenshot part includes `image`
metadata with byte count, SHA-256, dimensions, and an image-pixel coordinate
space whose origin is the top-left corner. When a native transport also reports
logical screen bounds, `image.coordinate_space.native_screen_to_image` carries
those bounds plus the explicit six-value affine transform from screen-logical
coordinates into image pixels; consumers must not infer display scale or crop
offset. Packets also include a replayable
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
action through the already selected provider. This keeps the rendered pointer
target and the actual action target on the same enriched request.

Successful JSON output includes both legacy `visual_timeline` and the richer
`visual_action` record:

- `visual_action.target`: resolved ref or coordinate target in screen pixels.
- `visual_action.pointer_plan`: sampled path used by the HUD and docs replay.
- `visual_action.overlay`: native HUD provider status such as
  `macos-appkit/arrived`.
- `visual_action.dispatch`: transport, status, and target used for the real
  click/type/scroll action.
- `visual_action.post_capture`: same-provider screenshot metadata captured
  after an overlay action and after every successful MCP visual-coordinate
  action. MCP image bytes appear once as standard `ImageContent`; structured
  content retains dimensions, SHA-256, the next single-use observation ref,
  and exact encoded-frame change evidence.

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

| Command                                                | Purpose                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `compute route <operation> --params <json>`            | Explain one provider selection without opening it                        |
| `compute apps`                                         | List running apps                                                        |
| `compute windows --app <name>`                         | List windows                                                             |
| `compute snapshot --app <name> --format compact`       | Capture a compact/tree/json accessibility snapshot                       |
| `compute capture --app <name>`                         | Capture snapshot refs and screenshot evidence                            |
| `compute capture --copy-reference`                     | Save and copy `[app-shots ...]` handoff markup                           |
| `compute find --role <role> --name/--text <text>`      | Find matching refs by label or value                                     |
| `compute click <ref> --background`                     | Click a ref while explicitly preserving background mode                  |
| `compute point-click <x> <y> --observation <ref>`      | Click one observed point through the observation's explicit provider     |
| `compute drag <x1> <y1> <x2> <y2> --observation <ref>` | Drag between two points from one fresh observation                       |
| `compute type <ref> <text>`                            | Set or type text                                                         |
| `compute text <text> --via driver`                     | Send text to the foreground desktop without claiming an element ref      |
| `compute press <combo>`                                | Send a key combo                                                         |
| `compute scroll <ref>`                                 | Scroll a ref                                                             |
| `compute point-scroll <x> <y> --observation <ref>`     | Scroll at a point from one fresh driver observation                      |
| `compute launch <app>`                                 | Launch an app                                                            |
| `compute screenshot [path]`                            | Capture a screenshot                                                     |
| `compute session-start/state/escalate/end`             | Control explicit Cua Driver session lifecycle                            |
| `compute attach --app <name>`                          | Attach CDP to a renderer                                                 |
| `compute attach --app <name> --confirm-relaunch`       | Allow risky app relaunch for CDP attach                                  |
| `compute eval <js>`                                    | Evaluate JS in an attached renderer                                      |
| `compute wait --ref <ref>`                             | Poll one exact target for appear/disappear/focused/enabled/checked state |
| `compute observe <goal> --app <name> --top-k <n>`      | Rank up to 1-50 refs for a natural-language goal                         |
| `compute assert --text <text> --state visible`         | Assert text or enabled/focused/checked/visible state                     |

## Output

All commands use the normal Uni-CLI v2 envelope. Success writes to stdout; a
failed route writes a structured error to stderr with the selected provider
details and exits with the provider error code.

Every envelope also carries `meta.effect_verdict`. Read-only compute operations
use `not_applicable`. Mutations without an authoritative postcondition use
`unverifiable`, even when the provider reports successful dispatch. A native
provider can return `confirmed` only with a fresh accessibility-state
observation or another declared authoritative channel. Pre-dispatch route,
target, and permission rejection uses `suspected_noop`. Agents inspect an
`unverifiable` mutation against the same bound ref, window, or renderer before
replay.

An MCP visual-coordinate mutation captures its next frame through the provider
that performed the action. `encoded_frame_change.status=unchanged` proves that
the two encoded frames are byte-identical. `changed` only reports new pixel
evidence; neither value upgrades the action's effect verdict without an
authoritative task postcondition. A failed post-capture remains explicit under
`post_action_capture.error` and never causes a provider switch or rewrites an
already settled action result.

`compute launch <app>` is a process operation. It uses `open -a` on macOS,
`Start-Process` through PowerShell on Windows, and `gtk-launch` on Linux. When
`--debug-port <port>` is supplied, Uni-CLI passes
`--remote-debugging-port=<port>` to the launched app for a later explicit CDP
attach. A process-provider failure returns directly; native accessibility and
visual providers are not tried.

```bash
unicli compute snapshot --app TextEdit -f json
```

Failures include a `minimum_capability` key and may include a structured
`remedy` with a command or deeplink. See
[Compute Troubleshooting](troubleshooting.md) for the remedy catalog.

Refs are target-bound capabilities, not reusable selectors. Native refs encode
the exact OS window id (`desktop-ax:window-…`, `desktop-uia:window-…`, or
`desktop-atspi:window-…`) and CDP refs retain the exact renderer WebSocket.
Legacy refs without this identity fail closed and require a fresh snapshot.
`compute wait` takes a fresh snapshot of that same immutable target on every
observation; elapsed time or a different foreground window cannot satisfy it.

## Live Smoke

The read-only five-category smoke exercises one real structured adapter, native
CLI bridge, hidden semantic browser target, native accessibility read, and the
optional coordinate driver:

```bash
npm run smoke:capabilities
```

It reports `skip` only when an optional executable is absent. An installed
provider that fails its declared contract is a failure. The browser case serves
a local fixture and reads its DOM/accessibility state; it does not substitute a
doctor probe for execution.

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

`doctor compute --providers` adds a dedicated Cua Driver contract/daemon probe
plus non-blocking discovery checks for optional local computer-use provider
commands and configured visual-model backends. These checks are reported as
`ok`, `warn`, or `skip` and do not make the base doctor fail. Set
`UNICLI_CUA_DRIVER_COMMAND` to override the binary and
`UNICLI_CUA_DRIVER_ARGS` to a JSON argv array, for example
`["--socket","/path/to/socket"]`. Set `UNICLI_COMPUTE_PROVIDER_COMMAND` or the
platform-specific
`UNICLI_<PLATFORM>_COMPUTE_PROVIDER_COMMAND` environment variable when you want
Uni-CLI to probe an installed provider.

```bash
unicli doctor compute --providers
```

## Focus Stealing

Actuating commands prefer background mode: `compute click`, `compute type`,
`compute press`, and `compute scroll` pass `focus: false` to semantic providers
unless `--focus` is set. Explicit driver and visual routes are desktop-scoped
foreground capabilities.

On macOS, desktop-ax performs semantic `AXPress`, `AXValue`, focus, and AX scroll
actions without activating the app when the target supports them. A semantic
failure returns directly. It does not enter coordinate click, `CGEvent`, or
background keyboard injection under the accessibility route label. Those
primitives have different target and replay semantics and therefore require a
new explicit route.

See [Compute Focus Behavior](focus-behavior.md) for the transport matrix and
source links.

Windows UIA uses native top-level inventory and live descendant traversal where
available. Refs emitted from Windows snapshot/find can target `compute type`,
`compute scroll`, `compute screenshot`, `compute wait`, and `compute assert`.
Wait/assert use role/name/title/app/pid filters and descendant text/value/state
checks when the UIA tree exposes them. `compute observe` ranks top-level and
descendant refs by goal/title/name token overlap and marks scrollable
descendants with `action: "scroll"` and slider/spinner/range descendants with
`action: "set_value"`. Descendant invoke, value, focus, and scroll actions use
native UIA patterns. Invoke also tries toggle and selection item patterns for
controls such as
checkboxes, radio buttons, and selectable list rows, while numeric set-value
inputs can use RangeValuePattern for sliders and spinners.
Every emitted UIA ref is scoped by exact HWND rather than PID-local window
position, so window reordering cannot redirect a later action.
UIA sidecar launch support remains an internal sidecar primitive. The public
`compute launch` contract selects the process provider.

Linux AT-SPI uses `wmctrl -lG -p` where available and uses AT-SPI-only top-level
registry roots when `wmctrl` is missing or empty. Refs emitted from
Linux snapshot/find can target `compute click`, `compute type`, `compute
scroll`, `compute screenshot`, `compute wait`, `compute observe`, and
`compute assert`. Descendant click/type/focus use native AT-SPI
Action/Value/EditableText/Component proxies; descendant scroll uses
`Component.scroll_to(...)`.
`compute observe` marks scrollable descendants with
`action: "scroll"` and slider/spin-button/range descendants with
`action: "set_value"`. Descendant screenshots capture the element rectangle
when bounds are known. Top-level X11 screenshots use `import -window <id>` when
a real window id exists, and Wayland/top-level bounds use `grim -g` when bounds
are known.
AT-SPI sidecar launch support remains an internal sidecar primitive. The public
`compute launch` contract selects the process provider.
Every emitted AT-SPI ref is scoped by the exact native X11/AT-SPI window id;
PID-local window indexes are no longer accepted as durable identity.

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

## Recovery Semantics

One request opens one selected provider. A normal provider failure returns that
provider's structured envelope. A safe retry repeats the same provider; repair
restores that provider; replanning chooses a new route from new target evidence;
and visual escalation requires an explicit route. Ambiguous mutations are
inspected against the exact target before any replay.

Read-only observations can declare one automatic same-primitive retry. The
provider may retire a stale CDP page, native sidecar generation, or AX warm
session first, but the route and physical primitive stay fixed. Mutating actions
never retry automatically. `meta.recovery_trace` reports the selected policy,
attempt count, failures, provider, and physical action so an agent can
distinguish a first-attempt result from a recovered read.

`route_unavailable` means the operation, target, platform, and requested route
have no declared intersection. `provider_unavailable` means selection succeeded
and the chosen provider failed to open or dispatch. Use `compute route` to
inspect the former and `doctor compute` to diagnose the latter.
